import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, CheckCheck, Cog, CircleHelp, Folder, LayoutDashboard, ListTodo, MessageSquare, Search, Send, Radio, ChevronRight, Plus } from "lucide-react";
import { APP_LABELS, ROLE_LABELS, SESSION_ROLES, type AppKind, type Message, type MessageFlow, type Project, type Run, type RunItem, type Session, type Task, type WsEvent } from "@crewpip/shared";
import { LanguageProvider, recipientLabel, useBoardLanguage } from "./language.tsx";
import { displayError } from "./errors.ts";
import { api, ConnectionError, wsUrl } from "./api.ts";
import { Tasks } from "./Tasks.tsx";
import { Content } from "./Content.tsx";
import { Connections } from "./Connections.tsx";
import { Guide } from "./Guide.tsx";
import { AppMark } from "./AppMark.tsx";
import { navigationEntries, projectTitle } from "./project-navigation.ts";
import { useTheme } from "./theme.ts";

const NAME_KEY = "crewpip.humanName";
type View = "overview" | "messages" | "tasks" | "guide";
const date = (iso: string, locale: string) => new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
const preview = (text: string) => text.replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim();

function MessageCard({ message: m, onReply, expanded = false }: { message: Message; onReply: (m: Message) => void; expanded?: boolean }) {
  const { ui, language, locale } = useBoardLanguage();
  return <article className="message-card">
    <header>{m.from.kind === "session" ? <AppMark app={m.from.app} /> : <span className="badge app-human">{ui.person}</span>}
      <strong>{m.from.kind === "session" ? m.from.label.replace(/^[^·]+ · /, "") : m.from.name}</strong><time dateTime={m.createdAt}>{date(m.createdAt, locale)}</time></header>
    <div className="message-target">{ui.to} {recipientLabel(m, language)} · #{m.id}</div>
    <details open={expanded || undefined}><summary><span>{preview(m.text).slice(0, 230)}{m.text.length > 230 ? "…" : ""}</span><span className="read-more">{ui.expandMessage}</span></summary><Content text={m.text} /></details>
    <footer><span>{m.pending.length ? ui.pendingChats(m.pending.length) : m.deliveries.length ? ui.delivered : ui.noReceipt}</span><button className="text-button" onClick={() => onReply(m)}>{ui.reply} <ArrowRight size={14} /></button></footer>
    {!!(m.deliveries.length || m.pending.length) && <details className="delivery-details"><summary>{ui.receipts}</summary>{m.deliveries.map(d => <p key={d.sessionId}>{d.sessionLabel}: {ui.delivery[d.method]} · {date(d.at, locale)}</p>)}{m.pending.map(p => <p key={p}>{p}{ui.waiting}</p>)}</details>}
  </article>;
}

function SetupLinks() {
  const { ui } = useBoardLanguage();
  return <div className="setup-links">
    <a href={ui.connectUrl} target="_blank" rel="noopener noreferrer">{ui.connectChat}</a>
    <a href={ui.deliveryUrl} target="_blank" rel="noopener noreferrer">{ui.firstDelivery}</a>
  </div>;
}

export function App() {
  return <LanguageProvider><Board /></LanguageProvider>;
}

