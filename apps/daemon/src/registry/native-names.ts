import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppKind } from "@crewpip/shared";

export interface NameIndex {
  titles: Map<string, string>;
  projects: Map<string, string>;
}

function title(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function same(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && Array.from(a).every(([key, value]) => b.get(key) === value);
}

async function directories(root: string): Promise<string[]> {
  const items = await fs.readdir(root, { withFileTypes: true });
  return items.filter(e => e.isDirectory()).map(e => path.join(root, e.name));
}

interface ClaudeFile {
  stamp: number;
  bytes: number;
  id: string | null;
  title: string | null;
}

/** Liest ausschließlich lokale App-Metadaten. Im Speicher bleiben nur Namen und Zuordnungen. */
export class NativeNames implements NameIndex {
  titles = new Map<string, string>();
  projects = new Map<string, string>();
  private claudeFiles = new Map<string, ClaudeFile>();

  constructor(
    private readonly codex = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    private readonly claude = path.join(os.homedir(), "Library/Application Support/Claude/claude-code-sessions"),
  ) {}

  private async claudeTitles(): Promise<Map<string, string>> {
    const next = new Map<string, ClaudeFile>();
    const groups = await directories(this.claude);
    for (const group of groups) {
      for (const dir of await directories(group)) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !/^local_[\w-]+\.json$/.test(entry.name)) continue;
          const file = path.join(dir, entry.name);
          const old = this.claudeFiles.get(file);
          try {
            const { mtimeMs, size } = await fs.stat(file);
            if (old && old.stamp === mtimeMs && old.bytes === size) {
              next.set(file, old);
              continue;
            }
            const data = JSON.parse(await fs.readFile(file, "utf8"));
            next.set(file, { stamp: mtimeMs, bytes: size, id: title(data.cliSessionId), title: title(data.title) });
          } catch {
            if (old) next.set(file, old); // Atomarer Ersatz oder gerade im Schreiben.
          }
        }
      }
    }
    this.claudeFiles = next;
    const names = new Map<string, string>();
    for (const f of [...next.values()].sort((a, b) => a.stamp - b.stamp)) {
      if (f.id && f.title) names.set(`claude:${f.id}`, f.title);
    }
    return names;
  }

  /** Außerhalb des Anfragepfads, mit je einem Lesezugriff auf geänderte Claude-Dateien. */
  async refresh(sessions: ReadonlyArray<{ id: string; app: AppKind }>): Promise<boolean> {
    const ids = new Set(sessions.filter(s => s.app === "codex").map(s => s.id));
    const next = new Map<string, string>();
    const projectNames = new Map<string, string>();
    // Der letzte gültige Eintrag je Chat ist die letzte Umbenennung im Codex-Index.
    try {
      const lines = (await fs.readFile(path.join(this.codex, "session_index.jsonl"), "utf8")).split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const data = JSON.parse(line);
          const name = title(data.thread_name);
          if (ids.has(data.id) && name) next.set(`codex:${data.id}`, name);
        } catch { /* Einen unvollständigen Eintrag beim nächsten Durchlauf erneut lesen. */ }
      }
    } catch { /* Der Index ist optional. */ }

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path.join(this.codex, "state_5.sqlite"), { readOnly: true });
      for (const row of db.prepare("SELECT path, name FROM project_roots JOIN projects ON project_id = id ORDER BY projects.position, project_roots.position").all()) {
        const name = title(row.name);
        if (name && typeof row.path === "string") {
          const root = await fs.realpath(row.path).catch(() => path.resolve(String(row.path)));
          if (!projectNames.has(root)) projectNames.set(root, name);
        }
      }
      const get = db.prepare("SELECT name FROM threads WHERE id = ?");
      for (const id of ids) {
        const name = title(get.get(id)?.name);
        if (name) next.set(`codex:${id}`, name);
      }
    } catch { /* Andere Schema-Version oder kein Desktop. Der Titelindex bleibt nutzbar. */ }
    finally { db?.close(); }

    try {
      const claudeNames = await this.claudeTitles();
      for (const s of sessions) {
        const key = `claude:${s.id}`;
        const name = s.app === "claude" ? claudeNames.get(key) : undefined;
        if (name) next.set(key, name);
      }
    } catch { /* Claude Desktop ist optional. Der bestehende CLI-Registryabgleich bleibt aktiv. */ }
    const changed = !same(this.titles, next) || !same(this.projects, projectNames);
    this.titles = next;
    this.projects = projectNames;
    return changed;
  }
}
