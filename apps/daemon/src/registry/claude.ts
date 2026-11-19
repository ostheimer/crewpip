import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Liest die Session-Registry von Claude Code.
 *
 * Claude Code legt für jede Session mit Cross-Session-Messaging eine Datei
 * ~/.claude/sessions/<pid>.json an (dokumentiert als "Each session registers itself in files
 * on disk", cross-session-messaging.md). Das Format selbst ist NICHT dokumentiert; hier
 * abgelesen von Version 2.1.255. Alles ist deshalb optional und fehlertolerant: Fehlt das
 * Verzeichnis oder ein Feld, arbeitet CrewPip ohne Registry weiter und verlässt sich auf
 * die Hooks.
 */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Von Claude Code vergebener Name, z. B. "CrewPip-55", nach /rename der eigene */
  name: string | null;
  /** "derived" | "auto" | "collision" | "user" | "peer" — "user" heißt: per /rename gesetzt */
  nameSource: string | null;
  startedAt: string | null;
}

export function registryDir(): string {
  return process.env.CREWPIP_CLAUDE_SESSIONS ?? path.join(os.homedir(), ".claude", "sessions");
}

function pidAlive(pid: number): boolean {
  // pid 0 adressiert die eigene Prozessgruppe, negative Werte ganze Gruppen: nie prüfen.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM heißt: Prozess existiert, gehört aber jemand anderem.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Alle lebenden Einträge. Karteileichen (Prozess weg) werden ausgelassen. */
export function readClaudeRegistry(dir = registryDir()): RegistryEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
      const pid = Number(raw.pid);
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
      const cwd = typeof raw.cwd === "string" ? raw.cwd : null;
      if (!sessionId || !cwd || !pidAlive(pid)) continue;
      out.push({
        pid,
        sessionId,
        cwd,
        name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
        nameSource: typeof raw.nameSource === "string" ? raw.nameSource : null,
        startedAt: typeof raw.startedAt === "number" ? new Date(raw.startedAt).toISOString() : null,
      });
    } catch {
      // Datei halb geschrieben oder unlesbar: überspringen, beim nächsten Durchlauf erneut versuchen.
    }
  }
  return out;
}

export interface RegistrySync {
  /** Lebende Claude-Session übernehmen */
  upsert(e: RegistryEntry): void;
  /** Sessions beenden, deren Prozess nicht mehr in der Registry steht. Gibt die Anzahl zurück. */
  endMissing(livePids: number[]): number;
}

/**
 * Beobachtet das Verzeichnis und gleicht periodisch ab. fs.watch meldet Änderungen sofort,
 * der Intervall-Durchlauf fängt ab, was fs.watch verschluckt, und erkennt Prozesse, die ohne
 * Aufräumen gestorben sind.
 */
export class ClaudeRegistryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;

  constructor(
    private readonly sync: RegistrySync,
    private readonly opts: { dir?: string; intervalMs?: number; log?: (l: string) => void } = {},
  ) {}

  sweep(): void {
    const entries = readClaudeRegistry(this.opts.dir ?? registryDir());
    for (const e of entries) this.sync.upsert(e);
    const ended = this.sync.endMissing(entries.map((e) => e.pid));
    if (ended) this.opts.log?.(`[registry] ${ended} beendete Session(s) ausgetragen`);
  }

  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), this.opts.intervalMs ?? 20000);
    this.timer.unref?.();
    try {
      this.watcher = fs.watch(this.opts.dir ?? registryDir(), () => {
        // Kurz sammeln: beim Start einer Session fallen mehrere Ereignisse an.
        if (this.pending) clearTimeout(this.pending);
        this.pending = setTimeout(() => this.sweep(), 250);
        this.pending.unref?.();
      });
    } catch {
      // Kein Verzeichnis: nur der Intervall-Durchlauf, der es später erneut versucht.
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.watcher?.close();
    this.timer = null;
    this.watcher = null;
    this.pending = null;
  }
}
