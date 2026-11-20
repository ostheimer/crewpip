import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** Aufsteigend sortierbar; einmal vergeben, nie wieder ändern. */
  id: string;
  /** Kurz, für die Ausgabe. */
  title: string;
  up(db: DatabaseSync): void;
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name));
}

/**
 * Umzüge werden der Reihe nach angewandt und in `schema_migrations` festgehalten. Jeder läuft
 * in einer eigenen Transaktion; schlägt einer fehl, bleibt die Datenbank auf dem Stand davor.
 *
 * Der erste Eintrag ist bewusst wiederholbar geschrieben (IF NOT EXISTS, geprüfte Spalten).
 * Er ist der gemeinsame Ausgangspunkt für frische Datenbanken und für die, die schon vor
 * Einführung der Umzüge entstanden sind. Ab dem zweiten Eintrag schützt das Verzeichnis vor
 * doppelter Anwendung, dort ist diese Vorsicht nicht mehr nötig.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: "0001-grundschema",
    title: "Projekte, Aufgaben, Läufe, Sessions, Nachrichten, Zustellungen",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          archived_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          assignee_session_id TEXT REFERENCES sessions(id),
          worktree_path TEXT,
          worktree_branch TEXT,
          worktree_created_at TEXT,
          created_by TEXT NOT NULL DEFAULT 'unbekannt',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, status);
        CREATE UNIQUE INDEX IF NOT EXISTS tasks_worktree_idx ON tasks(worktree_path) WHERE worktree_path IS NOT NULL;

        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER REFERENCES tasks(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          app TEXT NOT NULL,
          cwd TEXT NOT NULL,
          prompt TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          pid INTEGER,
          exit_code INTEGER,
          log_path TEXT NOT NULL,
          summary TEXT,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id, id);

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          app TEXT NOT NULL,
          project TEXT NOT NULL,
          worktree TEXT,
          cwd TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle',
          name_source TEXT NOT NULL DEFAULT 'auto',
          project_id TEXT,
          pid INTEGER,
          socket_path TEXT,
          socket_token TEXT,
          stop_continuations INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS sessions_cwd_idx ON sessions(app, cwd, ended_at);

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_kind TEXT NOT NULL,
          from_id TEXT NOT NULL,
          from_app TEXT,
          from_project TEXT,
          from_worktree TEXT,
          from_name TEXT NOT NULL,
          to_target TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS messages_target_idx ON messages(to_target, id);

        CREATE TABLE IF NOT EXISTS deliveries (
          message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          method TEXT NOT NULL,
          at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (message_id, session_id)
        );
      `);
      // Datenbanken aus 0.1.0 und 0.2.0 kennen diese Spalten noch nicht.
      const s = columns(db, "sessions");
      if (!s.has("name_source")) db.exec("ALTER TABLE sessions ADD COLUMN name_source TEXT NOT NULL DEFAULT 'auto'");
      if (!s.has("pid")) db.exec("ALTER TABLE sessions ADD COLUMN pid INTEGER");
      if (!s.has("worktree")) db.exec("ALTER TABLE sessions ADD COLUMN worktree TEXT");
      if (!s.has("project_id")) db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT");
      if (!columns(db, "messages").has("from_worktree")) db.exec("ALTER TABLE messages ADD COLUMN from_worktree TEXT");
    },
  },
  {
    id: "0002-indizes",
    title: "Indizes für Sessions je Projekt, laufende Läufe und Zustellungen",
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions(project_id, ended_at);
        CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
        CREATE INDEX IF NOT EXISTS deliveries_session_idx ON deliveries(session_id, message_id);
      `);
    },
  },
  {
    id: "0003-rollen",
    title: "Rolle je Session, abgeleitet aus den bisherigen Namen",
    up: (db) => {
      db.exec("ALTER TABLE sessions ADD COLUMN role TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS sessions_role_idx ON sessions(role, project_id, ended_at)");
      // Die Namenskonvention aus docs/rollen.md ist schon in Gebrauch; sie wird übernommen,
      // damit bestehende Sitzungen ihre Rolle nicht von Hand nachgetragen bekommen.
      db.exec(`
        UPDATE sessions SET role = 'director' WHERE name LIKE 'Director%';
        UPDATE sessions SET role = 'pm'       WHERE role IS NULL AND name LIKE 'PM %';
        UPDATE sessions SET role = 'worker'   WHERE role IS NULL AND name LIKE 'Worker %';
      `);
    },
  },
  {
    id: "0004-lauf-herkunft",
    title: "Wer einen Lauf gestartet hat, und welche Session aus einem Lauf stammt",
    up: (db) => {
      db.exec("ALTER TABLE runs ADD COLUMN started_by_session_id TEXT");
      db.exec("ALTER TABLE sessions ADD COLUMN spawned_by_run INTEGER");
      db.exec("CREATE INDEX IF NOT EXISTS runs_starter_idx ON runs(started_by_session_id, started_at)");
    },
  },
  {
    id: "0005-socket-token-zuruecksetzen",
    title: "Veraltete Socket-Token verwerfen; sie kommen beim nächsten Hook zurück",
    up: (db) => {
      // Für vorhandene Zeilen lässt sich nicht mehr feststellen, ob das Token zum aktuellen
      // Prozess gehört. Ein falsches Token verwirft Claude Code stillschweigend, deshalb ist
      // "kein Token" die sichere Annahme: dann greifen die Hooks.
      db.exec("UPDATE sessions SET socket_token = NULL WHERE socket_token IS NOT NULL");
    },
  },
  {
    id: "0006-socket-spalten-entfernen",
    title: "Socket-Pfad und -Token aus den Sessions entfernen",
    up: (db) => {
      // Der Push-Weg ist entfallen: Claude Code hält Nachrichten von fremden Prozessen
      // zurück, die Zustellung läuft über die Hooks. Damit gibt es keinen Grund mehr, den
      // Messaging-Token einer fremden Sitzung überhaupt zu speichern.
      const cols = new Set((db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name: string }[]).map((c) => c.name));
      if (cols.has("socket_token")) db.exec("ALTER TABLE sessions DROP COLUMN socket_token");
      if (cols.has("socket_path")) db.exec("ALTER TABLE sessions DROP COLUMN socket_path");
    },
  },
  {
    id: "0007-projekt-bootstrap",
    title: "Bootstrap-Befehl je Projekt und sein Protokoll am Task",
    up: (db) => {
      db.exec("ALTER TABLE projects ADD COLUMN bootstrap TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN bootstrap_log TEXT");
    },
  },
  {
    id: "0008-lauf-push",
    title: "Ergebnis des Pushs, den CrewPip nach einem schreibenden Lauf ausführt",
    up: (db) => {
      db.exec("ALTER TABLE runs ADD COLUMN push_log TEXT");
    },
  },
  {
    id: "0009-prozesskette",
    title: "Prozesse über dem Hook je Session, damit MCP-Aufrufe am Prozess statt am Verzeichnis erkannt werden",
    up: (db) => {
      db.exec("ALTER TABLE sessions ADD COLUMN proc_chain TEXT");
    },
  },
  {
    id: "0010-sitzungsschluessel",
    title: "Sitzungsschlüssel je Session: unterscheidet Threads, die sich einen Prozess teilen",
    up: (db) => {
      db.exec("ALTER TABLE sessions ADD COLUMN mcp_key TEXT");
      db.exec("CREATE UNIQUE INDEX idx_sessions_mcp_key ON sessions(mcp_key) WHERE mcp_key IS NOT NULL");
    },
  },
  {
    id: "0011-rollenwechsel",
    title: "Protokoll der Rollenwechsel und zuletzt ausgewerteter Name je Session (#28)",
    up: (db) => {
      // role_claim: der wirksame Anzeigename, aus dem zuletzt eine Rolle abgeleitet wurde.
      // Bestehende Rollen bleiben unverändert; NULL heißt nur „noch nicht ausgewertet“.
      db.exec("ALTER TABLE sessions ADD COLUMN role_claim TEXT");
      db.exec(`CREATE TABLE role_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        project_id TEXT,
        from_session TEXT,
        to_session TEXT,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    },
  },
];
