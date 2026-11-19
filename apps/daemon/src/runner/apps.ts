import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppKind, RunItem, RunMode } from "@crewpip/shared";

/**
 * Anbindung je Coding-Werkzeug. Jede App bringt mit, wo ihr Programm liegt, wie ein
 * nicht-interaktiver Lauf aufgerufen wird und wie seine Ausgabezeilen zu lesen sind.
 */
export interface RunArgs {
  cwd: string;
  prompt: string;
  mode: RunMode;
  /**
   * Nur bei worktree-write in einem CrewPip-Worktree: die Stellen im gemeinsamen
   * Git-Verzeichnis, die ein Commit schreiben muss. Sie liegen außerhalb des Worktrees.
   */
  gitWritable?: string[];
}

/**
 * Grundstock an Befehlen für schreibende Läufe (Option A, entschieden am 18.09.2026).
 * Committen ja, pushen nein: den Push übernimmt CrewPip selbst, siehe Runner.
 *
 * Warum der Agent nicht pushen darf: Befehlsmuster lassen sich umgehen. Belegt am 18.09.2026
 * mit einem echten Lauf: `git push origin crewpip/x:main` ging trotz Verbotsregel durch und
 * schrieb auf main. Mit fester Argumentliste aus CrewPip ist das ausgeschlossen.
 */
export const WRITE_ALLOW = [
  "Bash(git add *)",
  "Bash(git commit *)",
  // Both spellings matter: the wildcard requires a space and misses the bare command.
  ...["status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "check-ignore"].flatMap(c => [
    `Bash(git ${c})`, `Bash(git ${c} *)`,
  ]),
  // Prüfbefehle. Kein pnpm run, pnpm exec oder pnpm dlx: das wären beliebige Skripte.
  ...["install", "test", "typecheck", "lint", "format", "format:check"].flatMap((c) => [
    `Bash(pnpm ${c})`,
    `Bash(pnpm ${c} *)`,
    `Bash(pnpm --filter * ${c})`,
    `Bash(pnpm --filter * ${c} *)`,
  ]),
];

/** Verbote gehen vor Erlaubnissen, auch vor denen aus den Projekteinstellungen. */
export const WRITE_DENY = ["Bash(git push)", "Bash(git push *)"];

export interface RunnerApp {
  id: AppKind;
  /** Pfad zum Programm oder null, wenn es hier nicht installiert ist. */
  bin(): string | null;
  args(o: RunArgs): string[];
  /**
   * Wie der Auftrag übergeben wird. Claude Codes --allowedTools nimmt beliebig viele Werte
   * und würde einen angehängten Auftrag als weiteres Muster verschlucken; deshalb über stdin.
   */
  promptVia: "argv" | "stdin";
  /** Wandelt eine Ausgabezeile in einen Eintrag für die Anzeige, oder null zum Überspringen. */
  parse(line: string): RunItem | null;
  /** Erkennt an der Ausgabe, dass die Anmeldung fehlt. */
  authProblem(text: string): boolean;
  /** Hinweis, wie die Anmeldung nachzuholen ist. */
  loginHint: string;
  /** Fragt das Programm, ob es angemeldet ist. null heißt: nicht feststellbar. */
  loggedIn(bin: string): boolean | null;
}

/**
 * Kurzer, harmloser Aufruf; Fehler bedeuten "nicht feststellbar". Beide Ausgabekanäle zählen:
 * Codex meldet den Anmeldestatus über stderr, Claude Code als JSON über stdout.
 */
function ask(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 8000 });
  if (r.error) return null;
  const merged = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  return merged || null;
}

function firstExisting(...candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      // weiter suchen
    }
  }
  return null;
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // weiter suchen
    }
  }
  return null;
}

const now = () => new Date().toISOString();

function executableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch { return false; }
}

function directories(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch { return []; }
}

/** launchd does not inherit the user's shell PATH; desktop installs also move on updates. */
function claudeBinary(): string | null {
  const inPath = onPath("claude");
  if (inPath && executableFile(inPath)) return inPath;
  const home = process.env.HOME;
  if (!home) return null;
  const native = path.join(home, ".local/bin/claude");
  if (executableFile(native)) return native;
  const root = path.join(home, "Library/Application Support/Claude/claude-code");
  const versions = directories(root).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => {
    const av = a.split(".").map(Number), bv = b.split(".").map(Number);
    return bv[0]! - av[0]! || bv[1]! - av[1]! || bv[2]! - av[2]!;
  });
  for (const version of versions) {
    const base = path.join(root, version);
    for (const dir of [base, ...directories(base).sort().map(d => path.join(base, d))]) {
      const candidate = path.join(dir, "claude.app/Contents/MacOS/claude");
      if (executableFile(candidate)) return candidate;
    }
  }
  return null;
}

