import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AppKind,
  type Project,
  type Task,
  type TaskStatus,
  TASK_STATUSES,
  projectRootOf,
  sessionLabel,
} from "@crewpip/shared";
import * as git from "./git.js";

export interface BoardEvents {
  tasks: [];
  projects: [];
}

interface ProjectRow {
  id: string;
  name: string;
  root: string;
  bootstrap: string | null;
  created_at: string;
  archived_at: string | null;
}

interface TaskRow {
  id: number;
  project_id: string;
  title: string;
  body: string;
  status: TaskStatus;
  assignee_session_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_created_at: string | null;
  bootstrap_log: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Erlaubte Statuswechsel. Ein erledigter Task wird nicht stillschweigend wiederbelebt. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ["claimed", "cancelled", "done"],
  claimed: ["review", "open", "done", "cancelled"],
  review: ["done", "claimed", "open", "cancelled"],
  done: ["open"],
  cancelled: ["open"],
};

export class Board extends EventEmitter<BoardEvents> {
  /** cwd -> Repository-Wurzel. Ändert sich zur Laufzeit nie, deshalb dauerhaft gecacht. */
  private readonly rootCache = new Map<string, string>();

  constructor(private readonly db: DatabaseSync) {
    super();
  }

  // ---- Projekte ---------------------------------------------------------

