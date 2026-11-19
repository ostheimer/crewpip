import { APP_LABELS, ROLE_LABELS, type AppKind, type Project, type Session } from "@crewpip/shared";
import { useBoardLanguage } from "./language.tsx";

/** Diese Apps bekommen immer eine Spalte, damit sichtbar ist, wo kein Chat arbeitet. */
const MAIN_APPS: AppKind[] = ["claude", "codex"];
const STATE_ORDER = { connected: 0, "no-hook": 1, stale: 2, ended: 3 } as const;

const time = (iso: string, locale: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(locale, sameDay ? { timeStyle: "short" } : { dateStyle: "short", timeStyle: "short" });
};

function StateBadge({ session }: { session: Session }) {
  const { ui } = useBoardLanguage();
  return <span className={`conn-state conn-${session.connection}`} title={ui.connectionHint[session.connection]}><i aria-hidden="true" />{ui.connectionState[session.connection]}</span>;
}

function RoleHolder({ label, holder }: { label: string; holder: Session | undefined }) {
  const { ui } = useBoardLanguage();
  return <p className={`conn-role ${holder ? "" : "missing"}`}><span>{label}:</span> {holder
    ? <><strong>{holder.name} ({APP_LABELS[holder.app]})</strong> <StateBadge session={holder} /></>
    : <strong>{ui.notAssigned}</strong>}</p>;
}

/**
 * Pro Repo: welche Chats jetzt tatsächlich mit CrewPip verbunden sind, welche nur
 * eingetragen sind, wer PM und Director ist. Bewusst schlichtes Markup mit conn-*-Klassen,
 * damit sich die Ansicht ohne Logikänderung umgestalten lässt.
 */
export function Connections({ sessions, projects, projectId }: { sessions: Session[]; projects: Project[]; projectId: string | null }) {
  const { ui, locale } = useBoardLanguage();
  const live = sessions.filter(s => s.connection !== "ended");
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
        const pm = g.sessions.find(s => s.role === "pm");
        const apps = [...MAIN_APPS, ...new Set(g.sessions.map(s => s.app).filter(a => !MAIN_APPS.includes(a)))];
        return <section key={id} role="group" aria-label={g.name} className={`conn-project ${connected ? "" : "conn-none"}`}>
          <header><h3>{g.name}</h3><span className="conn-count">{connected ? ui.connectedCount(connected, g.sessions.length) : ui.noConnectedChat}</span></header>
          <div className="conn-roles"><RoleHolder label="PM" holder={pm} /><RoleHolder label="Director" holder={director} /></div>
          <div className="conn-apps">{apps.map(app => {
            const chats = g.sessions.filter(s => s.app === app).sort((a, b) => STATE_ORDER[a.connection] - STATE_ORDER[b.connection] || b.lastSeenAt.localeCompare(a.lastSeenAt));
            return <div key={app} className={`conn-app app-col-${app}`}>
              <h4><span className={`badge app-${app}`}>{APP_LABELS[app]}</span></h4>
              {chats.length
                ? <ul aria-label={APP_LABELS[app]}>{chats.map(s => <li key={s.id} className={`conn-chat conn-${s.connection}`}>
                    <div className="conn-chat-head"><strong title={s.cwd}>{s.name}</strong>{s.role && <span className={`badge role-${s.role}`}>{ROLE_LABELS[s.role]}</span>}</div>
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
