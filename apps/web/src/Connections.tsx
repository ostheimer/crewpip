import { useId, useState } from "react";
import { APP_LABELS, ROLE_LABELS, type AppKind, type MessageFlow, type Project, type Session } from "@crewpip/shared";
import { CircleHelp } from "lucide-react";
import { useBoardLanguage } from "./language.tsx";
import { AppMark, APP_SHAPES } from "./AppMark.tsx";

/** Diese Apps bekommen immer eine Spalte, damit sichtbar ist, wo kein Chat arbeitet. */
const MAIN_APPS: AppKind[] = ["claude", "codex"];
const STATE_ORDER = { connected: 0, "no-hook": 1, stale: 2, ended: 3 } as const;

const time = (iso: string, locale: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(locale, sameDay ? { timeStyle: "short" } : { dateStyle: "short", timeStyle: "short" });
};

/** Zustand mit Erklärung, die bei Mausberührung und bei Tastaturfokus erscheint. */
function StateBadge({ session }: { session: Session }) {
  const { ui } = useBoardLanguage();
  const id = `conn-hint-${useId().replace(/[^\w-]/g, "")}`;
  // Escape blendet die Erklärung aus (WCAG 1.4.13); beim nächsten Fokus oder Hovern ist sie wieder da.
  const [hidden, setHidden] = useState(false);
  return <span className={`conn-state-wrap ${hidden ? "tip-hidden" : ""}`} onMouseLeave={() => setHidden(false)}>
    <span tabIndex={0} className={`conn-state conn-${session.connection}`} aria-describedby={id}
      onKeyDown={e => { if (e.key === "Escape") setHidden(true); }} onBlur={() => setHidden(false)}><i aria-hidden="true" />{ui.connectionState[session.connection]}<CircleHelp size={13} aria-hidden="true" /></span>
    <span role="tooltip" id={id} className="conn-tip">{ui.connectionHint[session.connection]}</span>
  </span>;
}

function RoleHolder({ label, holder }: { label: string; holder: Session | undefined }) {
  const { ui } = useBoardLanguage();
  return <p className={`conn-role ${holder ? "" : "missing"}`}><span>{label}:</span> {holder
    ? <><strong>{holder.name} ({APP_LABELS[holder.app]})</strong> <StateBadge session={holder} /></>
    : <strong>{ui.notAssigned}</strong>}</p>;
}

const short = (s: string, n = 15) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * Stern: CrewPip in der Mitte, jeder Chat des Repos als Speiche (durchgezogen = Post kommt an,
 * gestrichelt = sonst). Bögen zwischen zwei Chats zeigen Nachrichten der letzten 24 Stunden.
 * Die Liste darunter nennt dieselben Wege als Text; die Grafik ist ihre Übersicht.
 */
