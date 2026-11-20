import { useId, useState } from "react";
import { APP_LABELS, ROLE_LABELS, type AppKind, type MessageFlow, type Project, type Session } from "@crewpip/shared";
import { ChevronDown, ChevronRight, CircleHelp, Info } from "lucide-react";
import { useBoardLanguage } from "./language.tsx";
import { AppMark, APP_SHAPES } from "./AppMark.tsx";
import { buildMatrix, type MatrixRow } from "./matrix.ts";


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
  return <span className="flow-end"><AppMark app={end.app} /> <strong>{end.projectId === projectId ? end.name : end.label.replace(/^[^·]+ · /, "")}</strong>{!live.has(end.id) && <em className="flow-ended"> ({ui.flowEnded})</em>}</span>;
}

const ROLE_ABBR: Partial<Record<NonNullable<Session["role"]>, string>> = { pm: "PM", director: "D" };

/**
 * Ein Symbol je Chat: Form = App, gefüllt = Post kommt an, hohl = Ohne Hook, gestrichelt und
 * gedämpft = veraltet. Name, Rolle, Zustand, letzter Kontakt und Adresse erscheinen bei Hover und
 * Tastaturfokus; Escape blendet sie aus (WCAG 1.4.13).
 */
function ChatDot({ session, edge }: { session: Session; edge: boolean }) {
  const { ui, locale } = useBoardLanguage();
  const id = `dot-tip-${useId().replace(/[^\w-]/g, "")}`;
  const [hidden, setHidden] = useState(false);
  const role = session.role && session.role !== "worker" ? ROLE_LABELS[session.role] : null;
  const abbr = session.role ? ROLE_ABBR[session.role] : undefined;
  const label = [session.name, APP_LABELS[session.app], role, ui.connectionState[session.connection]].filter(Boolean).join(", ");
  return <span className={`dot-wrap ${edge ? "tip-end" : ""} ${hidden ? "tip-hidden" : ""}`} onMouseLeave={() => setHidden(false)}>
    <button type="button" className={`dot dot-${session.connection}`} aria-label={label} aria-describedby={id} data-state={session.connection} data-chat={session.id}
      onKeyDown={e => { if (e.key === "Escape") setHidden(true); }} onBlur={() => setHidden(false)}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">{APP_SHAPES[session.app](14)}</svg>
      {abbr && <span className="dot-role" aria-hidden="true">{abbr}</span>}
    </button>
    <span role="tooltip" id={id} className="conn-tip dot-tip">
      <strong>{session.name}</strong>
      <span>{APP_LABELS[session.app]}{role ? ` · ${role}` : ""}</span>
      <span>{ui.connectionState[session.connection]}</span>
      {session.connection === "restart-needed" && <span className="dot-tip-hint">{ui.connectionHint["restart-needed"]}</span>}
      <span>{ui.lastContact} {time(session.lastSeenAt, locale)}</span>
      <code>session:{session.id}</code>
    </span>
  </span>;
}

/** Symbol der Legende: gleiche Zeichnung wie im Chat-Symbol, damit man sie wiedererkennt. */
function LegendDot({ state }: { state: "connected" | "no-hook" | "restart-needed" | "stale" }) {
  const { ui } = useBoardLanguage();
  return <span className="legend-item"><span className={`dot dot-${state}`} aria-hidden="true"><svg viewBox="0 0 14 14" width="14" height="14" focusable="false">{APP_SHAPES.claude(14)}</svg></span>{ui.connectionState[state]}</span>;
}

/** Erklärtexte der Übersicht, nur auf Wunsch sichtbar (Knopf neben der Überschrift). */
function InfoPanel() {
  const { ui } = useBoardLanguage();
  const id = `matrix-info-${useId().replace(/[^\w-]/g, "")}`;
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="info-button" aria-expanded={open} aria-controls={id} aria-label={ui.matrixInfoLabel} title={ui.matrixInfoLabel}
      onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}><Info size={16} aria-hidden="true" /></button>
    {open && <div id={id} className="info-panel" role="region" aria-label={ui.matrixInfoLabel} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>
      <p>{ui.connectionsIntro}</p>
      <ul>{(["connected", "no-hook", "restart-needed", "stale"] as const).map(k => <li key={k}><strong>{ui.connectionState[k]}:</strong> {ui.connectionHint[k]}</li>)}</ul>
      <p>{ui.matrixSymbols}</p>
    </div>}
  </>;
}

