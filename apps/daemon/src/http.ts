import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  HOOK_EVENTS,
  SESSION_ROLES,
  type AppKind,
  type HookRequest,
  type HookResponse,
  type RunMode,
  type SessionRole,
  type TaskStatus,
  type WsEvent,
} from "@crewpip/shared";
import { config } from "./config.js";
import { Inbox } from "./inbox.js";
import type { Board } from "./board.js";
import type { Runner } from "./runner/index.js";
import { createMcpServer } from "./mcp.js";
import { createAuth, hostAllowed } from "./auth.js";
import { systemProbe, type ProcessProbe } from "./peer.js";

const APP_KINDS: AppKind[] = ["claude", "cursor", "codex", "antigravity", "other"];

function appKind(v: unknown): AppKind {
  return APP_KINDS.includes(v as AppKind) ? (v as AppKind) : "other";
}

export interface DaemonHandle {
  server: http.Server;
  inbox: Inbox;
  board: Board;
  runner: Runner;
  close(): Promise<void>;
}

export function createDaemon(inbox: Inbox, board: Board, runner: Runner, opts: {
    webDist?: string;
    log?: (line: string) => void;
    schemaVersion?: string;
    /** Fehlt es, läuft der Daemon ungeschützt; das ist nur für Tests gedacht. */
    token?: string;
    authDisabled?: boolean;
    allowedHosts?: string[];
    /** Wer hält die Verbindung? Standard: lsof und ps; Tests setzen eine Attrappe ein. */
    probe?: ProcessProbe;
  } = {}): DaemonHandle {
  const log = opts.log ?? ((l: string) => console.log(l));
  const probe = opts.probe ?? systemProbe();
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const token = opts.token ?? "";
  const auth = createAuth({ token, disabled: opts.authDisabled || !token, allowedHosts: opts.allowedHosts, log });
  // Geschützt ist alles, was Daten liefert oder etwas auslöst. Die statischen Dateien der
  // Oberfläche bleiben offen, weil der Browser sie ohne Kopfzeile lädt; sie enthalten nichts
  // als das Gerüst, und das Token wird erst beim Ausliefern der Startseite eingesetzt.
  app.use("/api", auth);
  app.use("/mcp", auth);
  app.use("/hooks", auth);

  // ---------------------------------------------------------------- MCP
  // Ein zustandsloser Transport pro Anfrage. Die App steckt in der URL, die Session
  // erkennt der Daemon am Prozess, der die Verbindung hält, notfalls am Arbeitsverzeichnis.
  app.post("/mcp/:app", async (req: Request, res: Response) => {
    const kind = appKind(req.query.app ?? req.params.app);
    const sock = { remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort, localAddress: req.socket.localAddress, localPort: req.socket.localPort };
    const server = createMcpServer(inbox, board, runner, kind, () => probe.owner(sock));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`[mcp] ${kind}: ${(e as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: "MCP-Fehler" });
    }
  });
  app.get("/mcp/:app", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "Nur POST (zustandsloser Streamable-HTTP-Transport)" });
  });
  app.delete("/mcp/:app", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "Nur POST" });
  });

  // -------------------------------------------------------------- Hooks
  app.post("/hooks/:app/:event", async (req: Request, res: Response) => {
    const event = req.params.event as string;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      res.status(404).json({ error: `Unbekanntes Hook-Ereignis: ${event}` });
      return;
    }
    const body = (req.body ?? {}) as Partial<HookRequest>;
    const kind = appKind(body.app ?? req.params.app);
    const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;
    const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : null;
    const response: HookResponse = { session: null, messages: [], mayContinue: true };
    if (!sessionId || !cwd) {
      // Ohne beides lässt sich der Aufruf keiner Session zuordnen. Festhalten, damit ein Chat
      // auf „Ohne Hook“ erklärbar ist (#21); keine Inhalte.
      log(`[hooks] ${kind}/${event}: Aufruf ohne ${sessionId ? "Verzeichnis" : "Sitzungs-ID"} verworfen`);
      res.json(response);
      return;
    }

    const session = inbox.upsertSession({
      id: sessionId,
      app: kind,
      cwd,
      name: typeof body.name === "string" ? body.name : null,
      runId: typeof body.runId === "number" ? body.runId : null,
      status: event === "prompt" ? "working" : event === "stop" ? "idle" : undefined,
    });
    response.session = { id: session.id, label: session.label };
    inbox.noteHook(session.id);

    // Der Hook läuft als Kind des Agenten. Wer über ihm steht, ist der Prozess, der später
    // die MCP-Aufrufe dieser Session macht. Gesucht wird nur, wenn nichts Lebendes bekannt
    // ist oder die Session (neu) startet; sonst kostet der Hook keine Zeit.
    if (event !== "session-end" && (event === "session-start" || !inbox.procChainAlive(session.id))) {
      try {
        const chain = await probe.agentChain({ remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort, localAddress: req.socket.localAddress, localPort: req.socket.localPort });
        if (chain.length) inbox.setProcChain(session.id, chain);
      } catch (e) {
        log(`[hooks] Prozesskette für ${session.label} nicht ermittelt: ${(e as Error).message}`);
      }
    }

    // Antigravity meldet "prompt" vor jedem Modellaufruf (PreInvocation); nur der erste nach einer
    // Eingabe des Menschen ist ein neuer Turn.
    const turnStart = body.turnStart !== false;
    switch (event) {
      case "session-start":
        inbox.resetStopContinuations(session.id);
        response.messages = inbox.take(session.id, "hook-start");
        break;
      case "prompt":
        // Ein menschlicher Prompt hebt die Schleifensperre auf, ein weiterer Modellaufruf im
        // selben Turn (auch nach einem Stop mit "continue") nicht.
        if (turnStart) inbox.resetStopContinuations(session.id);
        response.messages = inbox.take(session.id, "hook-prompt");
        break;
      case "stop": {
        const pending = inbox.pendingFor(session.id);
        if (pending.length) {
          response.mayContinue = inbox.countStopContinuation(session.id, config.maxStopContinuations);
          if (response.mayContinue) {
            response.messages = inbox.take(session.id, "hook-stop");
            inbox.setStatus(session.id, "working");
          } else log(`[hooks] ${session.label}: Schleifensperre, ${pending.length} Nachricht(en) bleiben liegen`);
        }
        break;
      }
      case "session-end":
        inbox.endSession(session.id);
        break;
      default:
        break;
    }

    // Teilen sich mehrere Chats dieser App Prozess und Verzeichnis, kann CrewPip sie am
    // Aufruf nicht trennen. Dann bekommt dieser Chat seinen Sitzungsschlüssel in den Kontext,
    // und zwar nur über diesen Weg.
    //
    // "session-start" und "prompt" speisen Kontext ohne Nebenwirkung ein. Bei "stop" wird der
    // Turn blockiert, damit der Chat weiterläuft — das ist nur zu rechtfertigen, wenn ohnehin
    // Post zugestellt wird; dann reist der Schlüssel mit. Ein Stop allein für den Schlüssel
    // wäre eine Schleife und bleibt ausgeschlossen. Bei Codex ist der Stop-Weg gemessen der
    // einzige, der ankommt (Befund des Codex-PM zu #46).
    //
    // Bei Antigravity feuert "prompt" vor jedem Modellaufruf und jeder Einspielung bleibt als
    // sichtbare Nachricht im Gespräch. Der Schlüssel kommt dort deshalb nur zu Beginn eines
    // Turns oder zusammen mit Post, wie bei den anderen Apps einmal je Prompt.
    const schluesselWeg =
      event === "session-start" ||
      (event === "prompt" && (turnStart || response.messages.length > 0)) ||
      (event === "stop" && response.messages.length > 0);
    if (schluesselWeg && inbox.needsSessionKey(session.id)) {
      response.sessionKey = inbox.sessionKey(session.id);
    }
    res.json(response);
  });

  // ---------------------------------------------------------------- API
  app.get("/api/health", (_req, res) => res.json({ ok: true, version: "0.3.0", schema: opts.schemaVersion ?? null }));
  app.get("/api/sessions", (req, res) => res.json(inbox.sessions({ includeEnded: req.query.all === "1" })));
  app.patch("/api/sessions/:id", (req, res) => {
    const b = (req.body ?? {}) as { name?: string; role?: SessionRole | null };
    try {
      let session = null;
      if (typeof b.name === "string") session = inbox.renameSession(req.params.id as string, b.name);
      if (b.role !== undefined) {
        if (b.role !== null && !SESSION_ROLES.includes(b.role)) throw new Error(`Unbekannte Rolle: ${b.role}`);
        session = inbox.setRole(req.params.id as string, b.role);
      }
      if (!session) throw new Error("Weder Name noch Rolle angegeben");
      res.json(session);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.delete("/api/sessions/:id", (req, res) => {
    // Trägt eine Session aus der Liste aus. Meldet sie sich wieder (Hook, MCP oder Registry),
    // taucht sie erneut auf; das ist gewollt, denn dann lebt sie noch.
    inbox.endSession(req.params.id as string);
    res.status(204).end();
  });
  // ---------------------------------------------------- Projekte & Aufgaben
  app.get("/api/projects", (_req, res) => res.json(board.projects()));
  app.patch("/api/projects/:id", (req, res) => {
    const b = (req.body ?? {}) as { bootstrap?: string | null };
    try {
      if (b.bootstrap === undefined) throw new Error("Kein Feld bootstrap angegeben");
      res.json(board.setBootstrap(req.params.id as string, b.bootstrap));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.get("/api/projects/:id/worktrees", (req, res) => res.json(board.worktreesOf(req.params.id as string)));

  app.get("/api/tasks", (req, res) => {
    const status = typeof req.query.status === "string" ? (req.query.status.split(",") as TaskStatus[]) : undefined;
    res.json(board.tasks({ projectId: typeof req.query.project === "string" ? req.query.project : undefined, status }));
  });

  app.post("/api/tasks", (req, res) => {
    const { projectId, title, body, createdBy } = (req.body ?? {}) as Record<string, string>;
    try {
      res.status(201).json(board.create({ projectId: String(projectId ?? ""), title: String(title ?? ""), body, createdBy: String(createdBy || "Mensch") }));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const id = Number(req.params.id);
    const patch = (req.body ?? {}) as { title?: string; body?: string; status?: TaskStatus; assignee?: string | null; notify?: boolean };
    try {
      const before = board.task(id);
      const task = board.update(id, patch);
      // Eine Zuweisung aus der Oberfläche erfährt die Session über den normalen Nachrichtenweg.
      if (patch.notify !== false && task.assignee && task.assignee.id !== before?.assignee?.id) {
        const worktree = task.worktree ? `\n\nArbeitsverzeichnis: ${task.worktree.path} (Branch ${task.worktree.branch})` : "";
        inbox.post(
          { human: String((req.body as { by?: string }).by || "Mensch") },
          `session:${task.assignee.id}`,
          `Aufgabe #${task.id} ist dir zugewiesen: ${task.title}${task.body ? `\n\n${task.body}` : ""}${worktree}` +
            `\n\nStand mit dem MCP-Tool crewpip update_task fortschreiben (status "review", wenn du fertig bist).`,
        );
      }
      res.json(task);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/api/tasks/:id/worktree", (req, res) => {
    void (async () => {
      try {
        res.status(201).json(await board.createWorktree(Number(req.params.id), { base: (req.body ?? {}).base }));
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    })();
  });

  app.delete("/api/tasks/:id/worktree", (req, res) => {
    void (async () => {
      try {
        res.json(await board.removeWorktree(Number(req.params.id), { force: req.query.force === "1" }));
      } catch (e) {
        res.status(409).json({ error: (e as Error).message });
      }
    })();
  });

  // ------------------------------------------------------------- Läufe
  app.get("/api/runner/apps", (req, res) => {
    if (req.query.refresh === "1") runner.forgetAuth();
    res.json(runner.available());
  });
  app.get("/api/runs", (req, res) => res.json(runner.runs({ taskId: req.query.task ? Number(req.query.task) : undefined })));
  app.get("/api/runs/:id/items", (req, res) => {
    try {
      res.json(runner.items(Number(req.params.id)));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });
  app.post("/api/runs", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const run = runner.start({
        taskId: b.taskId == null ? null : Number(b.taskId),
        // Aus der Oberfläche startet der Mensch, nicht eine Session.
        startedBySessionId: null,
        projectId: typeof b.projectId === "string" ? b.projectId : undefined,
        cwd: typeof b.cwd === "string" ? b.cwd : undefined,
        prompt: String(b.prompt ?? ""),
        app: b.app as AppKind,
        mode: b.mode as RunMode,
        allowProjectRoot: b.allowProjectRoot === true,
      });
      res.status(201).json(run);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.post("/api/runs/:id/stop", (req, res) => {
    try {
      res.json(runner.stop(Number(req.params.id)));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.get("/api/flows", (req, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours ?? 24) || 24, 1), 168);
    res.json(inbox.flows(new Date(Date.now() - hours * 3600000).toISOString()));
  });
  app.get("/api/messages", (req, res) => {
    const n = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), 1000) : 200;
    res.json(typeof req.query.session === "string" ? inbox.recentFor(req.query.session, limit) : inbox.recent(limit));
  });
  app.post("/api/messages", (req, res) => {
    const { from, to, text } = (req.body ?? {}) as Partial<{ from: string; to: string; text: string }>;
    try {
      const m = inbox.post({ human: String(from ?? "") }, String(to ?? "all"), String(text ?? ""));
      res.status(201).json(m);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ------------------------------------------------------------- Web-UI
  if (opts.webDist && fs.existsSync(opts.webDist)) {
    const indexPath = path.join(opts.webDist, "index.html");
    /**
     * Die Startseite bekommt das Token eingesetzt. Eine fremde Webseite kann sie wegen der
     * Herkunftsregeln des Browsers nicht auslesen und kommt so auch nicht an das Token.
     */
    const sendIndex = (req: Request, res: Response): void => {
      const hosts = (opts.allowedHosts ?? []).map((h) => h.toLowerCase());
      if (!hostAllowed(req.headers.host, hosts)) {
        res.status(421).send("Unerwarteter Host");
        return;
      }
      // Eine fremde Herkunft bekommt die Startseite gar nicht erst, damit das eingesetzte
      // Token auch dann nicht abfließt, wenn die Herkunftsregeln des Browsers einmal versagen.
      const origin = req.get("origin");
      if (origin && !hostAllowed(new URL(origin).host, hosts)) {
        res.status(403).send("Unerlaubte Herkunft");
        return;
      }
      let html = fs.readFileSync(indexPath, "utf8");
      html = html.replace("</head>", `<script>window.__CREWPIP_TOKEN__=${JSON.stringify(token)}</script></head>`);
      res.type("html").send(html);
    };
    app.get("/", sendIndex);
    app.use(express.static(opts.webDist, { index: false }));
    app.get(/^\/(?!api|mcp|hooks|ws).*/, sendIndex);
  }

  // ----------------------------------------------------------- WebSocket
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: ({ req, origin }, done) => {
      const hosts = (opts.allowedHosts ?? []).map((h) => h.toLowerCase());
      if (!hostAllowed(req.headers.host, hosts)) return done(false, 421, "Unerwarteter Host");
      if (origin && !hostAllowed(new URL(origin).host, hosts)) return done(false, 403, "Unerlaubte Herkunft");
      if (opts.authDisabled || !token) return done(true);
      // Der Browser kann bei WebSockets keine Kopfzeilen setzen, deshalb hier über die Adresse.
      // req ist eine rohe IncomingMessage ohne Express-Methoden: Kopfzeilen direkt lesen.
      const header = req.headers["x-crewpip-token"];
      const given =
        new URL(req.url ?? "/", "http://x").searchParams.get("token") ??
        (Array.isArray(header) ? header[0] : header) ??
        null;
      return given === token ? done(true) : done(false, 401, "Token fehlt oder stimmt nicht");
    },
  });
  const broadcast = (ev: WsEvent) => {
    const data = JSON.stringify(ev);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "sessions", sessions: inbox.sessions() } satisfies WsEvent));
    ws.send(JSON.stringify({ type: "projects", projects: board.projects() } satisfies WsEvent));
    ws.send(JSON.stringify({ type: "tasks", tasks: board.tasks({ status: ["open", "claimed", "review", "done", "cancelled"] }) } satisfies WsEvent));
    ws.send(JSON.stringify({ type: "runs", runs: runner.runs({ limit: 50 }) } satisfies WsEvent));
  });
  inbox.on("message", (message) => broadcast({ type: "message", message }));
  inbox.on("sessions", () => broadcast({ type: "sessions", sessions: inbox.sessions() }));
  inbox.on("delivery", (messageId, delivery) => broadcast({ type: "delivery", messageId, delivery }));
  board.on("tasks", () => broadcast({ type: "tasks", tasks: board.tasks({ status: ["open", "claimed", "review", "done", "cancelled"] }) }));
  board.on("projects", () => broadcast({ type: "projects", projects: board.projects() }));
  runner.on("runs", () => broadcast({ type: "runs", runs: runner.runs({ limit: 50 }) }));
  runner.on("item", (runId, item) => broadcast({ type: "run-item", runId, item }));

  // Wer einen Lauf angestoßen hat, erfährt sein Ende über den normalen Nachrichtenweg.
  runner.on("finished", (run) => {
    if (!run.startedBy) return;
    try {
      // Wenn der Lauf selbst eine Session angemeldet hat, berichtet sie; sonst crewpip.
      const own = inbox.sessionOfRun(run.id);
      inbox.post(
        own ? { sessionId: own } : { human: "crewpip" },
        `session:${run.startedBy.id}`,
        `Lauf #${run.id} (${run.app}, ${run.mode}) ist ${run.status}.` +
          `${run.taskId ? ` Aufgabe #${run.taskId}.` : ""}` +
          `${run.summary ? `\n\n${run.summary}` : ""}` +
          `\n\nAblauf im Detail: list_runs oder die Oberfläche.`,
      );
    } catch (e) {
      log(`[run] Rückmeldung zu #${run.id} fehlgeschlagen: ${(e as Error).message}`);
    }
  });

  // Ist ein Lauf fertig, wandert seine Aufgabe zur Prüfung: der Mensch entscheidet, nicht der Agent.
  runner.on("runs", () => {
    for (const r of runner.runs({ limit: 20 })) {
      if (r.status !== "done" || !r.taskId) continue;
      const t = board.task(r.taskId);
      if (t?.status === "claimed") board.update(t.id, { status: "review" });
    }
  });

  return {
    server,
    inbox,
    board,
    runner,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}
