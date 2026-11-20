import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { RUN_MODES, type AppKind, type Run, type RunItem, type RunMode, type RunStatus } from "@crewpip/shared";
import type { Board } from "../board.js";
import { RUNNER_APPS, type RunnerApp } from "./apps.js";
import * as git from "../git.js";

export interface RunnerEvents {
  runs: [];
  item: [number, RunItem];
  /** Ein Lauf ist zu Ende. Wer ihn angestoßen hat, soll es erfahren. */
  finished: [Run];
}

interface RunRow {
  id: number;
  task_id: number | null;
  started_by_session_id: string | null;
  project_id: string;
  app: AppKind;
  cwd: string;
  prompt: string;
  mode: RunMode;
  status: RunStatus;
  pid: number | null;
  exit_code: number | null;
  log_path: string;
  summary: string | null;
  push_log: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface StartOptions {
  taskId?: number | null;
  /** Session, die den Lauf anstößt. Fehlt sie, kommt der Start aus der Oberfläche. */
  startedBySessionId?: string | null;
  projectId?: string;
  cwd?: string;
  prompt: string;
  app: AppKind;
  mode: RunMode;
  /** Muss ausdrücklich gesetzt sein, um schreibend im Haupt-Checkout zu laufen. */
  allowProjectRoot?: boolean;
}

/**
 * Startet Agents als eigene Prozesse und hält ihren Ablauf fest.
 *
 * Bewusste Grenzen:
 * - Es gibt nur zwei Rechtestufen: nur lesen oder im Arbeitsverzeichnis schreiben. Einen
 *   Modus ohne Rückfragen und ohne Sandbox bietet CrewPip nicht an.
 * - Schreibende Läufe verlangen einen Worktree. Der Haupt-Checkout ist nur mit
 *   ausdrücklichem allowProjectRoot erreichbar.
 * - Kein MCP-Werkzeug startet Läufe: Agents können keine Agents starten.
 */
export class Runner extends EventEmitter<RunnerEvents> {
  private readonly live = new Map<number, { child: ChildProcess; timer: NodeJS.Timeout }>();

  /** Anzeigename einer Session, ohne Inbox-Abhängigkeit. */
  private labelOf(id: string): string {
    return this.board.displayForId(id)?.label ?? id;
  }

  constructor(
    private readonly db: DatabaseSync,
    private readonly board: Board,
    private readonly opts: { logDir: string; timeoutMs?: number; maxParallel?: number; log?: (l: string) => void } = {
      logDir: path.join(process.env.HOME ?? ".", ".crewpip", "runs"),
    },
  ) {
    super();
    // Läufe aus einem früheren Daemon-Leben sind mit dem Prozess gestorben.
    this.db
      .prepare("UPDATE runs SET status = 'stopped', ended_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
  }

  private row(id: number): RunRow {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!r) throw new Error(`Unbekannter Lauf: ${id}`);
    return r;
  }

  private toRun(r: RunRow): Run {
    const task = r.task_id ? this.board.task(r.task_id) : null;
    const starter = r.started_by_session_id
      ? (this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(r.started_by_session_id) as { id: string } | undefined)
      : undefined;
    return {
      id: r.id,
      taskId: r.task_id,
      startedBy: starter ? { id: starter.id, label: this.labelOf(starter.id) } : null,
      taskTitle: task?.title ?? null,
      projectId: r.project_id,
      app: r.app,
      cwd: r.cwd,
      prompt: r.prompt,
      mode: r.mode,
      status: r.status,
      exitCode: r.exit_code,
      summary: r.summary,
      pushLog: r.push_log,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    };
  }

  runs(filter: { taskId?: number; limit?: number } = {}): Run[] {
    const rows = (
      filter.taskId
        ? this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(filter.taskId, filter.limit ?? 50)
        : this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(filter.limit ?? 50)
    ) as unknown as RunRow[];
    return rows.map((r) => this.toRun(r));
  }

  run(id: number): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return r ? this.toRun(r) : null;
  }