  /**
   * Findet oder legt das Projekt zu einem Arbeitsverzeichnis an. Maßgeblich ist die
   * Repository-Wurzel; eine Session in einem Worktree gehört damit zum Haupt-Repository.
   */
  resolveProject(cwd: string): Project {
    // realpath, weil git seinerseits aufgelöste Pfade liefert: sonst wäre /tmp/x ein anderes
    // Projekt als /private/tmp/x, obwohl es dasselbe Verzeichnis ist.
    const clean = Board.realpath(cwd);
    let root = this.rootCache.get(clean);
    if (root === undefined) {
      // git ist maßgeblich; ohne Repository trägt der Pfad die Information, etwa bei einem
      // Worktree unter <projekt>/.claude/worktrees/<name>.
      root = git.repoRoot(clean) ?? projectRootOf(clean);
      this.rootCache.set(clean, root);
    }
    const existing = this.db.prepare("SELECT * FROM projects WHERE root = ?").get(root) as ProjectRow | undefined;
    if (existing) return this.toProject(existing);
    const name = path.basename(root) || root;
    const id = this.freeProjectId(git.slug(name));
    this.db.prepare("INSERT INTO projects(id, name, root) VALUES (?, ?, ?)").run(id, name, root);
    this.emit("projects");
    return this.toProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow);
  }

  static realpath(p: string): string {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  }

  private freeProjectId(base: string): string {
    let id = base;
    for (let n = 2; this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id); n++) id = `${base}-${n}`;
    return id;
  }

  private toProject(r: ProjectRow): Project {
    const sessions = this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND ended_at IS NULL").get(r.id) as { n: number };
    const open = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('open','claimed','review')").get(r.id) as { n: number };
    return {
      id: r.id, name: r.name, root: r.root, bootstrap: r.bootstrap,
      createdAt: r.created_at, archivedAt: r.archived_at, sessions: sessions.n, openTasks: open.n,
    };
  }

  /** Bootstrap-Befehl eines Projekts setzen. Leer heißt: keiner. */
  setBootstrap(id: string, command: string | null): Project {
    if (!this.project(id)) throw new Error(`Unbekanntes Projekt: ${id}`);
    this.db.prepare("UPDATE projects SET bootstrap = ? WHERE id = ?").run(command?.trim() || null, id);
    this.emit("projects");
    return this.project(id)!;
  }

  projects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY name").all() as unknown as ProjectRow[];
    return rows.map((r) => this.toProject(r));
  }

  project(id: string): Project | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return r ? this.toProject(r) : null;
  }

  /** Alle git-Worktrees eines Projekts, auch die von Claude Code oder von Hand angelegten. */
  worktreesOf(projectId: string): { path: string; branch: string | null; managed: boolean }[] {
    const p = this.project(projectId);
    if (!p) return [];
    const managed = new Set(
      (this.db.prepare("SELECT worktree_path FROM tasks WHERE project_id = ? AND worktree_path IS NOT NULL").all(projectId) as unknown as { worktree_path: string }[]).map((t) => t.worktree_path),
    );
    return git.listWorktrees(p.root).map((w) => ({ path: w.path, branch: w.branch, managed: managed.has(w.path) }));
  }

  // ---- Tasks ------------------------------------------------------------

  private toTask(r: TaskRow): Task {
    const project = this.db.prepare("SELECT name FROM projects WHERE id = ?").get(r.project_id) as { name: string } | undefined;
    let assignee: Task["assignee"] = null;
    if (r.assignee_session_id) {
      const s = this.db
        .prepare("SELECT id, app, project, worktree, name FROM sessions WHERE id = ?")
        .get(r.assignee_session_id) as { id: string; app: AppKind; project: string; worktree: string | null; name: string } | undefined;
      if (s) assignee = { id: s.id, label: sessionLabel(s.app, s.project, s.name, s.worktree) };
    }
    return {
      id: r.id,
      projectId: r.project_id,
      projectName: project?.name ?? r.project_id,
      title: r.title,
      body: r.body,
      status: r.status,
      assignee,
      worktree: r.worktree_path ? { path: r.worktree_path, branch: r.worktree_branch ?? "", createdAt: r.worktree_created_at ?? "" } : null,
      bootstrapLog: r.bootstrap_log,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private row(id: number): TaskRow {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!r) throw new Error(`Unbekannter Task: ${id}`);
    return r;
  }

  task(id: number): Task | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return r ? this.toTask(r) : null;
  }

  tasks(filter: { projectId?: string; status?: TaskStatus[]; assignee?: string } = {}): Task[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId) {
      where.push("project_id = ?");
      args.push(filter.projectId);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      args.push(...filter.status);
    }
    if (filter.assignee) {
      where.push("assignee_session_id = ?");
      args.push(filter.assignee);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY CASE status WHEN 'claimed' THEN 0 WHEN 'review' THEN 1 WHEN 'open' THEN 2 ELSE 3 END, id DESC`,
      )
      .all(...(args as never[])) as unknown as TaskRow[];
    return rows.map((r) => this.toTask(r));
  }

  create(input: { projectId: string; title: string; body?: string; createdBy: string }): Task {
    const title = input.title.trim();
    if (!title) throw new Error("Leerer Titel");
    if (!this.project(input.projectId)) throw new Error(`Unbekanntes Projekt: ${input.projectId}`);
    const res = this.db
      .prepare("INSERT INTO tasks(project_id, title, body, created_by) VALUES (?, ?, ?, ?)")
      .run(input.projectId, title, (input.body ?? "").trim(), input.createdBy);
    this.emit("tasks");
    this.emit("projects");
    return this.toTask(this.row(Number(res.lastInsertRowid)));
  }

  update(id: number, patch: { title?: string; body?: string; status?: TaskStatus; assignee?: string | null }): Task {
    const cur = this.row(id);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new Error("Leerer Titel");
      sets.push("title = ?");
      args.push(t);
    }
    if (patch.body !== undefined) {
      sets.push("body = ?");
      args.push(patch.body.trim());
    }
    if (patch.status !== undefined && patch.status !== cur.status) {
      if (!TASK_STATUSES.includes(patch.status)) throw new Error(`Unbekannter Status: ${patch.status}`);
      if (!TRANSITIONS[cur.status].includes(patch.status)) {
        throw new Error(`Statuswechsel ${cur.status} → ${patch.status} ist nicht vorgesehen`);
      }
      sets.push("status = ?");
      args.push(patch.status);
      // Zurück in den Topf heißt: niemandem mehr zugewiesen. Bei erledigt und verworfen bleibt
      // die Zuweisung dagegen stehen — sonst ginge verloren, wer die Aufgabe bearbeitet hat.
      if (patch.status === "open") sets.push("assignee_session_id = NULL");
    }
    if (patch.assignee !== undefined) {
      if (patch.assignee && !this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(patch.assignee)) {
        throw new Error(`Unbekannte Session: ${patch.assignee}`);
      }
      sets.push("assignee_session_id = ?");
      args.push(patch.assignee);
    }
    if (!sets.length) return this.toTask(cur);
    sets.push("updated_at = ?");
    args.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]));
    this.emit("tasks");
    this.emit("projects");
    return this.toTask(this.row(id));
  }

  /** Übernimmt einen Task für eine Session. Ein bereits vergebener Task wird abgelehnt. */
  claim(id: number, sessionId: string): Task {
    const cur = this.row(id);
    if (cur.status === "done" || cur.status === "cancelled") throw new Error(`Task #${id} ist ${cur.status === "done" ? "erledigt" : "verworfen"}`);
    if (cur.assignee_session_id && cur.assignee_session_id !== sessionId) {
      const label = this.toTask(cur).assignee?.label ?? cur.assignee_session_id;
      throw new Error(`Task #${id} ist schon vergeben an ${label}`);
    }
    return this.update(id, { status: cur.status === "claimed" ? undefined : "claimed", assignee: sessionId });
  }

  // ---- Worktrees --------------------------------------------------------

  /** Legt für einen Task einen git-Worktree mit eigenem Branch an. */
  async createWorktree(id: number, opts: { base?: string } = {}): Promise<Task> {
    const cur = this.row(id);
    if (cur.worktree_path) throw new Error(`Task #${id} hat schon einen Worktree: ${cur.worktree_path}`);
    const project = this.project(cur.project_id);
    if (!project) throw new Error("Unbekanntes Projekt");
    if (!git.repoRoot(project.root)) throw new Error(`${project.root} ist kein git-Repository`);
    const name = `${id}-${git.slug(cur.title, 32)}`;
    const added = await git.addWorktree({
      root: project.root,
      dir: path.join(project.root, ".crewpip", "worktrees", name),
      branch: `crewpip/${name}`,
      base: opts.base,
    });
    this.db
      .prepare("UPDATE tasks SET worktree_path = ?, worktree_branch = ?, worktree_created_at = ?, updated_at = ? WHERE id = ?")
      .run(added.path, added.branch, new Date().toISOString(), new Date().toISOString(), id);
    this.emit("tasks");

    // Ein frischer Worktree hat kein node_modules: ohne Bootstrap läuft dort weder ein Test
    // noch ein Git-Hook. Der Worktree bleibt auch bei einem Fehlschlag bestehen, die Ausgabe
    // steht am Task, damit der Grund sichtbar ist statt später beim ersten Commit aufzuschlagen.
    if (project.bootstrap) {
      const res = await git.runBootstrap(added.path, project.bootstrap);
      this.db
        .prepare("UPDATE tasks SET bootstrap_log = ?, updated_at = ? WHERE id = ?")
        .run(`${res.ok ? "erfolgreich" : "FEHLGESCHLAGEN"}: ${project.bootstrap}\n\n${res.output}`, new Date().toISOString(), id);
      this.emit("tasks");
    }
    return this.toTask(this.row(id));
  }

  /**
   * Entfernt den Worktree eines Tasks. Ohne `force` bleibt er stehen, sobald nicht committete
   * Änderungen oder eigene Commits darin liegen; die Gründe stehen im Fehlertext.
   */
  async removeWorktree(id: number, opts: { force?: boolean } = {}): Promise<Task> {
    const cur = this.row(id);
    if (!cur.worktree_path) return this.toTask(cur);
    const project = this.project(cur.project_id);
    if (!project) throw new Error("Unbekanntes Projekt");
    const res = await git.removeWorktree(project.root, cur.worktree_path, opts);
    if (!res.removed) throw new Error(`Worktree nicht entfernt: ${res.blockers.join("; ")}. Mit force=true trotzdem entfernen.`);
    if (res.keptBranch) this.emit("tasks");
    this.db
      .prepare("UPDATE tasks SET worktree_path = NULL, worktree_branch = NULL, worktree_created_at = NULL, bootstrap_log = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    this.emit("tasks");
    return this.toTask(this.row(id));
  }

  /** Task, an dem eine Session laut Zuweisung oder laut ihrem Worktree arbeitet. */
  taskOfSession(sessionId: string, cwd: string): Task | null {
    const byAssignee = this.db
      .prepare("SELECT * FROM tasks WHERE assignee_session_id = ? AND status IN ('claimed','review') ORDER BY updated_at DESC LIMIT 1")
      .get(sessionId) as TaskRow | undefined;
    if (byAssignee) return this.toTask(byAssignee);
    const byWorktree = this.db.prepare("SELECT * FROM tasks WHERE worktree_path = ?").get(Board.realpath(cwd)) as TaskRow | undefined;
    return byWorktree ? this.toTask(byWorktree) : null;
  }
}