function Board() {
  const { ui, language, chooseLanguage, locale } = useBoardLanguage();
  const { theme, chooseTheme } = useTheme();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatHistory, setChatHistory] = useState<{ id: string; messages: Message[] } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View>("overview");
  const [runs, setRuns] = useState<Run[]>([]);
  const [flows, setFlows] = useState<MessageFlow[]>([]);
  const [runApps, setRunApps] = useState<{ app: AppKind; bin: string | null; loggedIn: boolean | null; hint: string }[]>([]);
  const [liveItems, setLiveItems] = useState<Record<number, RunItem[]>>({});
  const [selection, setSelection] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [search, setSearch] = useState("");
  const [messageScope, setMessageScope] = useState("all");
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [from, setFrom] = useState(() => { try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; } });
  const [to, setTo] = useState("director");
  const [text, setText] = useState("");
  const [compose, setCompose] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendLock = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let closed = false;
    let flowTimer: ReturnType<typeof setTimeout> | undefined;
    let flowSeq = 0;
    let messageTimer: ReturnType<typeof setTimeout> | undefined;
    let messageSeq = 0;
    function refreshMessages() {
      const seq = ++messageSeq;
      clearTimeout(messageTimer);
      messageTimer = setTimeout(async () => {
        try {
          const res = await api("/api/messages");
          if (!res.ok) return;
          const rows = await res.json();
          if (!closed && seq === messageSeq) setMessages(rows);
        } catch { /* Die Verbindung lädt den letzten Stand beim nächsten Kontakt. */ }
      }, 100);
    }
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    async function refresh() {
      const seq = ++flowSeq;
      const msgSeq = ++messageSeq;
      try {
        const urls = ["/api/messages", "/api/sessions", "/api/tasks?status=open,claimed,review,done,cancelled", "/api/projects", "/api/runs", "/api/flows"];
        const [m, s, t, p, r, f] = await Promise.all(urls.map(async url => { const res = await api(url); if (!res.ok) throw new Error(`Daten konnten nicht geladen werden (${res.status}).`); return res.json(); }));
        if (!closed) { if (msgSeq === messageSeq) setMessages(m); setSessions(s); setTasks(t); setProjects(p); setRuns(r); if (seq === flowSeq) setFlows(f); setLoaded(true); }
      } catch (e) { if (!closed) setError(`${e instanceof Error ? e.message : "Verbindung fehlgeschlagen."} Bitte die Seite neu laden.`); }
    }
    // Nachrichtenwege der letzten 24 Stunden: neu holen bei jeder Zustellung und beim Abgleich.
    // Gebündelt: Eine Abholung verbucht bis zu 50 Zustellungen einzeln, geladen wird einmal.
    // Die Nummer verwirft Antworten, die eine neuere Anfrage überholt hat.
    function loadFlows() {
      clearTimeout(flowTimer);
      flowTimer = setTimeout(async () => {
        const seq = ++flowSeq;
        try { const res = await api("/api/flows"); const f = res.ok ? await res.json() : null; if (f && !closed && seq === flowSeq) setFlows(f); } catch { /* Anzeige bleibt beim letzten Stand. */ }
      }, 300);
    }
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => { setConnected(true); void refresh(); };
      ws.onclose = () => { setConnected(false); if (!closed) retry = setTimeout(connect, 2000); };
      ws.onmessage = ev => {
        const e = JSON.parse(ev.data) as WsEvent;
        if (e.type === "message") { setMessages(m => m.some(x => x.id === e.message.id) ? m : [...m, e.message]); refreshMessages(); }
        if (e.type === "sessions") setSessions(e.sessions);
        if (e.type === "tasks") setTasks(e.tasks);
        if (e.type === "projects") { setProjects(e.projects); refreshMessages(); }
        if (e.type === "runs") setRuns(e.runs);
        if (e.type === "run-item") setLiveItems(m => ({ ...m, [e.runId]: [...(m[e.runId] ?? []), e.item] }));
        if (e.type === "delivery") { loadFlows(); refreshMessages(); }
      };
    };
    // Ob ein Chat-Programm noch läuft, meldet niemand von sich aus. Deshalb die Sitzungen
    // regelmäßig neu holen, damit "verbunden" nicht stehen bleibt, wenn eine App beendet wurde.
    const poll = setInterval(() => {
      void api("/api/sessions").then(res => res.ok ? res.json() : null).then(s => { if (s && !closed) setSessions(s); }).catch(() => {});
      loadFlows();
    }, 30000);
    void refresh(); connect();
    return () => { closed = true; clearTimeout(retry); clearTimeout(flowTimer); clearTimeout(messageTimer); clearInterval(poll); ws?.close(); };
  }, []);
  // CLI sign-in probes can take seconds. Do not block the overview on them.
  useEffect(() => {
    if (view !== "tasks" || runApps.length) return;
    let closed = false;
    void api("/api/runner/apps").then(async res => { if (!res.ok) throw new Error("Agentenstatus konnte nicht geladen werden."); return res.json(); }).then(apps => { if (!closed) setRunApps(apps); }).catch(() => { if (!closed) setError("Agentenstatus konnte nicht geladen werden. Aufgaben bleiben bedienbar."); });
    return () => { closed = true; };
  }, [view, runApps.length]);
  useEffect(() => { try { localStorage.setItem(NAME_KEY, from); } catch { /* Storage is optional. */ } }, [from]);
  const entries = useMemo(() => navigationEntries(projects, ui.noNativeProject), [projects, ui.noNativeProject]);
  const entry = entries.find(e => e.key === selection);
  const projectId = entry?.project.id ?? selection;
  const chatId = entry?.chatId;
  useEffect(() => {
    if (!chatId) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await api(`/api/messages?session=${encodeURIComponent(chatId)}&limit=200`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows: Message[] = await res.json();
        if (!controller.signal.aborted) setChatHistory({ id: chatId, messages: rows });
      } catch {
        if (!controller.signal.aborted) setError(ui.historyLoadError);
      }
    }, 50);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [chatId, messages, sessions, ui.historyLoadError]);
  const projectAddresses = useMemo(() => {
    const ids = new Map<string, string | null>();
    for (const p of projects) ids.set(p.name, ids.has(p.name) ? null : p.id);
    for (const p of projects) ids.set(p.id, p.id);
    return ids;
  }, [projects]);
  const selected = entry?.project ?? projects.find(p => p.id === projectId);
  const selectedTitle = entry?.name ?? (selected && projectTitle(selected, ui.noNativeProject));
  const hasStandalone = entries.some(e => e.chatId);
  const displayedProjects = useMemo(() => projects.map(p => ({ ...p, name: projectTitle(p, ui.noNativeProject) })), [projects, ui.noNativeProject]);
  const displayedTasks = useMemo(() => {
    const names = new Map(displayedProjects.map(p => [p.id, p.name]));
    return tasks.map(t => ({ ...t, projectName: names.get(t.projectId) ?? t.projectName }));
  }, [tasks, displayedProjects]);
  useEffect(() => { scroll.current?.scrollTo(0, 0); }, [view, selection]);
  useEffect(() => { if (compose) input.current?.focus(); }, [compose, to]);

  const projectSessions = sessions.filter(s => (!projectId || s.projectId === projectId) && (!chatId || s.id === chatId));
  const openTasks = displayedTasks.filter(t => (!projectId || t.projectId === projectId) && !["done", "cancelled"].includes(t.status));
  const review = openTasks.filter(t => t.status === "review");
  const activeRuns = runs.filter(r => r.status === "running" && (!projectId || r.projectId === projectId));
  const directors = sessions.filter(s => s.role === "director" && s.status !== "ended");
  const relevant = useMemo(() => {
    if (chatId) return chatHistory?.id === chatId ? [...chatHistory.messages].reverse() : [];
    return messages.filter(m => !selected ||
      (m.from.kind === "session" && (m.from.projectId ?? projectAddresses.get(m.from.project)) === selected.id) ||
      (m.to.kind === "project" && projectAddresses.get(m.to.name) === selected.id) || (m.to.kind === "pm" && projectAddresses.get(m.to.project) === selected.id) ||
      (m.to.kind === "session" && sessions.some(s => m.to.kind === "session" && s.id === m.to.id && s.projectId === selected.id))
    ).sort((a, b) => b.id - a.id);
  }, [messages, selected, sessions, chatId, chatHistory, projectAddresses]);
  const shown = relevant.filter(m => (!search || `${m.from.label} ${recipientLabel(m, language)} ${m.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) &&
    (messageScope === "all" || (messageScope === "director" && m.to.kind === "director") || (messageScope === "waiting" && (m.pending.length > 0 || m.deliveries.length === 0))));
  const latest = relevant.filter(m => m.from.kind === "session" && m.to.kind === "director").filter((m, i, arr) => arr.findIndex(x => x.from.kind === "session" && m.from.kind === "session" && x.from.project === m.from.project) === i).slice(0, 6);
  const visibleEntries = entries.filter(e => {
    if (projectSearch) return e.name.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase());
    const p = e.project;
    return showAllProjects || e.key === selection || p.openTasks > 0 ||
      sessions.some(s => s.projectId === p.id && (!e.chatId || s.id === e.chatId)) ||
      messages.some(m => m.from.kind === "session" && (m.from.projectId ?? projectAddresses.get(m.from.project)) === p.id && (!e.chatId || e.chatId === m.from.id) && Date.now() - Date.parse(m.createdAt) < 7 * 86400000);
  });
  const matrixIds = new Set([...sessions.map(s => s.projectId), ...visibleEntries.map(e => e.project.id)]);
  const visibleProjects = displayedProjects.filter(p => matrixIds.has(p.id));
  function select(key: string | null) {
    setSelection(key);
    if (entries.some(e => e.key === key && e.chatId)) setView("messages");
  }

  const roleWaiting = to === "director" ? !directors.length : to.startsWith("pm:") && !sessions.some(s => s.role === "pm" && s.projectId === projectAddresses.get(to.slice(3)) && s.status !== "ended");
  function write(target = chatId ? `session:${chatId}` : selected ? `pm:${selected.id}` : "director") { setTo(target); setCompose(true); setNotice(false); }
  function reply(m: Message) { write(m.replyTo); }
  async function send() {
    if (sendLock.current || !text.trim()) return;
    sendLock.current = true; setSending(true); setError(null);
    try {
      const res = await api("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: from.trim() || "Mensch", to, text: text.trim() }) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Senden fehlgeschlagen");
      setText(""); setCompose(false); setNotice(true);
    } catch (e) { setError(e instanceof Error && !(e instanceof ConnectionError) ? e.message : "Senden fehlgeschlagen. Dein Text bleibt erhalten."); }
    finally { setSending(false); sendLock.current = false; }
  }
  async function editSession(s: Session, data: object) {
    try {
      const res = await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Änderung fehlgeschlagen");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function forget(s: Session) {
    if (!confirm(ui.forgetChat(s.label))) return;
    try { const res = await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }); if (!res.ok) throw new Error("Austragen fehlgeschlagen"); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return <div className="layout">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setView("overview"); select(null); }}><span className="brand-mark"><Cog size={19} /></span>CrewPip<span className="brand-dot">.</span></a>
      <div className="workspace-label">{ui.workspaceBrand}</div>
      <nav className="primary-nav" aria-label={ui.navigation}>
        {([["overview", ui.overview, LayoutDashboard], ["tasks", ui.tasks, ListTodo], ["messages", ui.messages, MessageSquare], ["guide", ui.guide.nav, BookOpen]] as const).map(([id, label, Icon]) => <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><Icon size={18} />{label}{id === "tasks" && <span className="nav-count">{openTasks.length}</span>}</button>)}
      </nav>
      <div className="section">{hasStandalone ? ui.projectsAndChats : ui.projects} <span>{visibleEntries.length}</span></div>
      <label className="search-field sidebar-search"><Search size={15} /><input aria-label={hasStandalone ? ui.searchProjectsAndChats : ui.searchProjects} placeholder={hasStandalone ? ui.searchProjectsAndChats : ui.projectPlaceholder} value={projectSearch} onChange={e => setProjectSearch(e.target.value)} /></label>
      <div className="project-list"><button className={`project-link ${!projectId ? "selected" : ""}`} onClick={() => select(null)}><LayoutDashboard size={15} /><span>{ui.allProjects}</span></button>
        {visibleEntries.map(e => <button key={e.key} title={e.name} className={`project-link ${selection === e.key ? "selected" : ""}`} onClick={() => select(e.key)}>{e.chatId ? <MessageSquare size={15} /> : <Folder size={15} />}<span>{e.name}</span>{!e.chatId && e.project.openTasks > 0 && <span className="nav-count">{e.project.openTasks}</span>}</button>)}
        {!visibleEntries.length && loaded && <p className="hint">{ui.noProject}</p>}
      </div>
      <button className="text-button all-projects" onClick={() => setShowAllProjects(v => !v)}>{showAllProjects ? ui.relevantProjects : (hasStandalone ? ui.allEntryCount(entries.length) : ui.allProjectCount(entries.length))}</button>
      <div className="sidebar-bottom"><select className="language-select" aria-label={ui.language} value={language} onChange={e => chooseLanguage(e.target.value === "de" ? "de" : "en")}>
        <option value="de" lang="de">Deutsch</option><option value="en" lang="en">English</option>
      </select><select className="language-select" aria-label={ui.theme} value={theme} onChange={e => chooseTheme(e.target.value === "light" ? "light" : e.target.value === "system" ? "system" : "dark")}>
        <option value="dark">{ui.themeDark}</option><option value="light">{ui.themeLight}</option><option value="system">{ui.themeSystem}</option>
      </select><button className="text-button" onClick={() => setView("guide")}><CircleHelp size={17} />{ui.help}</button><span className={`connection ${connected ? "online" : ""}`}><i />{connected ? ui.connected : ui.connecting}</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="breadcrumb">{ui.workspace}</span><ChevronRight size={14} /><strong className="desktop-project">{selectedTitle ?? ui.allProjects}</strong><select className="mobile-project" aria-label={hasStandalone ? ui.chooseProjectOrChat : ui.chooseProject} value={selection ?? ""} onChange={e => select(e.target.value || null)}><option value="">{ui.allProjects}</option>{selected && !entry && <option value={selected.id}>{selectedTitle}</option>}{entries.map(e => <option key={e.key} value={e.key}>{e.name}</option>)}</select></div><button className="secondary" onClick={() => write()}><MessageSquare size={16} />{chatId ? ui.writeChat : selected ? ui.writePm : ui.writeDirector}</button></header>
      {error && <div role="alert" className="error-banner">{displayError(error, language)}<button onClick={() => setError(null)} aria-label={ui.dismissError}>×</button></div>}
      {notice && <div role="status" className="notice-banner">{ui.messageSaved}</div>}
      {!connected && loaded && <div role="status" className="error-banner">{ui.disconnected}</div>}
      <div className="workspace" ref={scroll}>
        {!loaded ? <div className="empty">{ui.loading}</div> : <>
        {view === "overview" && <>
          <div className="page-heading"><div><p className="eyebrow">{ui.overviewDate} {new Date().toLocaleDateString(locale, { day: "numeric", month: "long" })}</p><h1>{ui.whatsNext}</h1><p>{ui.overviewIntro}</p></div><button className="primary" onClick={() => setView("tasks")}><Plus size={17} />{ui.planTask}</button></div>
          <div className="stats-grid">
            <button className="stat" onClick={() => setView("tasks")}><span><ListTodo size={18} />{ui.openWork}</span><strong>{openTasks.length}</strong><small>{ui.viewTasks} <ArrowRight size={15} /></small></button>
            <button className="stat attention" onClick={() => setView("tasks")}><span><CheckCheck size={18} />{ui.readyForReview}</span><strong>{review.length}</strong><small>{ui.reviewResults} <ArrowRight size={15} /></small></button>
            <div className="stat"><span><Radio size={18} />{ui.startedAgents}</span><strong>{activeRuns.length}</strong><small>{activeRuns.length ? ui.runningHere : ui.noRunningAgent}</small></div>
          </div>
          <Connections sessions={chatId ? projectSessions : sessions} projects={visibleProjects} projectId={projectId} flows={flows} />
          <section className="orientation"><div className="orientation-icon"><Send size={22} /></div><div><h2>{ui.setDirection}</h2><p>{ui.directionIntro}</p><span>{ui.deliveryTiming}</span></div><button className="secondary" onClick={() => setView("guide")}>{ui.howItWorks} <ArrowRight size={15} /></button></section>
          {!directors.length && <div className="error-banner">{ui.noDirector}</div>}
          {!sessions.length && <SetupLinks />}
          <div className="overview-columns"><section><div className="section-heading"><h2>{ui.upNext}</h2><button className="text-button" onClick={() => setView("tasks")}>{ui.allTasks} <ArrowRight size={15} /></button></div>
            <div className="next-list">{[...review, ...openTasks.filter(t => t.status !== "review")].slice(0, 4).map(t => <button key={t.id} className="next-task" onClick={() => { select(t.projectId); setView("tasks"); }}><span className={`status-tag ${t.status}`}>{ui.taskStatus[t.status]}</span><strong>{t.title}</strong><span>{t.projectName} · #{t.id}</span><ArrowRight size={17} /></button>)}{!openTasks.length && <div className="empty"><CheckCheck size={26} /><p>{ui.noOpenTasks}</p><small>{ui.noOpenTasksHint}</small></div>}</div>
          </section><section className="coordination"><div className="section-heading"><h2>{ui.coordination}</h2></div><div className="coordination-body"><div className="role-step"><b>{ui.you}</b><span>{ui.setGoal}</span></div><div className="flow-line">↓</div><div className="role-step"><b>Director</b><span>{directors.length ? ui.registered(directors.length) : ui.noChat}</span></div><div className="flow-line">↓</div><div className="role-step"><b>{ui.roleFlow}</b><span>{ui.workflow}</span></div><p>{ui.boardScope}</p></div></section></div>
          <div className="section-heading reports-heading"><div><h2>{ui.recentReports}</h2><p>{ui.recentReportsHint}</p></div><button className="text-button" onClick={() => { setView("messages"); setMessageScope("director"); }}>{ui.readAll} <ArrowRight size={15} /></button></div>
          <div className="report-grid">{latest.map(m => <MessageCard key={m.id} message={m} onReply={reply} />)}{!latest.length && <p className="hint">{ui.noReports}</p>}</div>
        </>}
        {view === "tasks" && <><div className="page-heading"><div><p className="eyebrow">{ui.taskEyebrow}</p><h1>{ui.tasks}</h1><p>{ui.tasksIntro}</p></div></div><Tasks tasks={displayedTasks} projects={displayedProjects} sessions={sessions} projectFilter={projectId} onError={setError} runs={runs} runApps={runApps} liveItems={liveItems} /></>}
        {view === "messages" && <><div className="page-heading"><div><p className="eyebrow">{ui.messageEyebrow}</p><h1>{ui.messages}</h1><p>{ui.messagesIntro}</p></div><button className="primary" onClick={() => write()}><Plus size={17} />{ui.compose}</button></div><div className="message-filters"><label className="search-field"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} aria-label={ui.searchMessages} placeholder={ui.messagePlaceholder} /></label><select aria-label={ui.filterMessages} value={messageScope} onChange={e => setMessageScope(e.target.value)}><option value="all">{ui.allMessages}</option><option value="director">{ui.toDirector}</option><option value="waiting">{ui.pendingDelivery}</option></select><span>{shown.length} {ui.messageCount}</span></div><div className="message-list">{shown.slice(0, 100).map(m => <MessageCard key={m.id} message={m} onReply={reply} />)}{shown.length > 100 && <p>{ui.latestHundred}</p>}{!shown.length && <div className="empty">{chatId && chatHistory?.id !== chatId ? ui.loading : ui.noMessages}</div>}</div></>}
        {view === "guide" && <><div className="page-heading"><div><p className="eyebrow">{ui.guide.eyebrow}</p><h1>{ui.guide.title}</h1><p>{ui.guide.intro}</p></div></div><SetupLinks /><Guide onWrite={write} onTasks={() => setView("tasks")} /></>}
        {selected && <details className="session-settings"><summary>{ui.manageChats(selectedTitle ?? selected.name, projectSessions.length)}</summary><p>{ui.roleGuide}</p>{projectSessions.map(s => <div className="session-setting" key={s.id}><div><strong>{s.name}</strong><small><AppMark app={s.app} /> · {ui.connectionState[s.connection]} {ui.lastSeen} {date(s.lastSeenAt, locale)}</small></div><select aria-label={ui.roleFor(s.name)} value={s.role ?? ""} onChange={e => void editSession(s, { role: e.target.value || null })}><option value="">{ui.noRole}</option>{SESSION_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>{s.roleConflict && <small className="session-conflict">{ui.roleConflictText(s.name, APP_LABELS[s.app], ROLE_LABELS[s.roleConflict.role], s.roleConflict.holderLabel)}</small>}<button className="secondary" onClick={() => { const name = prompt(ui.chatName, s.name); if (name?.trim()) void editSession(s, { name: name.trim() }); }}>{ui.rename}</button><button className="text-button" onClick={() => void forget(s)}>{ui.unregister}</button></div>)}</details>}
        </>}
      </div>
      {compose && <section className="composer" aria-label={ui.compose}><form onSubmit={e => { e.preventDefault(); void send(); }}><div className="composer-heading"><h2>{ui.compose}</h2><button className="text-button" type="button" onClick={() => setCompose(false)}>{ui.closeDraft}</button></div><div className="composer-fields"><label>{ui.from}<input placeholder={ui.human} value={from} onChange={e => setFrom(e.target.value)} /></label><label>{ui.to}<select value={to} onChange={e => setTo(e.target.value)}><option value="director">{ui.directorOption}</option>{!(["director", "all"].includes(to) || projects.some(p => to === `pm:${p.id}`) || sessions.some(s => to === `session:${s.id}`)) && <option value={to}>{entries.find(e => e.key === to)?.name ?? to}</option>}<optgroup label={ui.projectManagers}>{projects.map(p => <option key={p.id} value={`pm:${p.id}`}>PM {projectTitle(p, ui.noNativeProject)}</option>)}</optgroup><optgroup label={ui.singleChat}>{sessions.map(s => <option key={s.id} value={`session:${s.id}`}>{s.label}</option>)}</optgroup><option value="all">{ui.broadcast}</option></select></label></div><textarea ref={input} aria-label={ui.message} rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={ui.composerPlaceholder} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} /><div className="composer-footer"><small>{roleWaiting ? ui.roleUnavailable : to === "all" ? ui.broadcastHint : ui.sendHint}</small><button className="primary" disabled={sending || !text.trim()} type="submit"><Send size={16} />{sending ? ui.saving : ui.sendMessage}</button></div></form></section>}
    </main>
  </div>;
}
