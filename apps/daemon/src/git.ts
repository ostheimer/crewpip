import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Schmale, bewusst harmlose git-Hülle. Ausgeführt wird nur über execFile ohne Shell, mit
 * Zeitlimit und fester Argumentliste; es gibt keinen Aufruf, der Commits, Branches oder
 * Arbeitsstände zerstören kann. `worktree remove` prüft vorher auf ungesicherte Änderungen.
 */
export class GitError extends Error {}

const execFileAsync = promisify(execFile);

/** Asynchron, für alles, was länger dauern kann: sonst steht der ganze Daemon still. */
async function gitAsync(cwd: string, args: string[], timeout = 120000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new GitError((err.stderr || err.message || "git-Fehler").toString().trim().split("\n")[0]!);
  }
}

function git(cwd: string, args: string[], timeout = 15000): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new GitError((err.stderr || err.message || "git-Fehler").toString().trim().split("\n")[0]!);
  }
}

/** Wurzel des Haupt-Repositories, auch wenn cwd ein Worktree ist. null, wenn kein Repository. */
export function repoRoot(cwd: string): string | null {
  try {
    const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 5000);
    if (!commonDir) return null;
    // <repo>/.git -> <repo>; bei bare-Repos bleibt der Pfad selbst stehen.
    return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  } catch {
    return null;
  }
}

export function currentBranch(cwd: string): string | null {
  try {
    return git(cwd, ["branch", "--show-current"], 5000) || null;
  } catch {
    return null;
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
}

export function listWorktrees(root: string): WorktreeInfo[] {
  let out: string;
  try {
    out = git(root, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const trees: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? null });
      cur = { path: line.slice(9) };
    } else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? null });
  return trees;
}

/** Nicht committete Änderungen im Arbeitsverzeichnis. Leer heißt sauber. */
export function dirtyFiles(cwd: string): string[] {
  try {
    const out = git(cwd, ["status", "--porcelain"]);
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

/** Commits, die auf dem Branch liegen, aber nicht in `base`. */
export function commitsAhead(cwd: string, base: string): number {
  try {
    return Number(git(cwd, ["rev-list", "--count", `${base}..HEAD`])) || 0;
  } catch {
    return 0;
  }
}

export function branchExists(root: string, branch: string): boolean {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], 5000);
    return true;
  } catch {
    return false;
  }
}

export function defaultBase(root: string): string {
  for (const candidate of ["main", "master"]) if (branchExists(root, candidate)) return candidate;
  return "HEAD";
}

export interface AddWorktreeOptions {
  root: string;
  /** Zielverzeichnis, üblicherweise <root>/.crewpip/worktrees/<slug> */
  dir: string;
  branch: string;
  /** Branch oder Commit, von dem abgezweigt wird */
  base?: string;
}

/** Legt einen Worktree mit neuem Branch an. Bestehende Pfade oder Branches werden abgelehnt. */
export async function addWorktree(o: AddWorktreeOptions): Promise<{ path: string; branch: string; base: string }> {
  if (fs.existsSync(o.dir)) throw new GitError(`Verzeichnis existiert bereits: ${o.dir}`);
  if (branchExists(o.root, o.branch)) throw new GitError(`Branch existiert bereits: ${o.branch}`);
  const base = o.base || defaultBase(o.root);
  fs.mkdirSync(path.dirname(o.dir), { recursive: true });
  await gitAsync(o.root, ["worktree", "add", "-b", o.branch, o.dir, base]);
  return { path: o.dir, branch: o.branch, base };
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** Gründe, warum nicht entfernt wurde (nur ohne force) */
  blockers: string[];
  /** Branch, der stehen bleibt, weil er eigene Commits trägt */
  keptBranch?: string;
}

/**
 * Entfernt einen Worktree. Ohne `force` wird abgelehnt, wenn nicht committete Änderungen
 * oder Commits vorliegen, die nicht in `base` enthalten sind — sonst ginge Arbeit verloren.
 */
export async function removeWorktree(root: string, dir: string, opts: { force?: boolean; base?: string } = {}): Promise<RemoveWorktreeResult> {
  if (!fs.existsSync(dir)) {
    try {
      await gitAsync(root, ["worktree", "prune"], 30000);
    } catch {
      // Aufräumen ist Kür.
    }
    return { removed: true, blockers: [] };
  }
  const blockers: string[] = [];
  if (!opts.force) {
    const dirty = dirtyFiles(dir);
    if (dirty.length) blockers.push(`${dirty.length} nicht committete Änderung(en)`);
    const ahead = commitsAhead(dir, opts.base || defaultBase(root));
    if (ahead) blockers.push(`${ahead} Commit(s) nicht in ${opts.base || defaultBase(root)}`);
    if (blockers.length) return { removed: false, blockers };
  }
  const branch = currentBranch(dir);
  const base = opts.base || defaultBase(root);
  // Vor dem Entfernen messen: danach ist das Verzeichnis weg.
  const ownCommits = branch ? commitsAhead(dir, base) : 0;
  await gitAsync(root, ["worktree", "remove", ...(opts.force ? ["--force"] : []), dir]);
  if (branch && ownCommits === 0) {
    // Der Branch ist inhaltlich identisch mit base, also nichts zu verlieren.
    try {
      await gitAsync(root, ["branch", "-d", branch], 15000);
      return { removed: true, blockers: [] };
    } catch {
      return { removed: true, blockers: [], keptBranch: branch };
    }
  }
  return { removed: true, blockers: [], ...(branch ? { keptBranch: branch } : {}) };
}

