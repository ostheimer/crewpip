import { useEffect, useState } from "react";
import { type AppKind, type Run, type RunItem, type Task } from "@crewpip/shared";
import { useBoardLanguage } from "./language.tsx";
import { displayError } from "./errors.ts";
import { api } from "./api.ts";

const ICON: Record<RunItem["kind"], string> = { message: "▸", command: "$", tool: "⚙", error: "!" };

export function StartAgent({
  task,
  apps,
  onError,
  onStarted,
}: {
  task: Task;
  apps: { app: AppKind; bin: string | null; loggedIn: boolean | null; hint: string }[];
  onError: (m: string | null) => void;
  onStarted: () => void;
}) {
  const { ui, language } = useBoardLanguage();
  const usable = apps.filter((a) => a.bin && a.loggedIn !== false);
  const [open, setOpen] = useState(false);
  const [app, setApp] = useState<AppKind>(usable[0]?.app ?? "codex");
  const [mode, setMode] = useState<"read-only" | "worktree-write">("read-only");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return <button onClick={() => { setOpen(true); setPrompt(`${task.title}\n\n${task.body}`.trim()); }}>{ui.startAgent}</button>;
  }

  const chosen = apps.find((a) => a.app === app);
  const needsWorktree = mode === "worktree-write" && !task.worktree;

  async function start() {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    try {
    const res = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: task.id, app, mode, prompt }),
    });
    if (res.ok) {
      setOpen(false);
      onError(null);
      onStarted();
    } else {
      onError(((await res.json()) as { error?: string }).error ?? "Start fehlgeschlagen");
    }
    } catch { onError("Verbindung fehlgeschlagen. Der Start ist nicht bestätigt; vor erneutem Start die Läufe prüfen."); } finally { setBusy(false); }
  }

  return (
    <div className="start-agent">
      <div className="row-inline">
        <select value={app} onChange={(e) => setApp(e.target.value as AppKind)} aria-label={ui.tool}>
          {apps.map((a) => (
            <option key={a.app} value={a.app} disabled={!a.bin || a.loggedIn === false}>
              {a.app}
              {!a.bin ? ` ${ui.notInstalled}` : a.loggedIn === false ? ` ${ui.signedOut}` : ""}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label={ui.permissions}>
          <option value="read-only">{ui.runMode["read-only"]}</option>
          <option value="worktree-write">{ui.runMode["worktree-write"]}</option>
        </select>
        <button onClick={() => void start()} disabled={busy || !prompt.trim() || !chosen?.bin || chosen?.loggedIn === false || needsWorktree}>{ui.start}</button>
        <button onClick={() => setOpen(false)}>{ui.cancel}</button>
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder={ui.promptPlaceholder} aria-label={ui.assignment} />
      {needsWorktree && <p className="warn">{ui.needsWorktree}</p>}
      {chosen && (!chosen.bin || chosen.loggedIn === false) && <p className="warn">{displayError(chosen.hint, language)}</p>}
      {mode === "worktree-write" && task.worktree && (
        <p className="warn">{ui.writePermission(task.worktree.path, task.worktree.branch)}</p>
      )}
    </div>
  );
}

export function RunList({ runs, live }: { runs: Run[]; live: Record<number, RunItem[]> }) {
  const { ui, locale } = useBoardLanguage();
  const [openId, setOpenId] = useState<number | null>(null);
  const [items, setItems] = useState<RunItem[]>([]);

  useEffect(() => {
    if (openId == null) return;
    void api(`/api/runs/${openId}/items`).then((r) => r.json()).then(setItems).catch(() => setItems([]));
  }, [openId]);

  if (!runs.length) return null;
  return (
    <div className="runs">
      {runs.map((r) => {
        const shown = openId === r.id ? [...items, ...(live[r.id] ?? [])] : [];
        return (
          <div key={r.id} className={`run ${r.status}`}>
            <div className="run-head"><button className="run-toggle" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
              <span className="chip">{r.app}</span>
              <span className="chip">{ui.runMode[r.mode]}</span>
              <b>{ui.runStatus[r.status]}</b>
              <span className="muted">#{r.id} · {new Date(r.startedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>
              {r.startedBy && <span className="chip" title={ui.startedBy}>↖ {r.startedBy.label}</span>}
              </button>
              {r.status === "running" && (
                <button onClick={(e) => { e.stopPropagation(); void api(`/api/runs/${r.id}/stop`, { method: "POST" }); }}>{ui.cancel}</button>
              )}
            </div>
            {r.summary && <pre className="run-summary">{r.summary}</pre>}
            {r.pushLog && <details><summary>{ui.pushEvidence}</summary><pre className="run-summary">{r.pushLog}</pre></details>}
            {openId === r.id && (
              <div className="run-items">
                {shown.length === 0 && <span className="muted">{ui.noOutput}</span>}
                {shown.map((i, n) => (
                  <div key={n} className={`run-item ${i.kind}`}>
                    <span className="icon">{ICON[i.kind]}</span>
                    <pre>{i.text}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