  /** Aufbereiteter Ablauf eines Laufs aus der mitgeschriebenen Datei. */
  items(id: number, limit = 300): RunItem[] {
    const r = this.row(id);
    const appImpl = RUNNER_APPS[r.app];
    if (!appImpl) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(r.log_path, "utf8");
    } catch {
      return [];
    }
    const out: RunItem[] = [];
    for (const line of raw.split("\n")) {
      const item = appImpl.parse(line);
      if (item) out.push(item);
    }
    return out.slice(-limit);
  }

  private authCache = new Map<string, { at: number; value: boolean | null }>();

  /** Welche Apps hier tatsächlich startbar sind, samt Anmeldestatus. */
  available(): { app: AppKind; bin: string | null; loggedIn: boolean | null; hint: string }[] {
    return Object.values(RUNNER_APPS).map((a) => {
      const bin = a.bin();
      let loggedIn: boolean | null = null;
      if (bin) {
        // Der Aufruf startet einen Prozess, deshalb eine halbe Minute gepuffert.
        const cached = this.authCache.get(a.id);
        if (cached && Date.now() - cached.at < 30_000) loggedIn = cached.value;
        else {
          loggedIn = a.loggedIn(bin);
          this.authCache.set(a.id, { at: Date.now(), value: loggedIn });
        }
      }
      return { app: a.id, bin, loggedIn, hint: a.loginHint };
    });
  }

  /** Nach einer Anmeldung von außen: gepufferten Status verwerfen. */
  forgetAuth(): void {
    this.authCache.clear();
  }

  private validate(o: StartOptions): { appImpl: RunnerApp; bin: string; cwd: string; projectId: string; taskId: number | null } {
    // Ein Lauf darf keine weiteren Läufe starten. Ohne diese Grenze könnte sich die
    // Zahl gleichzeitiger Agents mit jeder Stufe vervielfachen.
    if (o.startedBySessionId) {
      const starter = this.db
        .prepare("SELECT spawned_by_run FROM sessions WHERE id = ?")
        .get(o.startedBySessionId) as { spawned_by_run: number | null } | undefined;
      if (!starter) throw new Error(`Unbekannte Session: ${o.startedBySessionId}`);
      if (starter.spawned_by_run !== null) {
        throw new Error(
          `Diese Session stammt selbst aus Lauf #${starter.spawned_by_run} und darf keine Läufe starten. Melde das Ergebnis stattdessen zurück.`,
        );
      }
      const since = new Date(Date.now() - 3600_000).toISOString();
      const started = this.db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE started_by_session_id = ? AND started_at >= ?")
        .get(o.startedBySessionId, since) as { n: number };
      const cap = Number(process.env.CREWPIP_RUNS_PER_HOUR ?? 20);
      if (started.n >= cap) throw new Error(`Diese Session hat in der letzten Stunde schon ${started.n} Läufe gestartet (Obergrenze ${cap}).`);
    }
    const appImpl = RUNNER_APPS[o.app];
    if (!appImpl) throw new Error(`Unbekannte App: ${o.app}`);
    if (!o.prompt.trim()) throw new Error("Leerer Auftrag");
    if (!RUN_MODES.includes(o.mode)) throw new Error(`Unbekannter Modus: ${o.mode}`);

    const task = o.taskId ? this.board.task(o.taskId) : null;
    if (o.taskId && !task) throw new Error(`Unbekannter Task: ${o.taskId}`);
    const projectId = task?.projectId ?? o.projectId;
    if (!projectId) throw new Error("Weder Task noch Projekt angegeben");
    const project = this.board.project(projectId);
    if (!project) throw new Error(`Unbekanntes Projekt: ${projectId}`);

    const cwd = path.resolve(o.cwd ?? task?.worktree?.path ?? project.root);
    if (!fs.existsSync(cwd)) throw new Error(`Verzeichnis fehlt: ${cwd}`);
    // Ein Lauf darf das Projekt nie verlassen.
    if (cwd !== project.root && !cwd.startsWith(project.root + path.sep)) {
      throw new Error(`${cwd} liegt außerhalb von ${project.root}`);
    }
    if (o.mode === "worktree-write" && cwd === project.root && !o.allowProjectRoot) {
      throw new Error(
        "Schreibende Läufe brauchen einen Worktree. Lege für den Task einen an, oder erlaube den Haupt-Checkout ausdrücklich.",
      );
    }
    const parallel = this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get() as { n: number };
    if (parallel.n >= (this.opts.maxParallel ?? 4)) throw new Error(`Es laufen bereits ${parallel.n} Agents. Erst einen beenden.`);
    // Zuletzt die Umgebung prüfen, damit Fehler im Auftrag zuerst gemeldet werden: ob das
    // Werkzeug hier installiert und angemeldet ist, kann der Aufrufer nicht besser machen,
    // eine fehlende Angabe schon.
    const bin = appImpl.bin();
    if (!bin) throw new Error(`${o.app} ist auf diesem Rechner nicht gefunden worden.`);
    if (this.available().find((a) => a.app === o.app)?.loggedIn === false) {
      throw new Error(`${o.app} ist nicht angemeldet. ${appImpl.loginHint}`);
    }
    return { appImpl, bin, cwd, projectId, taskId: o.taskId ?? null };
  }

  start(o: StartOptions): Run {
    const { appImpl, bin, cwd, projectId, taskId } = this.validate(o);
    fs.mkdirSync(this.opts.logDir, { recursive: true });
    const res = this.db
      .prepare("INSERT INTO runs(task_id, project_id, app, cwd, prompt, mode, started_by_session_id, log_path) VALUES (?, ?, ?, ?, ?, ?, ?, '')")
      .run(taskId, projectId, o.app, cwd, o.prompt.trim(), o.mode, o.startedBySessionId ?? null);
    const id = Number(res.lastInsertRowid);
    const logPath = path.join(this.opts.logDir, `${id}.jsonl`);
    this.db.prepare("UPDATE runs SET log_path = ? WHERE id = ?").run(logPath, id);

    // Schreibt der Lauf in einen CrewPip-Worktree, braucht ein Commit Stellen im gemeinsamen
    // Git-Verzeichnis, das außerhalb des Worktrees liegt.
    const task = taskId ? this.board.task(taskId) : null;
    const branch = task?.worktree && path.resolve(task.worktree.path) === path.resolve(cwd) ? task.worktree.branch : null;
    const gitWritable = o.mode === "worktree-write" && branch ? (git.worktreeCommitPaths(cwd, branch) ?? undefined) : undefined;

    const args = appImpl.args({ cwd, prompt: o.prompt.trim(), mode: o.mode, gitWritable });
    const child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // CREWPIP_RUN kennzeichnet den Lauf für Hooks; die eigene Session-Kennung des Daemons
      // wird nicht weitergereicht, damit der Agent nicht in fremde Postfächer schreibt.
      env: { ...process.env, CREWPIP_RUN: String(id), CREWPIP_SESSION_NAME: `Lauf #${id}` },
    });
    // Der Auftrag geht je nach Werkzeug über die Argumente oder über stdin; stdin wird in
    // jedem Fall geschlossen, sonst wartet ein Werkzeug wie Codex auf weitere Eingabe.
    if (appImpl.promptVia === "stdin") child.stdin!.end(o.prompt.trim());
    else child.stdin!.end();
    const log = fs.createWriteStream(logPath, { flags: "a" });
    let stderr = "";
    let summary: string | null = null;
    // Manche Werkzeuge melden Fehler über die Standardausgabe statt über stderr.
    let lastError: string | null = null;

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      log.write(line + "\n");
      const item = appImpl.parse(line);
      if (!item) return;
      if (item.kind === "message") summary = item.text;
      if (item.kind === "error") lastError = item.text;
      this.emit("item", id, item);
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });

    const timer = setTimeout(() => {
      this.opts.log?.(`[run] #${id} Zeit abgelaufen, wird beendet`);
      this.finish(id, "timeout", null, summary, stderr);
      child.kill("SIGKILL");
    }, this.opts.timeoutMs ?? Number(process.env.CREWPIP_RUN_TIMEOUT_MS ?? 30 * 60 * 1000));

    this.live.set(id, { child, timer });
    this.db.prepare("UPDATE runs SET pid = ? WHERE id = ?").run(child.pid ?? null, id);

    child.on("error", (err) => this.finish(id, "failed", null, summary, `${err.message}\n${stderr}`));
    child.on("close", (code, signal) => {
      log.end();
      // Das Zeitlimit gilt dem Agent-Prozess, und der ist jetzt beendet. Der anschließende Push
      // hat sein eigenes Limit; sonst könnte das Laufzeitlimit mitten im pre-push-Hook zuschlagen.
      const liveEntry = this.live.get(id);
      if (liveEntry) clearTimeout(liveEntry.timer);
      const stopped = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: RunStatus };
      if (stopped.status !== "running") return; // bereits als stopped/timeout verbucht
      const failedAuth = appImpl.authProblem(`${stderr}\n${summary ?? ""}\n${lastError ?? ""}`);
      const status: RunStatus = signal ? "stopped" : code === 0 && !failedAuth ? "done" : "failed";
      if (failedAuth) {
        // Der Hinweis ist wichtiger als die Rohmeldung, denn er sagt, was zu tun ist.
        this.finish(id, status, code, `Anmeldung fehlt. ${appImpl.loginHint}`, [lastError, stderr].filter(Boolean).join("\n"));
        return;
      }
      if (status === "done" && o.mode === "worktree-write" && branch) {
        void this.pushAfterRun(id, cwd, branch, code, summary ?? lastError, stderr);
        return;
      }
      this.finish(id, status, code, summary ?? lastError, stderr);
    });

    this.emit("runs");
    this.opts.log?.(`[run] #${id} ${o.app} (${o.mode}) in ${cwd}${o.startedBySessionId ? " — von einem Chat gestartet" : ""}`);
    return this.toRun(this.row(id));
  }

  /**
   * Nach einem erfolgreichen schreibenden Lauf pusht CrewPip den Branch selbst. Der Agent
   * darf nicht pushen, siehe WRITE_DENY. Ein roter pre-push-Hook macht den Lauf zum Fehlschlag:
   * das Abnahmekriterium ist ein gepushter Commit mit grünen Hooks, nicht ein beendeter Prozess.
   */
  private async pushAfterRun(id: number, cwd: string, branch: string, code: number | null, summary: string | null, stderr: string): Promise<void> {
    const ahead = git.commitsAhead(cwd, git.defaultBase(git.repoRoot(cwd) ?? cwd));
    if (ahead === 0) {
      this.db.prepare("UPDATE runs SET push_log = ? WHERE id = ?").run("nichts gepusht: der Lauf hat keinen Commit angelegt", id);
      this.finish(id, "done", code, summary, stderr);
      return;
    }
    this.emit("item", id, { kind: "command", text: `CrewPip: git push origin ${branch}`, at: new Date().toISOString() });
    const res = await git.pushBranch(cwd, branch);
    this.db
      .prepare("UPDATE runs SET push_log = ? WHERE id = ?")
      .run(`${res.ok ? "gepusht" : "PUSH FEHLGESCHLAGEN"}: origin/${branch}, ${ahead} Commit(s)\n\n${res.output}`, id);
    if (res.ok) {
      this.finish(id, "done", code, summary, stderr);
    } else {
      this.emit("item", id, { kind: "error", text: res.output, at: new Date().toISOString() });
      this.finish(id, "failed", code, `Die Arbeit ist committet, der Push aber gescheitert (meist ein roter pre-push-Hook).\n\n${res.output}`, stderr);
    }
  }

  private finish(id: number, status: RunStatus, code: number | null, summary: string | null, stderr: string): void {
    const current = this.db.prepare("SELECT status, ended_at FROM runs WHERE id = ?").get(id) as { status: RunStatus; ended_at: string | null } | undefined;
    if (current?.ended_at) return; // schon abgeschlossen, etwa durch Abbruch während des Pushs
    const entry = this.live.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.live.delete(id);
    }
    const text = summary ?? (stderr.trim() ? stderr.trim().split("\n").slice(-3).join("\n") : null);
    this.db
      .prepare("UPDATE runs SET status = ?, exit_code = ?, summary = ?, ended_at = ? WHERE id = ?")
      .run(status, code, text, new Date().toISOString(), id);
    if (status !== "done" && stderr.trim()) this.emit("item", id, { kind: "error", text: stderr.trim().slice(-1500), at: new Date().toISOString() });
    this.emit("runs");
    const run = this.toRun(this.row(id));
    if (run.startedBy) this.emit("finished", run);
    this.opts.log?.(`[run] #${id} ${status}${code === null ? "" : ` (exit ${code})`}`);
  }

  /** Nur wer einen Lauf angestoßen hat, darf ihn auch abbrechen. */
  ownedBy(id: number, sessionId: string): boolean {
    const r = this.db.prepare("SELECT started_by_session_id FROM runs WHERE id = ?").get(id) as { started_by_session_id: string | null } | undefined;
    return !!r && r.started_by_session_id === sessionId;
  }

  stop(id: number): Run {
    const entry = this.live.get(id);
    if (!entry) {
      const r = this.row(id);
      if (r.status === "running") this.finish(id, "stopped", null, r.summary, "");
      return this.toRun(this.row(id));
    }
    this.finish(id, "stopped", null, null, "");
    entry.child.kill("SIGTERM");
    setTimeout(() => {
      if (!entry.child.killed) entry.child.kill("SIGKILL");
    }, 5000).unref?.();
    return this.toRun(this.row(id));
  }

  stopAll(): void {
    for (const id of this.live.keys()) this.stop(id);
  }
}