export interface BootstrapResult {
  ok: boolean;
  /** Letzte Zeilen der Ausgabe, für die Anzeige. */
  output: string;
}

/**
 * Führt den Bootstrap-Befehl eines Projekts in einem frischen Worktree aus.
 *
 * Der Befehl kommt aus CrewPips eigener Ablage, nicht aus dem Repository: sonst würde ein
 * Repository bestimmen, was der Daemon ausführt. Er läuft über die Shell, weil solche Befehle
 * üblicherweise Ketten sind (`pnpm install && pnpm --filter x build`).
 *
 * `set -e` ist dabei entscheidend: ohne das liefert eine mit `;` verkettete Zeile den Status
 * des letzten Befehls, und ein fehlgeschlagenes `pnpm install` in der Mitte gälte als Erfolg.
 */
export async function runBootstrap(dir: string, command: string, timeoutMs = 600000): Promise<BootstrapResult> {
  const trimmed = command.trim();
  if (!trimmed) return { ok: true, output: "" };
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", `set -e\n${trimmed}`], {
      cwd: dir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: tail(`${stdout}\n${stderr}`) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    // Nodes Fehlermeldung wiederholt den kompletten Befehl; das ist im Protokoll nur Rauschen.
    // Sie kommt nur zum Zug, wenn das Programm selbst nichts ausgegeben hat.
    const both = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    return { ok: false, output: tail(both || (err.message ?? "ohne Ausgabe fehlgeschlagen")) };
  }
}

function tail(text: string, lines = 40): string {
  return text.trim().split("\n").slice(-lines).join("\n").slice(-4000);
}

/**
 * Die Stellen im gemeinsamen Git-Verzeichnis, die ein Commit in diesem Worktree schreibt.
 * Gemessen am 18.09.2026: objects, der eigene Branch unter refs/heads und logs/refs/heads,
 * und das Verwaltungsverzeichnis des Worktrees. config und hooks bleiben außen vor.
 */
export function worktreeCommitPaths(worktreeDir: string, branch: string): string[] | null {
  let gitFile: string;
  try {
    gitFile = fs.readFileSync(path.join(worktreeDir, ".git"), "utf8").trim();
  } catch {
    return null;
  }
  // Ein Worktree hat statt eines .git-Verzeichnisses eine Datei "gitdir: <common>/worktrees/<name>".
  const m = gitFile.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const adminDir = path.resolve(worktreeDir, m[1]!.trim());
  const commonDir = path.resolve(adminDir, "..", "..");
  const branchDir = path.dirname(branch); // "crewpip" für "crewpip/10-titel"
  return [
    path.join(commonDir, "objects"),
    path.join(commonDir, "refs", "heads", branchDir),
    path.join(commonDir, "logs", "refs", "heads", branchDir),
    adminDir,
  ];
}

export interface PushResult {
  ok: boolean;
  output: string;
}

/**
 * Pusht genau diesen einen Branch, mit fester Argumentliste und ohne Shell. Der pre-push-Hook
 * des Projekts läuft dabei mit; ein roter Hook lässt den Push scheitern, und das ist gewollt.
 */
export async function pushBranch(worktreeDir: string, branch: string, timeoutMs = 20 * 60 * 1000): Promise<PushResult> {
  if (!/^crewpip\/[\w.-]+$/.test(branch)) {
    return { ok: false, output: `Gepusht werden nur CrewPip-Branches, nicht ${branch}` };
  }
  // Trace2 records the actual hook subprocess, independent of its output and build cache.
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-push-trace-"));
  const tracePath = path.join(traceDir, "events.jsonl");
  let ok = false;
  let output = "";
  try {
    const result = await execFileAsync("git", ["-C", worktreeDir, "push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], {
      encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TRACE2_EVENT: tracePath },
    });
    ok = true;
    output = tail(`${result.stdout}\n${result.stderr}`);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = tail(`${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() || err.message || "Push ohne Ausgabe fehlgeschlagen");
  }
  try {
    const trace = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : "";
    return { ok, output: `${output}\n\n${prePushEvidence(trace)}` };
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true });
  }
}

/** Match by Git session AND child id: nested Git processes reuse child ids. */
export function prePushEvidence(trace: string): string {
  type Event = { event?: string; child_class?: string; hook_name?: string; child_id?: number; sid?: string; time?: string; code?: number; t_rel?: number };
  const events: Event[] = trace.split("\n").flatMap(line => { try { return [JSON.parse(line) as Event]; } catch { return []; } });
  const starts = events.filter(e => e.event === "child_start" && e.child_class === "hook" && e.hook_name === "pre-push");
  if (!starts.length) return "pre-push: keine Ausführung im Git-Trace belegt (kein Hook oder Push vorher abgebrochen).";
  return starts.map(start => {
    const end = events.find(e => e.event === "child_exit" && e.sid === start.sid && e.child_id === start.child_id);
    const duration = end?.t_rel != null ? `${end.t_rel.toFixed(3)} s` : "nicht belegt";
    return `pre-push: Start ${start.time ?? "unbekannt"} | Ende ${end?.time ?? "nicht belegt"} | Exit ${end?.code ?? "unbekannt"} | Dauer ${duration}\nHook-Aufruf tatsächlich ausgeführt; interne Test-/Turbo-Cache-Treffer sind davon unabhängig.`;
  }).join("\n");
}

export function slug(v: string, max = 40): string {
  const s = v
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "task";
}
