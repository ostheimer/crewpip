import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  APP_LABELS,
  ROLE_LABELS,
  RUN_MODES,
  RUN_MODE_LABELS,
  RUN_STATUS_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type AppKind,
  type Message,
  type Session,
  type Run,
  type RunMode,
  type Task,
  type TaskStatus,
} from "@crewpip/shared";

function renderRun(r: Run): string {
  const parts = [
    `#${r.id} [${RUN_STATUS_LABELS[r.status]}] ${r.app} · ${RUN_MODE_LABELS[r.mode]}${r.taskTitle ? ` · Aufgabe #${r.taskId} ${r.taskTitle}` : ""}`,
    `   Verzeichnis: ${r.cwd}`,
    `   angestoßen von: ${r.startedBy ? r.startedBy.label : "der Oberfläche"}`,
  ];
  if (r.summary) parts.push(`   Ergebnis: ${r.summary.split("\n").join(" ")}`);
  return parts.join("\n");
}
import { config } from "./config.js";
import type { Inbox } from "./inbox.js";
import type { Board } from "./board.js";
import type { Runner } from "./runner/index.js";
import type { Proc } from "./peer.js";

function renderTask(t: Task): string {
  const parts = [
    `#${t.id} [${TASK_STATUS_LABELS[t.status]}] ${t.title}`,
    `   Projekt: ${t.projectName}  angelegt von ${t.createdBy}`,
  ];
  if (t.assignee) parts.push(`   übernommen von: ${t.assignee.label}`);
  if (t.worktree) parts.push(`   Worktree: ${t.worktree.path}  Branch: ${t.worktree.branch}`);
  if (t.body) parts.push(t.body.split("\n").map((l) => `   ${l}`).join("\n"));
  return parts.join("\n");
}

export function renderMessages(msgs: Message[]): string {
  if (!msgs.length) return "Keine neuen Nachrichten.";
  return msgs
    .map((m) => `#${m.id} ${m.createdAt}\nvon: ${m.from.label}\nan: ${m.toLabel}\nantworten an: ${m.replyTo}\n\n${m.text}`)
    .join("\n\n---\n\n");
}

const CONNECTION_WORDS: Record<Session["connection"], string> = { connected: "verbunden", "no-hook": "ohne-hook", "restart-needed": "neustart-noetig", stale: "veraltet", ended: "beendet" };

function renderSessions(all: Session[], self: Session | null): string {
  const byProject = new Map<string, Session[]>();
  for (const s of all) byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s]);
  const lines: string[] = [];
  for (const [project, sessions] of byProject) {
    lines.push(`Projekt ${sessions[0]!.project}  (Ziel: project:${project})`);
    for (const s of sessions) {
      lines.push(
        `  ${s.id === self?.id ? "*" : "-"} ${APP_LABELS[s.app]} / ${s.name}` +
          `${s.role ? `  [${ROLE_LABELS[s.role]}]` : ""}` +
          `${s.worktree ? `  worktree=${s.worktree}` : ""}  status=${s.status}  verbindung=${CONNECTION_WORDS[s.connection]}` +
          `  Ziel: ${s.role === "director" ? "director" : s.role === "pm" ? `pm:${s.projectId}` : `session:${s.id}`}`,
      );
    }
  }
  lines.push(
    "",
    "Weitere Ziele: all, app:claude, app:cursor, app:codex, app:antigravity, human:<name>.",
    "pm:<projekt> und director folgen der Rolle, nicht der Sitzung: Sie erreichen auch den,",
    "der die Rolle erst später übernimmt, und überstehen einen Neustart.",
    "verbindung=ohne-hook, neustart-noetig oder veraltet: Post erreicht diesen Chat nicht von selbst (docs/verbindung.md).",
  );
  return lines.join("\n");
}

const cwdParam = z.string().min(1).describe("Dein aktuelles Arbeitsverzeichnis (absoluter Pfad). Hilft CrewPip, deine Session zu erkennen.");
const keyParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Dein Sitzungsschlüssel, falls CrewPip dir einen genannt hat (Zeile „Sitzungsschlüssel: …“ " +
      "in einer CrewPip-Meldung). Nötig, wenn mehrere Chats derselben App im gleichen Verzeichnis " +
      "arbeiten. Nie raten und nie einen fremden Schlüssel verwenden.",
  );