export const codexApp: RunnerApp = {
  id: "codex",
  promptVia: "argv",
  bin: () => onPath("codex") ?? firstExisting("/Applications/ChatGPT.app/Contents/Resources/codex"),
  args: ({ cwd, prompt, mode, gitWritable }) => [
    "exec",
    "-C",
    cwd,
    "--skip-git-repo-check",
    "--json",
    "--sandbox",
    mode === "worktree-write" ? "workspace-write" : "read-only",
    // Die Sandbox lässt nur im Worktree schreiben, das Git-Verzeichnis liegt außerhalb. Frei
    // werden nur die Stellen, die ein Commit braucht — nicht config und nicht hooks, sonst
    // könnte der Agent die Git-Hooks abschalten. Netzwerk bleibt aus; gepusht wird von crewpip.
    // UNGEPRÜFT im Betrieb: am 18.09.2026 war das Codex-Kontingent erschöpft.
    ...(mode === "worktree-write" && gitWritable?.length
      ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(gitWritable)}`]
      : []),
    // Hooks laufen nur, wenn sie in Codex einmal per /hooks freigegeben wurden. Die Freigabe
    // wird hier bewusst nicht umgangen; ohne sie fehlt dem Lauf nur die Postfach-Zustellung.
    ...(process.env.CREWPIP_CODEX_BYPASS_HOOK_TRUST === "1" ? ["--dangerously-bypass-hook-trust"] : []),
    prompt,
  ],
  parse: (line) => {
    let j: { item?: { type?: string; text?: string; message?: string; command?: string; tool?: string; server?: string; status?: string } };
    try {
      j = JSON.parse(line) as typeof j;
    } catch {
      return null;
    }
    const it = j.item;
    if (!it?.type) return null;
    if (it.type === "agent_message" && it.text) return { kind: "message", text: it.text, at: now() };
    if (it.type === "error" && it.message) return { kind: "error", text: it.message, at: now() };
    if (it.type === "command_execution" && it.command && it.status !== "in_progress") {
      return { kind: "command", text: it.command, at: now() };
    }
    if (it.type === "mcp_tool_call" && it.tool && it.status !== "in_progress") {
      return { kind: "tool", text: `${it.server ?? "mcp"} · ${it.tool}`, at: now() };
    }
    return null;
  },
  authProblem: (t) => /not logged in|please run .?codex login|unauthorized/i.test(t),
  loginHint: "In einem Terminal `codex login` ausführen; die ChatGPT-App teilt ihre Anmeldung mit dem CLI.",
  loggedIn: (bin) => {
    const out = ask(bin, ["login", "status"]);
    return out === null ? null : /logged in/i.test(out);
  },
};

export const claudeApp: RunnerApp = {
  id: "claude",
  promptVia: "stdin",
  bin: claudeBinary,
  args: ({ mode }) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    // "plan" darf nichts ändern, "acceptEdits" darf im Arbeitsverzeichnis schreiben.
    mode === "worktree-write" ? "acceptEdits" : "plan",
    "--max-turns",
    process.env.CREWPIP_CLAUDE_MAX_TURNS ?? "40",
    ...(mode === "worktree-write" ? ["--allowedTools", ...WRITE_ALLOW, "--disallowedTools", ...WRITE_DENY] : []),
    // Kein Auftrag hier: er kommt über stdin, siehe promptVia.
  ],
  parse: (line) => {
    let j: {
      type?: string;
      is_error?: boolean;
      result?: string;
      message?: { content?: { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[] };
    };
    try {
      j = JSON.parse(line) as typeof j;
    } catch {
      return null;
    }
    if (j.type === "assistant" && j.message?.content) {
      const texts = j.message.content.filter((c) => c.type === "text" && c.text).map((c) => c.text!);
      if (texts.length) return { kind: "message", text: texts.join("\n"), at: now() };
      const tool = j.message.content.find((c) => c.type === "tool_use" && c.name);
      if (tool) {
        const cmd = (tool.input as { command?: string } | undefined)?.command;
        return { kind: cmd ? "command" : "tool", text: cmd ?? tool.name!, at: now() };
      }
    }
    if (j.type === "result" && j.is_error && j.result) return { kind: "error", text: j.result, at: now() };
    return null;
  },
  authProblem: (t) => /not logged in|please run \/login|invalid api key/i.test(t),
  loginHint:
    "Mit dem von CrewPip gefundenen Claude-Programm `auth status` prüfen und bei Bedarf `auth login` ausführen. " +
    "Die Anmeldung der Desktop-App allein belegt keine CLI-Anmeldung; vor einem Lauf auch die Abrechnungsart prüfen.",
  loggedIn: (bin) => {
    const out = ask(bin, ["auth", "status"]);
    if (out === null) return null;
    try {
      return (JSON.parse(out) as { loggedIn?: boolean }).loggedIn === true;
    } catch {
      return /logged\s*in["\s:]*true/i.test(out);
    }
  },
};

export const RUNNER_APPS: Record<string, RunnerApp> = { codex: codexApp, claude: claudeApp };
