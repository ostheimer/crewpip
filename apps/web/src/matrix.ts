import type { AppKind, ConnectionState, Project, Session } from "@crewpip/shared";

/** Feste Reihenfolge der Spalten; es erscheinen nur Apps, die auf diesem Mac vorkommen. */
export const APP_ORDER: AppKind[] = ["claude", "codex", "cursor", "antigravity", "other"];

const STATE_ORDER: Record<ConnectionState, number> = { connected: 0, "no-hook": 1, stale: 2, ended: 3 };

export interface MatrixRow {
  id: string;
  name: string;
  /** Chats je App, die besten zuerst (verbunden, dann ohne Hook, dann veraltet, jüngster Kontakt zuerst). */
  cells: Partial<Record<AppKind, Session[]>>;
  sessions: Session[];
  pm: Session | undefined;
  /** Beendete Chats zählen nicht. Der Director gilt für alle Repos, hier der beste Treffer. */
  director: Session | undefined;
  connected: number;
  /** PM oder Director dieser Zeile sind „Ohne Hook“: Post erreicht sie nicht von selbst. */
  alert: boolean;
}

export interface Matrix {
  apps: AppKind[];
  rows: MatrixRow[];
  /** Repos ohne lebenden Chat. */
  withoutChat: Project[];
}

const byQuality = (a: Session, b: Session) => STATE_ORDER[a.connection] - STATE_ORDER[b.connection] || b.lastSeenAt.localeCompare(a.lastSeenAt);

/**
 * Matrix Repo × App aus den Chats. Reine Ableitung: Namen, Rollen und Zustände kommen unverändert
 * aus der Session (Feld `name`, `role`, `connection`); hier wird nichts neu berechnet oder umbenannt.
 */
export function buildMatrix(sessions: Session[], projects: Project[], projectId: string | null): Matrix {
  const live = sessions.filter(s => s.connection !== "ended");
  const director = live.filter(s => s.role === "director").sort(byQuality)[0];
  const groups = new Map<string, { name: string; sessions: Session[] }>();
  for (const s of live) {
    if (projectId && s.projectId !== projectId) continue;
    const g = groups.get(s.projectId) ?? { name: s.project, sessions: [] };
    g.sessions.push(s);
    groups.set(s.projectId, g);
  }
  const rows: MatrixRow[] = [...groups.entries()].map(([id, g]) => {
    const sorted = [...g.sessions].sort(byQuality);
    const cells: MatrixRow["cells"] = {};
    for (const s of sorted) (cells[s.app] ??= []).push(s);
    const pm = sorted.find(s => s.role === "pm");
    const holders = [pm, sorted.find(s => s.role === "director") ?? (director?.projectId === id ? director : undefined)];
    return {
      id, name: g.name, cells, sessions: sorted, pm, director,
      connected: sorted.filter(s => s.connection === "connected").length,
      alert: holders.some(h => h?.connection === "no-hook"),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const present = new Set(rows.flatMap(r => r.sessions.map(s => s.app)));
  return {
    apps: APP_ORDER.filter(a => present.has(a)),
    rows,
    withoutChat: projects.filter(p => !groups.has(p.id) && (!projectId || p.id === projectId)),
  };
}
