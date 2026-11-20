import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AppKind,
  type Delivery,
  type DeliveryMethod,
  type Message,
  type MessageFlow,
  type FlowSession,
  type Party,
  type ConnectionState,
  type Session,
  type SessionStatus,
  type SessionRole,
  type Target,
  APP_LABELS,
  roleFromName,
  formatTarget,
  parseTarget,
  sessionLabel,
} from "@crewpip/shared";
import type { RegistryEntry } from "./registry/claude.js";
import type { Proc } from "./peer.js";
import type { Board } from "./board.js";

export interface InboxEvents {
  message: [Message];
  sessions: [];
  delivery: [number, Delivery];
}

interface SessionRow {
  id: string;
  app: AppKind;
  project: string;
  worktree: string | null;
  cwd: string;
  name: string;
  name_source: NameSource;
  role: SessionRole | null;
  spawned_by_run: number | null;
  project_id: string | null;
  pid: number | null;
  /** JSON: Prozesse über dem Hook, Agent zuerst */
  proc_chain: string | null;
  /** Geheimnis, das nur dieser Thread über seinen Hook erfahren hat */
  mcp_key: string | null;
  status: SessionStatus;
  stop_continuations: number;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

interface MessageRow {
  id: number;
  from_kind: "session" | "human";
  from_id: string;
  from_app: AppKind | null;
  from_project: string | null;
  from_worktree: string | null;
  from_name: string;
  to_target: string;
  text: string;
  created_at: string;
}

const HUMAN_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

/** Woher der Anzeigename stammt. Ein stärkerer Wert wird nie von einem schwächeren überschrieben. */
export type NameSource = "auto" | "registry" | "cli-user" | "user" | "override";
const NAME_RANK: Record<NameSource, number> = { auto: 0, registry: 1, "cli-user": 2, user: 3, override: 3 };

/** Sessions, die nur über einen MCP-Aufruf bekannt sind, weil kein Hook sie angemeldet hat. */
const PLACEHOLDER_PREFIX = "mcp-";

/** Ergebnis der Zuordnung eines MCP-Aufrufs zu einer Session. */
export interface Identity {
  /** null nur, wenn problem gesetzt ist */
  session: Session | null;
  /** Woran erkannt: am Sitzungsschlüssel, am anrufenden Prozess, am Verzeichnis, oder Platzhalter */
  via: "schluessel" | "prozess" | "verzeichnis" | "platzhalter";
  /** false, wenn weitere Sessions genauso gut passen; dann darf niemand unter dieser Identität handeln */
  certain: boolean;
  /** Die anderen Kandidaten, wenn unsicher */
  others: Session[];
  /** Der mitgeschickte Schlüssel gehört zu keiner lebenden Session dieser App. */
  problem?: "unbekannter-schluessel";
}

function chainOf(r: { proc_chain: string | null } | undefined): Proc[] {
  if (!r?.proc_chain) return [];
  try {
    const v = JSON.parse(r.proc_chain) as Proc[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Programmnamen vergleichen; lsof und ps kürzen lange Namen unterschiedlich. */
function sameProgram(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return n >= 15 && a.slice(0, n) === b.slice(0, n);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Verbindungsregel (docs/verbindung.md). Der Hook ist das einzige, was einem Chat Post von
 * selbst zustellt; eine gespeicherte Prozesskette gibt es nur, wenn er sich gemeldet hat.
 * Lebt der Prozess, gilt der Chat als verbunden, gleich wie lange er schon ruht: Claude
 * trägt beendete Chats über die Registry aus, Codex über SessionEnd, und Codex-Threads
 * teilen sich einen Prozess, sodass ein Zeitfenster offene, ruhende Threads als getrennt
 * zeigen würde.
 */
export function connectionOf(
  r: Pick<SessionRow, "id" | "pid" | "proc_chain" | "ended_at">,
  alive: (pid: number) => boolean = pidAlive,
): ConnectionState {
  if (r.ended_at) return "ended";
  if (r.id.startsWith(PLACEHOLDER_PREFIX)) return "no-hook";
  const chain = chainOf(r);
  // Claude: die PID aus der Registry ist maßgeblich; sonst der Agent über dem Hook.
  const pid = r.pid ?? chain[0]?.pid ?? null;
  if (pid !== null && !alive(pid)) return "stale";
  if (!chain.length) return "no-hook";
  return "connected";
}

/** Dieselben dynamischen Ziele gelten für Posteingang und die lesende Chatansicht. */
const SESSION_TARGETS = `(m.to_target = ? OR m.to_target IN (?, ?)
  OR (m.to_target IN (?, 'all') AND m.created_at >= ?)
  OR (? = 'pm' AND m.to_target IN (?, ?))
  OR (? = 'director' AND m.to_target = 'director'))`;
function targetParams(s: SessionRow, board: Board): string[] {
  const id = s.project_id ?? s.project;
  const alias = board.projectAddressId(s.project) === id ? s.project : id;
  return [`session:${s.id}`, `project:${id}`, `project:${alias}`, `app:${s.app}`, s.started_at,
    s.role ?? "", `pm:${id}`, `pm:${alias}`, s.role ?? ""];
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function targetLabel(t: Target, resolveSession?: (id: string) => string | null): string {
  switch (t.kind) {
    case "all":
      return "alle";
    case "pm":
      return `PM von ${t.project}`;
    case "director":
      return "den Director";
    case "session":
      return resolveSession?.(t.id) ?? `Session ${t.id.slice(0, 8)}`;
    case "project":
      return `Projekt ${t.name}`;
    case "app":
      return `alle ${APP_LABELS[t.app]}-Sessions`;
    case "human":
      return t.name;
  }
}

/**
 * Kern von CrewPip: Sessions verwalten, Nachrichten ablegen, pro Session festhalten,
 * was sie schon gesehen hat, und Wartende aufwecken.
 */
export class Inbox extends EventEmitter<InboxEvents> {
  constructor(
    private readonly db: DatabaseSync,
    private readonly board: Board,
  ) {
    super();
  }

  // ---- Sessions ---------------------------------------------------------

  private sessionRow(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  private toSession(r: SessionRow): Session {
    return {
      id: r.id,
      app: r.app,
      projectId: r.project_id ?? "",
      project: r.project,
      worktree: r.worktree,
      cwd: r.cwd,
      ...this.board.sessionDisplay(r),
      status: r.ended_at ? "ended" : r.status,
      connection: connectionOf(r),
      startedAt: r.started_at,
      lastSeenAt: r.last_seen_at,
      endedAt: r.ended_at,
      role: r.role,
      spawnedByRun: r.spawned_by_run,
      pending: r.ended_at ? 0 : this.pendingFor(r.id).length,
      task: r.ended_at ? null : (() => {
        const t = this.board.taskOfSession(r.id, r.cwd);
        return t ? { id: t.id, title: t.title, status: t.status } : null;
      })(),
    };
  }

  labelOf(id: string): string | null {
    return this.board.displayForId(id)?.label ?? null;
  }

  /** Session anlegen oder auffrischen. Ein späterer Aufruf ohne Socket überschreibt den Socket nicht. */
  upsertSession(s: {
    id: string;
    app: AppKind;
    cwd: string;
    name?: string | null;
    /** Standard "user": ein ausdrücklich gesetzter Name gewinnt gegen automatische. */
    nameSource?: NameSource;
    role?: SessionRole | null;
    /** Nummer des Laufs, aus dem die Session stammt. */
    runId?: number | null;
    pid?: number | null;
    status?: SessionStatus;
    startedAt?: string | null;
    /** false für den Registry-Abgleich: er belegt keine Aktivität der Session. */
    touch?: boolean;
  }): Session {
    const existing = this.sessionRow(s.id);
    let nameApplied = !existing;
    const now = new Date().toISOString();
    // Maßgeblich ist die Repository-Wurzel; projectOf dient nur als Anzeigename-Rückfall.
    const proj = this.board.resolveProject(s.cwd);
    const project = proj.name;
    const worktree = path.resolve(s.cwd) === proj.root ? null : path.basename(path.resolve(s.cwd));
    const name = s.name?.trim() || null;
    const source: NameSource = name ? (s.nameSource ?? "override") : "auto";
    const role = s.role !== undefined ? s.role : name ? roleFromName(name) : null;
    if (!existing) {
      const started = s.startedAt ?? now;
      this.db
        .prepare(
          `INSERT INTO sessions(id, app, project, worktree, project_id, cwd, name, name_source, spawned_by_run, pid, status, started_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(s.id, s.app, project, worktree, proj.id, s.cwd, name ?? `Session ${timeLabel(started)}`, source, s.runId ?? null, s.pid ?? null, s.status ?? "idle", started, s.touch === false ? started : now);
    } else {
      // Der Name wird nur übernommen, wenn seine Quelle mindestens so stark ist wie die bisherige.
      const confirmedLegacy = s.app === "claude" && source === "cli-user" && existing.name_source === "user" && name === existing.name;
      const keepName = !name || (!confirmedLegacy && NAME_RANK[source] < NAME_RANK[existing.name_source]);
      nameApplied = !keepName;
      this.db
        .prepare(
          `UPDATE sessions SET app = ?, project = ?, worktree = ?, project_id = ?, cwd = ?,
             name = COALESCE(?, name), name_source = COALESCE(?, name_source), spawned_by_run = COALESCE(?, spawned_by_run), pid = COALESCE(?, pid),
             -- Meldet sich eine beendete Session zurück, ist sie wieder da: sonst bliebe der
             -- Status "beendet" stehen, obwohl sie Nachrichten empfängt.
             status = COALESCE(?, CASE WHEN status = 'ended' THEN 'idle' ELSE status END),
             ended_at = NULL, last_seen_at = ? WHERE id = ?`,
        )
        .run(s.app, project, worktree, proj.id, s.cwd, keepName ? null : name, keepName ? null : source, s.runId ?? null, s.pid ?? null, s.status ?? null, s.touch === false ? existing.last_seen_at : now, s.id);
    }
    // Die Rolle läuft über setRole, damit die Ablösung des bisherigen Directors oder PM
    // auch dann greift, wenn die Rolle nur aus dem Namen abgeleitet wurde.
    if (s.role !== undefined) this.setRole(s.id, s.role);
    else if (role && nameApplied && (!existing || s.touch !== false)) this.setRole(s.id, role);
    else if (existing?.ended_at && (existing.role === "director" || existing.role === "pm")) {
      const occupied = this.db.prepare(
        "SELECT 1 FROM sessions WHERE id <> ? AND ended_at IS NULL AND role = ? AND (role = 'director' OR project_id = ?)",
      ).get(s.id, existing.role, proj.id);
      if (occupied) this.setRole(s.id, null);
    }
    if (!existing || existing.project_id !== proj.id || (nameApplied && (existing.name !== name || existing.name_source !== source))) this.board.emit("projects");

    // Meldet sich eine echte Session für ein Verzeichnis, ist der MCP-Platzhalter überflüssig.
    if (!s.id.startsWith(PLACEHOLDER_PREFIX)) {
      for (const r of this.db
        .prepare("SELECT id FROM sessions WHERE app = ? AND cwd = ? AND ended_at IS NULL AND id LIKE ?")
        .all(s.app, s.cwd, `${PLACEHOLDER_PREFIX}%`) as unknown as { id: string }[]) {
        this.endSession(r.id);
      }
    }
    this.emit("sessions");
    return this.toSession(this.sessionRow(s.id)!);
  }

  /** Anbindung für den Registry-Beobachter von Claude Code. */
  registrySync(): { upsert(e: RegistryEntry): void; endMissing(livePids: number[]): number } {
    return {
      upsert: (e) => {
        this.upsertSession({
          id: e.sessionId,
          app: "claude",
          cwd: e.cwd,
          name: e.name,
          // Nur ein per /rename gesetzter Name gilt als ausdrücklicher Wunsch.
          nameSource: e.nameSource === "user" ? "cli-user" : "registry",
          pid: e.pid,
          startedAt: e.startedAt,
          touch: false,
        });
      },
      endMissing: (livePids) => {
        const rows = this.db
          .prepare("SELECT id, pid FROM sessions WHERE app = 'claude' AND pid IS NOT NULL AND ended_at IS NULL")
          .all() as unknown as { id: string; pid: number }[];
        const live = new Set(livePids);
        const gone = rows.filter((r) => !live.has(r.pid));
        for (const r of gone) this.endSession(r.id);
        return gone.length;
      },
    };
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db.prepare("UPDATE sessions SET status = ?, last_seen_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    this.emit("sessions");
  }

  endSession(id: string): void {
    this.db.prepare("UPDATE sessions SET ended_at = ?, status = 'ended' WHERE id = ? AND ended_at IS NULL").run(new Date().toISOString(), id);
    this.emit("sessions");
  }

  renameSession(id: string, name: string): Session {
    const clean = name.trim();
    if (!clean) throw new Error("Leerer Name");
    this.db.prepare("UPDATE sessions SET name = ?, name_source = 'override' WHERE id = ?").run(clean, id);
    const derived = roleFromName(clean);
    if (derived) this.setRole(id, derived);
    const row = this.sessionRow(id);
    if (!row) throw new Error("Unbekannte Session");
    this.board.emit("projects");
    this.emit("sessions");
    return this.toSession(row);
  }

  /**
   * Rolle setzen. Es soll je Projekt nur einen PM und insgesamt nur einen Director geben;
   * eine neue Vergabe nimmt der bisherigen aktiven Session die Rolle ab, statt zu scheitern.
   */
  setRole(id: string, role: SessionRole | null): Session {
    const row = this.sessionRow(id);
    if (!row) throw new Error(`Unbekannte Session: ${id}`);
    if (role === "director") {
      this.db.prepare("UPDATE sessions SET role = NULL WHERE role = 'director' AND id <> ? AND ended_at IS NULL").run(id);
    } else if (role === "pm") {
      this.db.prepare("UPDATE sessions SET role = NULL WHERE role = 'pm' AND project_id = ? AND id <> ? AND ended_at IS NULL").run(row.project_id, id);
    }
    this.db.prepare("UPDATE sessions SET role = ? WHERE id = ?").run(role, id);
    this.emit("sessions");
    return this.toSession(this.sessionRow(id)!);
  }

  /** Session, die aus einem Lauf hervorgegangen ist. */
  sessionOfRun(runId: number): string | null {
    const r = this.db
      .prepare("SELECT id FROM sessions WHERE spawned_by_run = ? ORDER BY started_at DESC LIMIT 1")
      .get(runId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** Session zu einem Verzeichnis ohne Prozessangabe; siehe identify. */
  resolveByCwd(app: AppKind, cwd: string): Session {
    return this.identify(app, cwd, null).session!;
  }

  /** Prozesse über dem Hook dieser Session merken (Agent zuerst). */
  setProcChain(id: string, chain: Proc[]): void {
    this.db.prepare("UPDATE sessions SET proc_chain = ? WHERE id = ?").run(JSON.stringify(chain), id);
  }

  /** Lebt der Agent-Prozess, den der Hook zuletzt gemeldet hat? Ohne Eintrag: nein. */
  procChainAlive(id: string): boolean {
    const head = chainOf(this.sessionRow(id))[0];
    return !!head && pidAlive(head.pid);
  }

  /**
   * Sitzungsschlüssel dieser Session, beim ersten Abruf erzeugt.
   *
   * Nötig, weil manche Apps alle Chats über einen Prozess führen: Bei Codex hängen alle
   * Threads der ChatGPT-App am selben Prozess (gemessen: codex 6665), und die MCP-Anfrage
   * trägt kein Thread-Merkmal. Der Schlüssel geht ausschließlich über den Hook an genau
   * diesen Thread; wer ihn vorzeigt, war in diesem Thread.
   */
  sessionKey(id: string): string {
    const row = this.sessionRow(id);
    if (!row) throw new Error(`Unbekannte Session: ${id}`);
    if (row.mcp_key) return row.mcp_key;
    const key = randomBytes(24).toString("base64url");
    this.db.prepare("UPDATE sessions SET mcp_key = ? WHERE id = ?").run(key, id);
    return key;
  }

  /**
   * Braucht dieser Thread den Schlüssel, um erkannt zu werden? Wahr, sobald eine andere
   * lebende Session derselben App denselben Prozess **und** dasselbe Verzeichnis hat — dann
   * reichen Prozess und Verzeichnis nicht mehr aus. Sonst bleibt der Hinweis weg, damit
   * Chats nicht ohne Not Text in den Kontext bekommen.
   */
  needsSessionKey(id: string): boolean {
    const me = this.sessionRow(id);
    if (!me) return false;
    const head = chainOf(me)[0];
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE app = ? AND cwd = ? AND ended_at IS NULL AND id <> ?")
      .all(me.app, me.cwd, id) as unknown as SessionRow[];
    return rows.some((r) => {
      if (r.id.startsWith(PLACEHOLDER_PREFIX)) return false;
      const other = chainOf(r)[0];
      // Gleicher Prozess, oder beide ohne bekannten Prozess: in beiden Fällen nicht trennbar.
      if (!head || !other) return r.pid === null || me.pid === null;
      return other.pid === head.pid && sameProgram(other.comm, head.comm);
    });
  }

  /**
   * Session zu einem MCP-Aufruf finden, zuerst am Sitzungsschlüssel, dann am anrufenden
   * Prozess, dann am Verzeichnis.
   *
   * 1. Der Prozess ist eine Claude-Session aus der Registry (pid) → sicher.
   * 2. Der Prozess steht in der Kette über dem Hook einer Session → sicher, wenn genau eine
   *    Session ihn am nächsten führt; sonst entscheidet das Verzeichnis unter diesen.
   * 3. Kein Prozess erkannt: das Verzeichnis. Genau eine aktive Session dort → sicher.
   *
   * Bleiben mehrere übrig, ist das Ergebnis unsicher. Der Aufrufer darf dann nicht unter
   * dieser Identität handeln — das war der Fehler aus Aufgabe #13.
   */
  identify(app: AppKind, cwd: string, caller: Proc | null, key?: string | null): Identity {
    const clean = path.resolve(cwd);
    if (key) {
      // Der Schlüssel schlägt alles andere. Passt er nicht, wird abgelehnt statt auf das
      // Verzeichnis zurückzufallen: ein falscher Schlüssel ist ein Hinweis auf eine
      // Verwechslung, kein Anlass zu raten.
      const row = this.db
        .prepare("SELECT * FROM sessions WHERE mcp_key = ? AND app = ? AND ended_at IS NULL")
        .get(key, app) as SessionRow | undefined;
      if (!row) return { session: null, via: "schluessel", certain: false, others: [], problem: "unbekannter-schluessel" };
      this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      return { session: this.toSession(row), via: "schluessel", certain: true, others: [] };
    }
    const rows = (
      this.db.prepare("SELECT * FROM sessions WHERE app = ? AND ended_at IS NULL ORDER BY last_seen_at DESC").all(app) as unknown as SessionRow[]
    ).filter((r) => !r.id.startsWith(PLACEHOLDER_PREFIX));
    const found = (r: SessionRow, via: Identity["via"], others: SessionRow[] = []): Identity => {
      this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
      return { session: this.toSession(r), via, certain: others.length === 0, others: others.map((o) => this.toSession(o)) };
    };
    const narrow = (pool: SessionRow[], via: Identity["via"]): Identity => {
      const here = pool.filter((r) => r.cwd === clean);
      const pick = here.length ? here : pool;
      return found(pick[0]!, via, pick.slice(1));
    };

    if (caller) {
      const byPid = rows.filter((r) => r.pid === caller.pid);
      if (byPid.length) return narrow(byPid, "prozess");
      let best = Infinity;
      let pool: SessionRow[] = [];
      for (const r of rows) {
        const depth = chainOf(r).findIndex((p) => p.pid === caller.pid && sameProgram(p.comm, caller.comm));
        if (depth < 0 || depth > best) continue;
        if (depth < best) pool = [];
        best = depth;
        pool.push(r);
      }
      if (pool.length) return narrow(pool, "prozess");
    }

    const here = rows.filter((r) => r.cwd === clean);
    if (here.length) return found(here[0]!, "verzeichnis", here.slice(1));
    const id = `${PLACEHOLDER_PREFIX}${app}-${createHash("sha1").update(clean).digest("hex").slice(0, 8)}`;
    return { session: this.upsertSession({ id, app, cwd: clean, name: "ohne Hook", nameSource: "auto", status: "working" }), via: "platzhalter", certain: true, others: [] };
  }

  sessions(opts: { includeEnded?: boolean } = {}): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${opts.includeEnded ? "" : "WHERE ended_at IS NULL"} ORDER BY project, last_seen_at DESC`)
      .all() as unknown as SessionRow[];
    return rows.map((r) => this.toSession(r));
  }


  // ---- Nachrichten --------------------------------------------------------

  private toMessage(r: MessageRow): Message {
    const display = r.from_kind === "session" ? this.board.displayForId(r.from_id) : undefined;
    const from: Party =
      r.from_kind === "session"
        ? { kind: "session", id: r.from_id, app: r.from_app ?? "other", project: r.from_project ?? "", projectId: display?.projectId, worktree: r.from_worktree, name: display?.name ?? r.from_name, label: display?.label ?? sessionLabel(r.from_app ?? "other", r.from_project ?? "", r.from_name, r.from_worktree), role: roleFromName(r.from_name) }
        : { kind: "human", name: r.from_name, label: r.from_name };
    const to = parseTarget(r.to_target);
    const deliveries = (
      this.db.prepare("SELECT d.session_id, d.method, d.at, s.app, s.project, s.project_id, s.worktree, s.name, s.name_source FROM deliveries d JOIN sessions s ON s.id = d.session_id WHERE d.message_id = ? ORDER BY d.at").all(r.id) as unknown as {
        session_id: string; method: DeliveryMethod; at: string; app: AppKind; project: string; project_id: string; worktree: string | null; name: string; name_source: string;
      }[]
    ).map((d) => ({ sessionId: d.session_id, sessionLabel: this.board.sessionDisplay({ ...d, id: d.session_id }).label, method: d.method, at: d.at }));
    const delivered = new Set(deliveries.map((d) => d.sessionId));
    const pending = this.targetSessions(r).filter((s) => !delivered.has(s.id)).map((s) => this.board.sessionDisplay(s).label);
    return {
      id: r.id,
      from,
      to,
      toLabel: targetLabel(to, (id) => this.labelOf(id)),
      replyTo: r.from_kind === "session" ? `session:${r.from_id}` : `human:${r.from_id}`,
      text: r.text,
      createdAt: r.created_at,
      deliveries,
      pending,
    };
  }

  /** Aktive Sessions, die eine Nachricht laut Ziel bekommen sollen. */
  private targetSessions(m: MessageRow): SessionRow[] {
    const t = parseTarget(m.to_target);
    const notSelf = (rows: SessionRow[]) => rows.filter((s) => !(m.from_kind === "session" && s.id === m.from_id));
    switch (t.kind) {
      case "session":
        return notSelf([this.sessionRow(t.id)].filter((s): s is SessionRow => !!s && !s.ended_at));
      case "project": {
        const projectId = this.board.projectAddressId(t.name);
        return projectId ? notSelf(this.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NULL").all(projectId) as unknown as SessionRow[]) : [];
      }
      case "app":
        return notSelf(this.db.prepare("SELECT * FROM sessions WHERE app = ? AND ended_at IS NULL AND started_at <= ?").all(t.app, m.created_at) as unknown as SessionRow[]);
      case "all":
        return notSelf(this.db.prepare("SELECT * FROM sessions WHERE ended_at IS NULL AND started_at <= ?").all(m.created_at) as unknown as SessionRow[]);
      case "pm": {
        const projectId = this.board.projectAddressId(t.project);
        if (!projectId) return [];
        return notSelf(
          this.db.prepare("SELECT * FROM sessions WHERE role = 'pm' AND project_id = ? AND ended_at IS NULL").all(projectId) as unknown as SessionRow[],
        );
      }
      case "director":
        return notSelf(this.db.prepare("SELECT * FROM sessions WHERE role = 'director' AND ended_at IS NULL").all() as unknown as SessionRow[]);
      case "human":
        return [];
    }
  }

  post(from: { sessionId: string } | { human: string }, toRaw: string, text: string): Message {
    const body = text.trim();
    if (!body) throw new Error("Leere Nachricht");
    const to = parseTarget(toRaw);
    if (to.kind === "session" && !this.sessionRow(to.id)) throw new Error(`Unbekannte Session: ${to.id}`);
    if (to.kind === "human" && !HUMAN_NAME.test(to.name)) throw new Error(`Ungültiger Name: "${to.name}"`);
    let res;
    if ("sessionId" in from) {
      const s = this.sessionRow(from.sessionId);
      if (!s) throw new Error(`Unbekannte Session: ${from.sessionId}`);
      res = this.db
        .prepare("INSERT INTO messages(from_kind, from_id, from_app, from_project, from_worktree, from_name, to_target, text) VALUES ('session', ?, ?, ?, ?, ?, ?, ?)")
        .run(s.id, s.app, s.project, s.worktree, s.name, formatTarget(to), body);
    } else {
      const name = from.human.trim();
      if (!HUMAN_NAME.test(name)) throw new Error(`Ungültiger Name: "${name}"`);
      res = this.db
        .prepare("INSERT INTO messages(from_kind, from_id, from_name, to_target, text) VALUES ('human', ?, ?, ?, ?)")
        .run(name, name, formatTarget(to), body);
    }
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(res.lastInsertRowid)) as unknown as MessageRow;
    const msg = this.toMessage(row);
    this.emit("message", msg);
    this.emit("sessions");
    return msg;
  }

  /** Nachrichten, die eine Session noch nicht gesehen hat. */
  pendingFor(sessionId: string, limit = 50): Message[] {
    const s = this.sessionRow(sessionId);
    if (!s || s.ended_at) return [];
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.session_id = ?)
           AND NOT (m.from_kind = 'session' AND m.from_id = ?)
           AND ${SESSION_TARGETS}
         ORDER BY m.id ASC LIMIT ?`,
      )
      .all(s.id, s.id, ...targetParams(s, this.board), limit) as unknown as MessageRow[];
    return rows.map((r) => this.toMessage(r));
  }

  recordDelivery(messageId: number, sessionId: string, method: DeliveryMethod): void {
    const at = new Date().toISOString();
    const r = this.db
      .prepare("INSERT OR IGNORE INTO deliveries(message_id, session_id, method, at) VALUES (?, ?, ?, ?)")
      .run(messageId, sessionId, method, at);
    if (Number(r.changes) > 0) {
      this.emit("delivery", messageId, { sessionId, sessionLabel: this.labelOf(sessionId) ?? sessionId, method, at });
      this.emit("sessions");
    }
  }

  /** Ausstehende Nachrichten holen und als zugestellt verbuchen. */
  take(sessionId: string, method: DeliveryMethod, limit = 50): Message[] {
    const msgs = this.pendingFor(sessionId, limit);
    for (const m of msgs) this.recordDelivery(m.id, sessionId, method);
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
    // Frisch laden, damit die Zustellung an dieser Session in den Rückgabewerten steht.
    return msgs.map((m) => this.message(m.id) ?? m);
  }

  /** Wartet bis eine passende Nachricht eintrifft oder die Zeit abläuft. Gibt sie als zugestellt zurück. */
  async waitFor(sessionId: string, timeoutMs: number, signal?: AbortSignal, method: DeliveryMethod = "mcp-wait"): Promise<Message[]> {
    const immediate = this.take(sessionId, method);
    if (immediate.length) return immediate;
    return new Promise<Message[]>((resolve) => {
      const done = (msgs: Message[]) => {
        clearTimeout(timer);
        this.off("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        resolve(msgs);
      };
      const onMessage = () => {
        const got = this.take(sessionId, method);
        if (got.length) done(got);
      };
      const onAbort = () => done([]);
      const timer = setTimeout(() => done([]), timeoutMs);
      this.on("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Nachrichtenwege seit `since`: je Absender und abholendem Chat Anzahl und letzte Zustellung.
   * Zählt nur, was tatsächlich zugestellt wurde; so landen `pm:` und `director` beim Chat, der
   * die Nachricht abgeholt hat. Liefert keine Inhalte.
   */
  flows(since: string): MessageFlow[] {
    const rows = this.db
      .prepare(
        `SELECT m.from_kind, m.from_id, d.session_id, COUNT(*) AS n, MAX(d.at) AS last_at
         FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.at >= ?
         GROUP BY m.from_kind, m.from_id, d.session_id
         ORDER BY last_at DESC`,
      )
      .all(since) as unknown as { from_kind: "session" | "human"; from_id: string; session_id: string; n: number; last_at: string }[];
    const end = (id: string): FlowSession | null => {
      const r = this.sessionRow(id);
      return r ? { id: r.id, app: r.app, projectId: r.project_id ?? "", project: r.project, ...this.board.sessionDisplay(r) } : null;
    };
    const flows: MessageFlow[] = [];
    for (const r of rows) {
      const to = end(r.session_id);
      const from = r.from_kind === "session" ? end(r.from_id) : null;
      if (!to || (r.from_kind === "session" && !from)) continue;
      flows.push({ from: from ? { kind: "session", ...from } : { kind: "human", name: r.from_id }, to, count: Number(r.n), lastAt: r.last_at });
    }
    return flows;
  }

  /** Neueste Nachrichten dieses Chats einschließlich aktuell wartender Rollenpost, ohne Abholung. */
  recentFor(id: string, limit: number): Message[] {
    const s = this.sessionRow(id);
    if (!s) return [];
    const rows = this.db.prepare(`SELECT m.* FROM messages m WHERE
      (m.from_kind = 'session' AND m.from_id = ?) OR m.to_target = ?
      OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.session_id = ?)
      OR (? IS NULL AND ${SESSION_TARGETS})
      ORDER BY m.id DESC LIMIT ?`).all(id, `session:${id}`, id, s.ended_at, ...targetParams(s, this.board), limit) as unknown as MessageRow[];
    return rows.reverse().map(r => this.toMessage(r));
  }

  recent(limit = 200): Message[] {
    const rows = this.db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?").all(limit) as unknown as MessageRow[];
    return rows.reverse().map((r) => this.toMessage(r));
  }

  message(id: number): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as MessageRow | undefined;
    return row ? this.toMessage(row) : null;
  }

  /** Sessions mit Push-Kanal, die eine Nachricht noch nicht haben. */

  // ---- Schleifensperre am Turn-Ende ------------------------------------

  countStopContinuation(sessionId: string, max: number): boolean {
    const row = this.sessionRow(sessionId);
    if (!row) return false;
    if (row.stop_continuations >= max) return false;
    this.db.prepare("UPDATE sessions SET stop_continuations = stop_continuations + 1 WHERE id = ?").run(sessionId);
    return true;
  }

  resetStopContinuations(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET stop_continuations = 0 WHERE id = ?").run(sessionId);
  }
}