function MatrixRowView({ row, apps, flows, liveIds }: { row: MatrixRow; apps: AppKind[]; flows: MessageFlow[]; liveIds: Set<string> }) {
  const { ui, locale } = useBoardLanguage();
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState(false);
  const detailId = `repo-${useId().replace(/[^\w-]/g, "")}`;
  const mine = flows.filter(f => f.to.projectId === row.id || (f.from.kind === "session" && f.from.projectId === row.id));
  const graphSessions = [...row.sessions].sort((a, b) => a.app.localeCompare(b.app) || a.name.localeCompare(b.name));
  const total = row.sessions.length;
  return <tbody className={`matrix-repo ${row.alert ? "matrix-alert" : ""} ${row.connected ? "" : "matrix-none"}`} data-repo={row.name}>
    <tr>
      <th scope="row"><button type="button" className="repo-toggle" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span className="repo-name">{row.name}</span>
        <span className="repo-count" aria-label={ui.connectedCount(row.connected, total)}>{row.connected}/{total}</span>
        {row.alert && <span className="repo-alert"><span aria-hidden="true">▲</span><span className="sr-only">{ui.matrixAlert}</span></span>}
      </button></th>
      {apps.map((app, i) => {
        const chats = row.cells[app] ?? [];
        return <td key={app}>{chats.length ? <span className="dot-list">{chats.map(s => <ChatDot key={s.id} session={s} edge={i >= apps.length - 1 && apps.length > 1} />)}</span> : <span className="dot-none"><span aria-hidden="true">·</span><span className="sr-only">{ui.noAppChat(APP_LABELS[app])}</span></span>}</td>;
      })}
    </tr>
    {open && <tr className="matrix-detail"><td id={detailId} colSpan={apps.length + 1}>
      <div className="conn-roles"><RoleHolder label="PM" holder={row.pm} /><RoleHolder label="Director" holder={row.director} /></div>
      <ul className="conn-chat-list" aria-label={ui.chatList}>{row.sessions.map(s => <li key={s.id} className={`conn-chat conn-${s.connection}`}>
        <div className="conn-chat-head"><AppMark app={s.app} /><strong title={s.cwd}>{s.name}</strong>{s.role && <span className={`badge role-${s.role}`}>{ROLE_LABELS[s.role]}</span>}</div>
        <div className="conn-chat-meta"><StateBadge session={s} /><span>{ui.lastContact} {time(s.lastSeenAt, locale)}</span>{s.worktree && <span className="conn-worktree">{s.worktree}</span>}</div>
      </li>)}</ul>
      <div className="conn-flows"><h4>{ui.flowsTitle}</h4>
        {mine.length
          ? <ul aria-label={ui.flowsTitle}>{mine.map(f => <li key={`${f.from.kind === "session" ? f.from.id : f.from.name}>${f.to.id}`}>
              <FlowEnd end={f.from} projectId={row.id} live={liveIds} /> <span aria-hidden="true">→</span><span className="sr-only">{ui.flowTo}</span> <FlowEnd end={f.to} projectId={row.id} live={liveIds} />
              <span className="flow-meta"> · {ui.flowCount(f.count)} · {ui.flowLast} {time(f.lastAt, locale)}</span>
            </li>)}</ul>
          : <p className="conn-empty">{ui.noFlows}</p>}
      </div>
      <button type="button" className="text-button graph-toggle" aria-expanded={graph} onClick={() => setGraph(g => !g)}>{graph ? ui.hideGraph : ui.showGraph}</button>
      {graph && <><StarGraph name={row.name} sessions={graphSessions} flows={mine} /><p className="graph-legend">{ui.graphLegend}</p></>}
    </td></tr>}
  </tbody>;
}

/**
 * Matrix Repo × App (Issue #22): eine Zeile je Repo, eine Spalte je vorkommender App, ein Symbol je
 * Chat. Details (Chatliste, Nachrichtenwege der letzten 24 Stunden, Stern-Grafik) klappen je Zeile
 * auf, Erklärtexte stehen hinter dem Info-Knopf.
 */
export function Connections({ sessions, projects, projectId, flows }: { sessions: Session[]; projects: Project[]; projectId: string | null; flows: MessageFlow[] }) {
  const { ui } = useBoardLanguage();
  const { apps, rows, withoutChat } = buildMatrix(sessions, projects, projectId);
  const liveIds = new Set(sessions.filter(s => s.connection !== "ended").map(s => s.id));
  return <section className="connections" aria-labelledby="connections-title">
    <div className="section-heading matrix-heading"><h2 id="connections-title">{ui.connectionsTitle}</h2><InfoPanel /></div>
    <p className="matrix-legend"><LegendDot state="connected" /><LegendDot state="no-hook" /><LegendDot state="restart-needed" /><LegendDot state="stale" /><span className="legend-item"><span className="dot-none" aria-hidden="true">·</span>{ui.legendNoChat}</span><span className="legend-item legend-role">{ui.legendRole}</span></p>
    {rows.length > 0 && <table className="conn-matrix">
      <caption className="sr-only">{ui.connectionsTitle}</caption>
      <thead><tr><th scope="col">{ui.matrixRepo}</th>{apps.map(a => <th scope="col" key={a}><AppMark app={a} /></th>)}</tr></thead>
      {rows.map(r => <MatrixRowView key={r.id} row={r} apps={apps} flows={flows} liveIds={liveIds} />)}
    </table>}
    {!rows.length && <p className="hint">{ui.noConnectedChat}</p>}
    {withoutChat.length > 0 && <p className="conn-without"><span>{ui.projectsWithoutChat}</span> {withoutChat.map(p => p.name).join(", ")}</p>}
  </section>;
}
