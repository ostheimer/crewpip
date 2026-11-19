import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appliedMigrations, backupDb, migrate, openDb, pendingMigrations, schemaVersion } from "../src/db.js";
import { MIGRATIONS } from "../src/migrations.js";

function tmpDb(name = "crewpip.db"): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-db-")), name);
}

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]).map((r) => r.name).sort();
const cols = (db: DatabaseSync, t: string) =>
  new Set((db.prepare(`PRAGMA table_info(${t})`).all() as unknown as { name: string }[]).map((c) => c.name));

test("Eine frische Datenbank bekommt alle Umzüge und merkt sie sich", () => {
  const p = tmpDb();
  const db = openDb(p);
  assert.deepEqual(appliedMigrations(db).map((m) => m.id), MIGRATIONS.map((m) => m.id));
  assert.deepEqual(pendingMigrations(db), []);
  assert.equal(schemaVersion(db), MIGRATIONS[MIGRATIONS.length - 1]!.id);
  for (const t of ["projects", "tasks", "runs", "sessions", "messages", "deliveries", "schema_migrations"]) {
    assert.ok(tables(db).includes(t), `Tabelle ${t} fehlt`);
  }
  // Bei einer frischen Datenbank gibt es nichts zu sichern.
  assert.ok(!fs.existsSync(path.join(path.dirname(p), "backups")) || fs.readdirSync(path.join(path.dirname(p), "backups")).length <= 1);
});

test("Ein zweiter Start wendet nichts erneut an", () => {
  const p = tmpDb();
  openDb(p).close();
  const db = openDb(p);
  const report = migrate(db, p);
  assert.deepEqual(report.applied, []);
  assert.equal(report.backup, null, "ohne offene Umzüge wird auch nicht gesichert");
  assert.deepEqual(appliedMigrations(db).map((m) => m.id), MIGRATIONS.map((m) => m.id));
});

test("Eine Datenbank von vor den Umzügen wird übernommen, ohne Daten zu verlieren", () => {
  const p = tmpDb();
  // Stand 0.2.0 nachbauen: alte Spaltenmenge, kein Verzeichnis der Umzüge.
  const old = new DatabaseSync(p);
  old.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, app TEXT NOT NULL, project TEXT NOT NULL, cwd TEXT NOT NULL,
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', socket_path TEXT, socket_token TEXT,
      stop_continuations INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ended_at TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_kind TEXT NOT NULL, from_id TEXT NOT NULL,
      from_app TEXT, from_project TEXT, from_name TEXT NOT NULL, to_target TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  `);
  old.prepare("INSERT INTO sessions(id, app, project, cwd, name) VALUES ('alt','claude','demo-project','/p/demo-project','wichtig')").run();
  old.prepare("INSERT INTO messages(from_kind, from_id, from_name, to_target, text) VALUES ('human','Mensch','Mensch','all','nicht verlieren')").run();
  old.close();

  const db = openDb(p);
  assert.deepEqual(appliedMigrations(db).map((m) => m.id), MIGRATIONS.map((m) => m.id));
  assert.ok(cols(db, "sessions").has("project_id"), "fehlende Spalten werden nachgerüstet");
  assert.ok(cols(db, "sessions").has("worktree"));
  assert.ok(cols(db, "messages").has("from_worktree"));
  assert.equal((db.prepare("SELECT name FROM sessions WHERE id = 'alt'").get() as { name: string }).name, "wichtig");
  assert.equal((db.prepare("SELECT text FROM messages WHERE id = 1").get() as { text: string }).text, "nicht verlieren");
  assert.ok(tables(db).includes("tasks"), "neue Tabellen kommen dazu");

  const backups = fs.readdirSync(path.join(path.dirname(p), "backups"));
  assert.equal(backups.length, 1, "vor dem Umzug wird gesichert");
  const saved = new DatabaseSync(path.join(path.dirname(p), "backups", backups[0]!));
  assert.equal((saved.prepare("SELECT name FROM sessions WHERE id = 'alt'").get() as { name: string }).name, "wichtig");
  assert.ok(!tables(saved).includes("tasks"), "die Sicherung zeigt den Stand von vorher");
});

test("Ein fehlgeschlagener Umzug lässt die Datenbank unverändert und wird nicht eingetragen", () => {
  const p = tmpDb();
  openDb(p).close();
  const db = new DatabaseSync(p);
  const kaputt = { id: "9999-kaputt", title: "geht schief", up: (d: DatabaseSync) => {
    d.exec("CREATE TABLE zwischenstand (x)");
    d.exec("DAS IST KEIN SQL");
  } };
  MIGRATIONS.push(kaputt);
  try {
    assert.throws(() => migrate(db, p), /9999-kaputt fehlgeschlagen/);
    assert.ok(!tables(db).includes("zwischenstand"), "die halbfertige Tabelle wird zurückgenommen");
    assert.ok(!appliedMigrations(db).some((m) => m.id === "9999-kaputt"));
    assert.deepEqual(appliedMigrations(db).map((m) => m.id), MIGRATIONS.filter((m) => m.id !== "9999-kaputt").map((m) => m.id));
  } finally {
    MIGRATIONS.pop();
  }
});

test("Ohne mögliche Sicherung wird gar nicht erst umgezogen", () => {
  const p = tmpDb();
  const db = new DatabaseSync(p);
  db.exec("CREATE TABLE alt (x)");
  // Ein Verzeichnis, in das nicht geschrieben werden kann, verhindert die Sicherung.
  const dir = path.join(path.dirname(p), "backups");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => migrate(db, p), /Sicherung fehlgeschlagen, Umzug abgebrochen/);
    assert.deepEqual(appliedMigrations(db), []);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("Sicherungen werden rotiert", () => {
  const p = tmpDb();
  const db = openDb(p);
  db.exec("CREATE TABLE inhalt (x)");
  for (let i = 0; i < 5; i++) backupDb(db, p, 3);
  const files = fs.readdirSync(path.join(path.dirname(p), "backups")).filter((f) => f.endsWith(".db"));
  assert.equal(files.length, 3, "nur die jüngsten bleiben liegen");
});

test("Umzugskennungen sind eindeutig und sortiert", () => {
  const ids = MIGRATIONS.map((m) => m.id);
  assert.deepEqual(ids, [...new Set(ids)], "keine doppelten Kennungen");
  assert.deepEqual(ids, [...ids].sort(), "die Reihenfolge ergibt sich aus der Kennung");
});