function StarGraph({ name, sessions, flows }: { name: string; sessions: Session[]; flows: MessageFlow[] }) {
  const { ui } = useBoardLanguage();
  const W = 520, H = 300, cx = W / 2, cy = H / 2, rx = 120, ry = 100;
  // Ab neun Chats abwechselnd auf zwei Ringen, damit Symbole und Namen nicht übereinander liegen.
  const twoRings = sessions.length > 8;
  const pos = new Map(sessions.map((s, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(sessions.length, 1);
    const f = twoRings && i % 2 ? 0.62 : 1;
    return [s.id, { x: cx + rx * f * Math.cos(a), y: cy + ry * f * Math.sin(a), a }];
  }));
  const edges = flows.flatMap(f => f.from.kind === "session" && pos.has(f.from.id) && pos.has(f.to.id) && f.from.id !== f.to.id ? [{ from: f.from.id, to: f.to.id, count: f.count }] : []);
  const pairs = new Set(edges.map(e => `${e.from}>${e.to}`));
  const markerId = `arrow-${useId().replace(/[^\w-]/g, "")}`;
  return <div className="graph-scroll" tabIndex={0} role="group" aria-label={ui.graphScroll}><svg className="conn-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ui.graphLabel(name, sessions.length, edges.length)}>
    <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="graph-arrow" /></marker></defs>
    {sessions.map(s => { const p = pos.get(s.id)!; return <line key={s.id} className={`graph-spoke conn-${s.connection}`} x1={cx} y1={cy} x2={p.x} y2={p.y} />; })}
    {edges.map(e => {
      const a = pos.get(e.from)!, b = pos.get(e.to)!;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // Gemeinsame Normale je Paar (unabhängig von der Richtung); Hin- und Rückweg liegen auf
      // verschiedenen Seiten, damit sich Bögen und Zahlen nicht verdecken.
      const [p, q] = e.from < e.to ? [a, b] : [b, a];
      const dl = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const nx = -(q.y - p.y) / dl, ny = (q.x - p.x) / dl;
      const side = pairs.has(`${e.to}>${e.from}`) ? (e.from < e.to ? 1 : -1) : 0;
      let ox = mx - cx, oy = my - cy;
      const ol = Math.hypot(ox, oy);
      let bend: number;
      if (ol < 20) { ox = nx; oy = ny; bend = 110 * (side || 1); }
      else { ox /= ol; oy /= ol; bend = 60; }
      const qx = mx + ox * bend + nx * side * 26, qy = my + oy * bend + ny * side * 26;
      // Anfang und Ende vor dem Knotensymbol, damit die Pfeilspitze sichtbar bleibt.
      const cut = (from: { x: number; y: number }, by: number) => { const l = Math.hypot(qx - from.x, qy - from.y) || 1; return { x: from.x + ((qx - from.x) / l) * by, y: from.y + ((qy - from.y) / l) * by }; };
      const s0 = cut(a, 10), s1 = cut(b, 12);
      return <g key={`${e.from}>${e.to}`} className="graph-edge">
        <path d={`M${s0.x},${s0.y} Q${qx},${qy} ${s1.x},${s1.y}`} markerEnd={`url(#${markerId})`} />
        <text x={(mx + qx) / 2} y={(my + qy) / 2 + 4} className="graph-count">{e.count}</text>
      </g>;
    })}
    <g className="graph-hub"><rect x={cx - 52} y={cy - 18} width={104} height={36} /><text x={cx} y={cy + 5}>CrewPip</text></g>
    {sessions.map(s => {
      const p = pos.get(s.id)!;
      const right = Math.cos(p.a) > 0.25, left = Math.cos(p.a) < -0.25;
      const lx = p.x + (right ? 14 : left ? -14 : 0), ly = p.y + (right || left ? 5 : Math.sin(p.a) > 0 ? 24 : -14);
      return <g key={s.id} className={`graph-node app-${s.app} conn-${s.connection}`}>
        <g transform={`translate(${p.x - 8},${p.y - 8})`}>{APP_SHAPES[s.app](16)}</g>
        <text x={lx} y={ly} textAnchor={right ? "start" : left ? "end" : "middle"}>{short(s.name)}</text>
      </g>;
    })}
  </svg></div>;
}

function FlowEnd({ end, projectId, live }: { end: MessageFlow["from"] | MessageFlow["to"]; projectId: string; live: Set<string> }) {
  const { ui } = useBoardLanguage();
  if ("kind" in end && end.kind === "human") return <span className="flow-end"><span className="badge app-human">{ui.person}</span> {end.name}</span>;
  return <span className="flow-end"><AppMark app={end.app} /> <strong>{end.projectId === projectId ? end.name : `${end.project} / ${end.name}`}</strong>{!live.has(end.id) && <em className="flow-ended"> ({ui.flowEnded})</em>}</span>;
}

/**
 * Pro Repo: welche Chats mit CrewPip verbunden sind, wer PM und Director ist, und welche Chats
 * in den letzten 24 Stunden tatsächlich Post über CrewPip ausgetauscht haben.
 */