/** Die Zuordnung ist nicht eindeutig; unter dieser Identität darf nichts geschehen. */
class UncertainIdentity extends Error {}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Fängt eine unsichere Identität ab und meldet sie dem Modell als Fehler des Aufrufs. */
function guarded<A extends unknown[]>(fn: (...a: A) => Promise<ToolResult>): (...a: A) => Promise<ToolResult> {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e instanceof UncertainIdentity) return { content: [{ type: "text", text: e.message }], isError: true };
      throw e;
    }
  };
}

/**
 * Ein MCP-Server pro Aufruf, gebunden an eine App. Die aufrufende Session erkennt CrewPip am
 * Sitzungsschlüssel, den der Hook genau diesem Chat gegeben hat; ohne Schlüssel am Prozess, der
 * die Verbindung hält (caller); erst dann am Arbeitsverzeichnis, das jedes Tool mitbringt.
 */
export function createMcpServer(
  inbox: Inbox,
  board: Board,
  runner: Runner,
  app: AppKind,
  caller: () => Promise<Proc | null> = async () => null,
): McpServer {
  const server = new McpServer({ name: "crewpip", version: "0.3.0" });
  let callerOnce: Promise<Proc | null> | null = null;
  const who = async (cwd: string, key?: string) => {
    const id = inbox.identify(app, cwd, await (callerOnce ??= caller().catch(() => null)), key);
    if (id.problem === "unbekannter-schluessel") {
      throw new UncertainIdentity(
        "Der mitgeschickte Sitzungsschlüssel gehört zu keiner laufenden Session dieser App. " +
          "Dieser Aufruf ist abgelehnt. Nimm den Schlüssel wörtlich aus der jüngsten CrewPip-Meldung " +
          "deines eigenen Chats, oder lass ihn weg — raten hilft nicht.",
      );
    }
    return id;
  };
  const me = async (cwd: string, key?: string) => {
    const id = await who(cwd, key);
    if (id.certain && id.session) return id.session;
    const names = [id.session, ...id.others].filter((s) => s !== null).map((s) => s!.label).join(", ");
    throw new UncertainIdentity(
      `CrewPip kann nicht sicher erkennen, welche Session du bist: ${names} arbeiten im selben Verzeichnis, ` +
        "und dein Prozess ist keiner davon eindeutig zugeordnet. Damit nichts unter falschem Namen läuft, " +
        "ist dieser Aufruf abgelehnt. Nenne deinen Sitzungsschlüssel im Feld session_key, wenn CrewPip dir " +
        "einen genannt hat; sonst sag dem Menschen Bescheid. Eine andere Session vorzuschieben hilft nicht.",
    );
  };

  server.registerTool(
    "post_message",
    {
      title: "Nachricht senden",
      description:
        "Hinterlässt eine Nachricht für andere Sessions oder Menschen. Ziel (to): " +
        '"session:<id>" (eine bestimmte Session, ids über list_sessions), "project:<name>" (alle Sessions eines Projekts), ' +
        '"app:claude|cursor|codex|antigravity", "pm:<projekt>" (wer dort gerade PM ist), "director", "all", oder "human:<name>". ' +
        'Zum Antworten den Wert aus "antworten an" verwenden.',
      inputSchema: { cwd: cwdParam, session_key: keyParam, to: z.string().min(1), text: z.string().min(1).describe("Nachrichtentext, Markdown erlaubt") },
    },
    guarded(async ({ cwd, session_key, to, text }) => {
      const self = await me(cwd, session_key);
      const m = inbox.post({ sessionId: self.id }, to, text);
      const status = m.pending.length
        ? `wartet bei: ${m.pending.join(", ")}`
        : m.to.kind === "human"
          ? "liegt in der Web-UI"
          : "keine aktive Session als Empfänger, bleibt liegen";
      return { content: [{ type: "text", text: `Gesendet als #${m.id} von ${self.label} an ${m.toLabel} (${status}).` }] };
    }),
  );

  server.registerTool(
    "read_inbox",
    {
      title: "Posteingang lesen",
      description: "Liest Nachrichten, die deine Session noch nicht gesehen hat, und verbucht sie als zugestellt.",
      inputSchema: { cwd: cwdParam, session_key: keyParam },
    },
    guarded(async ({ cwd, session_key }) => ({
      content: [{ type: "text", text: renderMessages(inbox.take((await me(cwd, session_key)).id, "mcp-read")) }],
    })),
  );

  server.registerTool(
    "wait_for_message",
    {
      title: "Auf Nachricht warten",
      description:
        `Wartet bis zu timeout_seconds auf eine neue Nachricht für deine Session. ` +
        `Höchstens ${config.maxWaitSeconds} s pro Aufruf; für längeres Warten mehrfach aufrufen.`,
      inputSchema: { cwd: cwdParam, session_key: keyParam, timeout_seconds: z.number().int().min(1).max(config.maxWaitSeconds).optional() },
    },
    guarded(async ({ cwd, session_key, timeout_seconds }, extra) => {
      const secs = Math.min(timeout_seconds ?? config.defaultWaitSeconds, config.maxWaitSeconds);
      const msgs = await inbox.waitFor((await me(cwd, session_key)).id, secs * 1000, extra.signal);
      return { content: [{ type: "text", text: msgs.length ? renderMessages(msgs) : `Nichts Neues nach ${secs} s.` }] };
    }),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "Sessions auflisten",
      description: "Zeigt alle aktiven Sessions nach Projekt, mit den Zieladressen für post_message. Deine eigene ist mit * markiert.",
      inputSchema: { cwd: cwdParam, session_key: keyParam },
    },
    guarded(async ({ cwd, session_key }) => {
      const id = await who(cwd, session_key);
      const note = id.certain
        ? ""
        : "\n\nAchtung: CrewPip kann deine Session nicht eindeutig erkennen, deshalb ist keine mit * markiert. " +
          "Mehrere Chats dieser App arbeiten im selben Verzeichnis; nenne deinen Sitzungsschlüssel in session_key.";
      return { content: [{ type: "text", text: renderSessions(inbox.sessions(), id.certain ? id.session : null) + note }] };
    }),
  );

  // ---- Aufgaben --------------------------------------------------------

  server.registerTool(
    "list_tasks",
    {
      title: "Aufgaben auflisten",
      description:
        "Zeigt die Aufgaben deines Projekts. Ohne status alle offenen, in Arbeit befindlichen und " +
        "zu prüfenden; mit status gezielt (offen=open, in Arbeit=claimed, zu prüfen=review, erledigt=done, verworfen=cancelled).",
      inputSchema: { cwd: cwdParam, session_key: keyParam,
        status: z.array(z.enum(TASK_STATUSES)).optional(),
        all_projects: z.boolean().optional().describe("true zeigt die Aufgaben aller Projekte"),
      },
    },
    guarded(async ({ cwd, session_key, status, all_projects }) => {
      // Das Projekt ist auch bei unsicherer Session klar: alle Kandidaten teilen das Verzeichnis.
      const id = await who(cwd, session_key);
      const self = id.session ?? id.others[0]!;
      const tasks = board.tasks({
        projectId: all_projects ? undefined : self.projectId,
        status: status?.length ? (status as TaskStatus[]) : ["open", "claimed", "review"],
      });
      return {
        content: [
          {
            type: "text",
            text: tasks.length ? tasks.map(renderTask).join("\n\n") : "Keine passenden Aufgaben.",
          },
        ],
      };
    }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Aufgabe anlegen",
      description: "Legt eine Aufgabe in deinem Projekt an. Sie ist danach offen und keiner Session zugewiesen.",
      inputSchema: { cwd: cwdParam, session_key: keyParam,
        title: z.string().min(1).describe("Kurzer Titel, eine Zeile"),
        body: z.string().optional().describe("Ausführliche Beschreibung, Markdown erlaubt"),
      },
    },
    guarded(async ({ cwd, session_key, title, body }) => {
      const self = await me(cwd, session_key);
      const t = board.create({ projectId: self.projectId, title, body, createdBy: self.label });
      return { content: [{ type: "text", text: `Angelegt:\n${renderTask(t)}` }] };
    }),
  );

  server.registerTool(
    "claim_task",
    {
      title: "Aufgabe übernehmen",
      description:
        "Übernimmt eine Aufgabe für deine Session und setzt sie auf 'in Arbeit'. " +
        "Eine bereits von jemand anderem übernommene Aufgabe wird abgelehnt.",
      inputSchema: { cwd: cwdParam, session_key: keyParam, id: z.number().int().positive() },
    },
    guarded(async ({ cwd, session_key, id }) => {
      const self = await me(cwd, session_key);
      try {
        const t = board.claim(id, self.id);
        const hint = t.worktree
          ? `\n\nArbeite in ${t.worktree.path} (Branch ${t.worktree.branch}).`
          : "\n\nEs gibt keinen eigenen Worktree; frage den Menschen, falls du einen brauchst.";
        return { content: [{ type: "text", text: `Übernommen:\n${renderTask(t)}${hint}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Aufgabe fortschreiben",
      description:
        "Ändert den Status einer Aufgabe und hängt optional eine Notiz an. Übliche Wechsel: " +
        "claimed → review, wenn du fertig bist und ein Mensch prüfen soll; claimed → open, wenn du sie zurückgibst.",
      inputSchema: { cwd: cwdParam, session_key: keyParam,
        id: z.number().int().positive(),
        status: z.enum(TASK_STATUSES).optional(),
        note: z.string().optional().describe("Wird mit Zeitstempel und deinem Namen an die Beschreibung angehängt"),
      },
    },
    guarded(async ({ cwd, session_key, id, status, note }) => {
      const self = await me(cwd, session_key);
      try {
        const cur = board.task(id);
        if (!cur) throw new Error(`Unbekannter Task: ${id}`);
        const body = note?.trim()
          ? `${cur.body ? `${cur.body}\n\n` : ""}— ${new Date().toISOString().slice(0, 16).replace("T", " ")} ${self.label}: ${note.trim()}`
          : undefined;
        const t = board.update(id, { status, body });
        return { content: [{ type: "text", text: `Aktualisiert:\n${renderTask(t)}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }),
  );

  // ---- Agents starten --------------------------------------------------
  //
  // Absichtliche Grenzen: standardmäßig nur lesend; schreibend nur im Worktree einer
  // Aufgabe; ein selbst gestarteter Lauf darf keine weiteren starten; Höchstzahl
  // gleichzeitiger Läufe und eine Obergrenze je Stunde. Der Haupt-Checkout ist über
  // diesen Weg nicht schreibend erreichbar.

  server.registerTool(
    "start_run",
    {
      title: "Agent starten",
      description:
        "Startet ein Coding-Werkzeug als eigenen Prozess und meldet sich bei dir, sobald es fertig ist. " +
        'Standard ist "read-only": lesen und antworten, nichts ändern. "worktree-write" darf Dateien ändern und ' +
        "verlangt deshalb eine Aufgabe mit Worktree. Ein Lauf, den CrewPip gestartet hat, kann selbst keine Läufe starten.",
      inputSchema: { cwd: cwdParam, session_key: keyParam,
        prompt: z.string().min(1).describe("Auftrag an den Agent, so vollständig wie möglich"),
        task_id: z.number().int().positive().optional().describe("Aufgabe, zu der der Lauf gehört; bestimmt auch das Arbeitsverzeichnis"),
        app: z.enum(["codex", "claude"]).optional().describe("Standard: das Werkzeug dieser Session"),
        mode: z.enum(RUN_MODES).optional().describe('Standard "read-only"'),
      },
    },
    guarded(async ({ cwd, session_key, prompt, task_id, app: tool, mode }) => {
      const self = await me(cwd, session_key);
      try {
        const run = runner.start({
          taskId: task_id ?? null,
          projectId: self.projectId,
          prompt,
          app: (tool ?? app) as AppKind,
          mode: (mode ?? "read-only") as RunMode,
          startedBySessionId: self.id,
        });
        return {
          content: [
            {
              type: "text",
              text: `Gestartet:\n${renderRun(run)}\n\nDu bekommst eine Nachricht, sobald der Lauf fertig ist. Warte nicht aktiv darauf.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }),
  );

  server.registerTool(
    "list_runs",
    {
      title: "Läufe auflisten",
      description: "Zeigt die letzten Agent-Läufe mit Zustand und Ergebnis.",
      inputSchema: { cwd: cwdParam, session_key: keyParam, task_id: z.number().int().positive().optional(), mine_only: z.boolean().optional() },
    },
    guarded(async ({ cwd, session_key, task_id, mine_only }) => {
      const self = await me(cwd, session_key);
      const runs = runner
        .runs({ taskId: task_id, limit: 20 })
        .filter((r) => (mine_only ? r.startedBy?.id === self.id : true));
      return { content: [{ type: "text", text: runs.length ? runs.map(renderRun).join("\n\n") : "Keine Läufe." }] };
    }),
  );

  server.registerTool(
    "stop_run",
    {
      title: "Lauf abbrechen",
      description: "Bricht einen Lauf ab, den du selbst angestoßen hast.",
      inputSchema: { cwd: cwdParam, session_key: keyParam, id: z.number().int().positive() },
    },
    guarded(async ({ cwd, session_key, id }) => {
      const self = await me(cwd, session_key);
      if (!runner.ownedBy(id, self.id)) {
        return { content: [{ type: "text", text: `Lauf #${id} wurde nicht von dir angestoßen.` }], isError: true };
      }
      return { content: [{ type: "text", text: `Abgebrochen:\n${renderRun(runner.stop(id))}` }] };
    }),
  );

  return server;
}
