/** Gemeinsame Typen für Daemon, Hook-Skript und Web-UI. */

export type AppKind = "claude" | "cursor" | "codex" | "antigravity" | "other";

export const APP_LABELS: Record<AppKind, string> = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  antigravity: "Antigravity",
  other: "App",
};

export const HOOK_EVENTS = ["session-start", "prompt", "stop", "session-end", "turn-complete"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type SessionStatus = "idle" | "working" | "ended";

/**
 * Ist ein Chat jetzt tatsächlich mit CrewPip verbunden? Regel in docs/verbindung.md:
 * - "connected": nicht beendet, der Hook hat sich gemeldet und der Agent-Prozess lebt.
 *   Ruhe (idle, alter letzter Kontakt) ändert daran nichts.
 * - "no-hook": eingetragen (Registry oder MCP-Aufruf), aber nie über den Hook gemeldet;
 *   Post erreicht ihn nicht von selbst.
 * - "stale": der Agent-Prozess läuft nicht mehr, der Eintrag ist liegen geblieben.
 * - "ended": ausgetragen.
 */
export const CONNECTION_STATES = ["connected", "no-hook", "stale", "ended"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const SESSION_ROLES = ["director", "pm", "worker"] as const;
/** Rolle laut docs/rollen.md. null heißt: keine Rolle vergeben. */
export type SessionRole = (typeof SESSION_ROLES)[number];

export const ROLE_LABELS: Record<SessionRole, string> = {
  director: "Director",
  pm: "PM",
  worker: "Worker",
};

/**
 * Rolle aus dem Sitzungsnamen ableiten, damit die eingespielte Namenskonvention
 * ("Director", "PM outbig", "Worker CrewPip") ohne Zusatzaufwand weiter funktioniert.
 */
export function roleFromName(name: string): SessionRole | null {
  const n = name.trim();
  if (/^director\b/i.test(n)) return "director";
  if (/^pm\b/i.test(n)) return "pm";
  if (/^worker\b/i.test(n)) return "worker";
  return null;
}

export const RUN_MODES = ["read-only", "worktree-write"] as const;
/** Was ein von CrewPip gestarteter Agent darf. Mehr als diese zwei Stufen gibt es bewusst nicht. */
export type RunMode = (typeof RUN_MODES)[number];

export const RUN_MODE_LABELS: Record<RunMode, string> = {
  "read-only": "nur lesen",
  "worktree-write": "im Worktree schreiben",
};

export const RUN_STATUSES = ["running", "done", "failed", "stopped", "timeout"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "läuft",
  done: "fertig",
  failed: "fehlgeschlagen",
  stopped: "abgebrochen",
  timeout: "Zeit abgelaufen",
};

/** Eine Zeile aus dem Ablauf eines Laufs, für die Anzeige aufbereitet. */
export interface RunItem {
  kind: "message" | "command" | "tool" | "error";
  text: string;
  at: string;
}

export interface Run {
  id: number;
  taskId: number | null;
  /** Session, die den Lauf angestoßen hat; null heißt: aus der Oberfläche gestartet. */
  startedBy: { id: string; label: string } | null;
  taskTitle: string | null;
  projectId: string;
  app: AppKind;
  cwd: string;
  prompt: string;
  mode: RunMode;
  status: RunStatus;
  exitCode: number | null;
  /** Letzte Antwort des Agents */
  summary: string | null;
  /** Ergebnis des Pushs durch CrewPip nach einem schreibenden Lauf; null heißt: keiner. */
  pushLog: string | null;
  startedAt: string;
  endedAt: string | null;
}

export const TASK_STATUSES = ["open", "claimed", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: "offen",
  claimed: "in Arbeit",
  review: "zu prüfen",
  done: "erledigt",
  cancelled: "verworfen",
};

/** Ein Repository, in dem gearbeitet wird. Wurzel ist das Haupt-Repository, nie ein Worktree. */
export interface Project {
  /** Nativer Projektname. name bleibt die unveränderte CrewPip-Adresse. */
  displayName?: string;
  /** Einzelne native Chats in einem Arbeitsordner ohne eigenes App-Projekt. */
  standaloneChats?: { id: string; name: string; app: AppKind }[];
  id: string;
  name: string;
  root: string;
  createdAt: string;
  archivedAt: string | null;
  sessions: number;
  openTasks: number;
  /**
   * Befehl, der nach dem Anlegen eines Worktrees darin ausgeführt wird, etwa
   * `pnpm install --frozen-lockfile`. Ein frischer Worktree hat kein node_modules; ohne das
   * läuft weder ein Test noch ein Git-Hook. Bewusst hier hinterlegt und nicht aus dem
   * Repository gelesen, damit CrewPip keinen Code ausführt, den das Repository mitbringt.
   */
  bootstrap: string | null;
}

/** Ein Arbeitsauftrag in einem Projekt. */
export interface Task {
  id: number;
  projectId: string;
  projectName: string;
  title: string;
  body: string;
  status: TaskStatus;
  /** Session, die den Task übernommen hat */
  assignee: { id: string; label: string } | null;
  /** Von CrewPip angelegter Worktree */
  worktree: { path: string; branch: string; createdAt: string } | null;
  /** Ausgabe des Bootstrap-Befehls; null heißt: keiner hinterlegt oder noch nicht gelaufen. */
  bootstrapLog: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Ein Chat-Fenster in einer App: das eigentliche Subjekt in CrewPip. */
export interface Session {
  id: string;
  app: AppKind;
  /** Projekt, zu dem das Arbeitsverzeichnis gehört */
  projectId: string;
  /** Repository-Ordner, bei Worktrees das übergeordnete Projekt, z. B. "example.org" */
  project: string;
  /** Worktree-Name, wenn die Session in einem Claude-Worktree läuft */
  worktree: string | null;
  cwd: string;
  /** Frei vergebener Name; Standard ist die Startzeit */
  name: string;
  /** "Claude · example-project / api-worker" */
  label: string;
  status: SessionStatus;
  /** Verbindung zu CrewPip, siehe ConnectionState */
  connection: ConnectionState;
  startedAt: string;
  /** Letzter Kontakt über Hook oder MCP */
  lastSeenAt: string;
  endedAt: string | null;
  /** Nachrichten, die diese Session noch nicht gesehen hat */
  pending: number;
  /** Task, an dem diese Session laut Zuweisung oder Worktree arbeitet */
  task: { id: number; title: string; status: TaskStatus } | null;
  /** Rolle laut docs/rollen.md */
  role: SessionRole | null;
  /** Nummer des Laufs, aus dem diese Session stammt. Solche Sessions dürfen keine Läufe starten. */
  spawnedByRun: number | null;
}

/** Absender einer Nachricht. */
export type Party =
  | { kind: "session"; id: string; app: AppKind; project: string; worktree: string | null; name: string; label: string; role: SessionRole | null }
  | { kind: "human"; name: string; label: string };

/**
 * Empfänger einer Nachricht. Gespeichert als "session:<id>", "project:<name>", "app:<app>",
 * "pm:<projekt>", "director", "all" oder "human:<name>".
 *
 * "pm:" und "director" werden erst bei der Zustellung aufgelöst: Eine Nachricht an den PM
 * eines Projekts wartet, bis es dort einen gibt, und überlebt damit dessen Neustart.
 */
export type Target =
  | { kind: "session"; id: string }
  | { kind: "project"; name: string }
  | { kind: "app"; app: AppKind }
  | { kind: "pm"; project: string }
  | { kind: "director" }
  | { kind: "all" }
  | { kind: "human"; name: string };

export type DeliveryMethod = "push" | "hook-start" | "hook-prompt" | "hook-stop" | "mcp-read" | "mcp-wait";

export const DELIVERY_LABELS: Record<DeliveryMethod, string> = {
  // "push" entsteht nicht mehr; alte Einträge bleiben lesbar. Zustellung war damals unbestätigt.
  push: "über den Socket (unbestätigt)",
  "hook-start": "beim Sitzungsstart",
  "hook-prompt": "beim Prompt",
  "hook-stop": "am Turn-Ende",
  "mcp-read": "selbst gelesen",
  "mcp-wait": "beim Warten",
};

export interface Delivery {
  sessionId: string;
  sessionLabel: string;
  method: DeliveryMethod;
  at: string;
}

/** Ende eines Nachrichtenwegs: ein Chat (auch ein inzwischen beendeter). */
export interface FlowSession {
  id: string;
  app: AppKind;
  projectId: string;
  project: string;
  name: string;
  label: string;
}

/**
 * Tatsächlich zugestellte Nachrichten von einem Absender an einen Chat in einem Zeitfenster.
 * Grundlage sind Zustellungen: Rollenadressen gelten für den Chat, der abgeholt hat.
 * Bewusst ohne Inhalte.
 */
export interface MessageFlow {
  from: ({ kind: "session" } & FlowSession) | { kind: "human"; name: string };
  to: FlowSession;
  count: number;
  lastAt: string;
}

export interface Message {
  id: number;
  from: Party;
  to: Target;
  toLabel: string;
  /** Adresse, mit der ein Empfänger antworten kann, z. B. "session:abc" oder "human:Alex" */
  replyTo: string;
  text: string;
  createdAt: string;
  deliveries: Delivery[];
  /** Labels aktiver Sessions, die die Nachricht noch nicht gesehen haben */
  pending: string[];
}

/** Body, den das Hook-Skript an POST /hooks/:app/:event schickt. */
export interface HookRequest {
  app: AppKind;
  event: HookEvent;
  sessionId: string | null;
  cwd: string | null;
  /** Optionaler Session-Name aus CREWPIP_SESSION_NAME */
  name?: string | null;
  /** Nummer des Laufs aus CREWPIP_RUN, wenn CrewPip diese Session gestartet hat */
  runId?: number | null;
  /**
   * Nur Antigravity: false, wenn "prompt" ein weiterer Modellaufruf im selben Turn ist
   * (PreInvocation mit invocationNum > 0). Dann bleibt die Schleifensperre stehen und der
   * Sitzungsschlüssel wird nicht erneut eingespielt. Fehlt das Feld, ist jeder "prompt" ein
   * menschlicher Prompt.
   */
  turnStart?: boolean | null;
  payload?: unknown;
}

export interface HookResponse {
  session: { id: string; label: string } | null;
  messages: Message[];
  /** Nur bei "stop": false, wenn die Schleifensperre greift */
  mayContinue: boolean;
  /**
   * Sitzungsschlüssel dieses Chats, wenn CrewPip ihn braucht, um den Chat von anderen
   * Chats derselben App im gleichen Verzeichnis zu unterscheiden. Der Hook schreibt ihn in
   * den Kontext genau dieses Chats; er geht über keinen anderen Weg hinaus.
   */
  sessionKey?: string | null;
}

export type WsEvent =
  | { type: "message"; message: Message }
  | { type: "sessions"; sessions: Session[] }
  | { type: "delivery"; messageId: number; delivery: Delivery }
  | { type: "tasks"; tasks: Task[] }
  | { type: "projects"; projects: Project[] }
  | { type: "runs"; runs: Run[] }
  | { type: "run-item"; runId: number; item: RunItem };

// ---- Hilfsfunktionen für Ziele ---------------------------------------------

export function parseTarget(raw: string): Target {
  const s = raw.trim();
  if (s === "all" || s === "alle") return { kind: "all" };
  if (/^director$/i.test(s)) return { kind: "director" };
  const i = s.indexOf(":");
  if (i < 0) return { kind: "human", name: s };
  const kind = s.slice(0, i);
  const rest = s.slice(i + 1).trim();
  if (!rest) throw new Error(`Leeres Ziel: "${raw}"`);
  switch (kind) {
    case "session":
      return { kind: "session", id: rest };
    case "project":
      return { kind: "project", name: rest };
    case "app":
      if (!(rest in APP_LABELS)) throw new Error(`Unbekannte App: "${rest}"`);
      return { kind: "app", app: rest as AppKind };
    case "pm":
      return { kind: "pm", project: rest };
    case "human":
      return { kind: "human", name: rest };
    default:
      throw new Error(
        `Unbekanntes Ziel: "${raw}" (erlaubt: session:<id>, project:<name>, app:<claude|cursor|codex|antigravity>, pm:<projekt>, director, human:<name>, all)`,
      );
  }
}

export function formatTarget(t: Target): string {
  switch (t.kind) {
    case "all":
      return "all";
    case "session":
      return `session:${t.id}`;
    case "project":
      return `project:${t.name}`;
    case "app":
      return `app:${t.app}`;
    case "pm":
      return `pm:${t.project}`;
    case "director":
      return "director";
    case "human":
      return `human:${t.name}`;
  }
}

/**
 * Projekt und Worktree aus dem Arbeitsverzeichnis ableiten, ohne git aufzurufen. Nur als
 * Rückfalllösung: maßgeblich ist die Repository-Wurzel aus `git rev-parse --git-common-dir`.
 * Claude Code legt Worktrees unter <projekt>/.claude/worktrees/<name> an, CrewPip unter
 * <projekt>/.crewpip/worktrees/<name>.
 */
export function projectOf(cwd: string): { project: string; worktree: string | null } {
  const parts = cwd.split("/").filter(Boolean);
  const i = parts.lastIndexOf("worktrees");
  if (i > 1 && (parts[i - 1] === ".claude" || parts[i - 1] === ".crewpip") && i + 1 < parts.length) {
    return { project: parts[i - 2]!, worktree: parts.slice(i + 1).join("/") };
  }
  return { project: parts[parts.length - 1] ?? cwd, worktree: null };
}

/**
 * Wurzelverzeichnis des Projekts allein aus dem Pfad. Rückfall für den Fall, dass git nichts
 * sagt (Verzeichnis existiert nicht, kein Repository).
 */
export function projectRootOf(cwd: string): string {
  const parts = cwd.split("/");
  const i = parts.lastIndexOf("worktrees");
  if (i > 1 && (parts[i - 1] === ".claude" || parts[i - 1] === ".crewpip")) {
    return parts.slice(0, i - 1).join("/") || "/";
  }
  return cwd;
}

export function projectDisplay(project: string, worktree: string | null): string {
  return worktree ? `${project} (${worktree})` : project;
}

export function sessionLabel(app: AppKind, project: string, name: string, worktree: string | null = null): string {
  return `${APP_LABELS[app]} · ${projectDisplay(project, worktree)} / ${name}`;
}