export function Connections({ sessions, projects, projectId, flows }: { sessions: Session[]; projects: Project[]; projectId: string | null; flows: MessageFlow[] }) {
  const { ui, locale } = useBoardLanguage();
  const live = sessions.filter(s => s.connection !== "ended");
  const liveIds = new Set(live.map(s => s.id));
  const director = live.filter(s => s.role === "director").sort((a, b) => STATE_ORDER[a.connection] - STATE_ORDER[b.connection])[0];
  const groups = new Map<string, { name: string; sessions: Session[] }>();
  for (const s of live) {
    if (projectId && s.projectId !== projectId) continue;
    const g = groups.get(s.projectId) ?? { name: s.project, sessions: [] };
    g.sessions.push(s);
    groups.set(s.projectId, g);
  }
  const ordered = [...groups.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const withoutChat = projects.filter(p => !groups.has(p.id) && (!projectId || p.id === projectId));

  return <section className="connections" aria-labelledby="connections-title">
    <div className="section-heading"><div><h2 id="connections-title">{ui.connectionsTitle}</h2><p>{ui.connectionsIntro}</p></div></div>
    <div className="conn-grid">
      {ordered.map(([id, g]) => {
        const connected = g.sessions.filter(s => s.connection === "connected").length;
        const pm = g.sessions.filter(s => s.role === "pm").sort((a, b) => STATE_ORDER[a.connection] - STATE_ORDER[b.connection] || b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
        const apps = [...MAIN_APPS, ...new Set(g.sessions.map(s => s.app).filter(a => !MAIN_APPS.includes(a)))];
        const graphSessions = [...g.sessions].sort((a, b) => a.app.localeCompare(b.app) || a.name.localeCompare(b.name));
        const mine = flows.filter(f => f.to.projectId === id || (f.from.kind === "session" && f.from.projectId === id));
        return <section key={id} role="group" aria-label={g.name} className={`conn-project ${connected ? "" : "conn-none"}`}>
          <header><h3>{g.name}</h3><span className="conn-count">{connected ? ui.connectedCount(connected, g.sessions.length) : ui.noConnectedChat}</span></header>
          <div className="conn-roles"><RoleHolder label="PM" holder={pm} /><RoleHolder label="Director" holder={director} /></div>
          <StarGraph name={g.name} sessions={graphSessions} flows={mine} />
          <p className="graph-legend">{ui.graphLegend}</p>
          <div className="conn-flows"><h4>{ui.flowsTitle}</h4>
            {mine.length
              ? <ul aria-label={ui.flowsTitle}>{mine.map(f => <li key={`${f.from.kind === "session" ? f.from.id : f.from.name}>${f.to.id}`}>
                  <FlowEnd end={f.from} projectId={id} live={liveIds} /> <span aria-hidden="true">→</span><span className="sr-only">{ui.flowTo}</span> <FlowEnd end={f.to} projectId={id} live={liveIds} />
                  <span className="flow-meta"> · {ui.flowCount(f.count)} · {ui.flowLast} {time(f.lastAt, locale)}</span>
                </li>)}</ul>
              : <p className="conn-empty">{ui.noFlows}</p>}
          </div>
          <div className="conn-apps">{apps.map(app => {
            const chats = g.sessions.filter(s => s.app === app).sort((a, b) => STATE_ORDER[a.connection] - STATE_ORDER[b.connection] || b.lastSeenAt.localeCompare(a.lastSeenAt));
            return <div key={app} className={`conn-app app-col-${app}`}>
              <h4><AppMark app={app} /></h4>
              {chats.length
                ? <ul aria-label={APP_LABELS[app]}>{chats.map(s => <li key={s.id} className={`conn-chat conn-${s.connection}`}>
                    <div className="conn-chat-head"><AppMark app={s.app} /><strong title={s.cwd}>{s.name}</strong>{s.role && <span className={`badge role-${s.role}`}>{ROLE_LABELS[s.role]}</span>}</div>
                    <div className="conn-chat-meta"><StateBadge session={s} /><span>{ui.lastContact} {time(s.lastSeenAt, locale)}</span>{s.worktree && <span className="conn-worktree">{s.worktree}</span>}</div>
                  </li>)}</ul>
                : <p className="conn-empty">{ui.noAppChat(APP_LABELS[app])}</p>}
            </div>;
          })}</div>
        </section>;
      })}
      {!ordered.length && <p className="hint">{ui.noConnectedChat}</p>}
    </div>
    {withoutChat.length > 0 && <p className="conn-without"><span>{ui.projectsWithoutChat}</span> {withoutChat.map(p => p.name).join(", ")}</p>}
  </section>;
}
