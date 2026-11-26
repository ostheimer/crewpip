import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { roleFromName } from "@crewpip/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { Board } from "../src/board.js";
import { Runner } from "../src/runner/index.js";
import { createDaemon } from "../src/http.js";

// Akzeptanztests Issue #28: PM-Rollen zuverlässig vergeben, Konflikte anzeigen, Rollenwechsel.

function setup(titles = new Map<string, string>()) {
  const db = openDb(":memory:");
  const board = new Board(db, { titles, projects: new Map() });
  return { db, board, inbox: new Inbox(db, board), titles };
}
const role = (inbox: Inbox, id: string) => inbox.sessions().find((s) => s.id === id)?.role ?? null;

test("Nur der vollständige Titel Director beansprucht die Director-Rolle", () => {
  assert.equal(roleFromName(" dIrEcToR "), "director");
  assert.equal(roleFromName("Director-Anweisungen einholen"), null);
  assert.equal(roleFromName("Director kontaktieren"), null);
  assert.equal(roleFromName("Director: Planung"), null);
  assert.equal(roleFromName("PM Werkstatt"), "pm");
  assert.equal(roleFromName("  pm CMM (Mac Studio) "), "pm");
  assert.equal(roleFromName("PM crewpip(#45)"), "pm");
  assert.equal(roleFromName("Worker Werkstatt"), "worker");
});

test("Gewöhnliche Aufgabentitel mit PM am Anfang beanspruchen keine PM-Rolle (#45)", () => {
  for (const t of ["PM-Rolle prüfen", "PM an Merge erinnern", "PM: Übergabe", "PM", "PM Werkstatt übernehmen", "PM Werkstatt (offen) Rest", "PMs sammeln", "PM (Mac)"]) {
    assert.equal(roleFromName(t), null, t);
  }
});

test("Director-Post erreicht beim Abgleich nativer Titel nur den eigentlichen Director", () => {
  const { inbox, titles } = setup();
  inbox.upsertSession({ id: "auftrag", app: "codex", cwd: "/p/werkstatt" });
  inbox.upsertSession({ id: "leitung", app: "claude", cwd: "/p/leitung" });
  const message = inbox.post({ sessionId: "auftrag" }, "director", "Bitte prüfen");
  titles.set("codex:auftrag", "Director-Anweisungen einholen");
  titles.set("claude:leitung", "Director");
  inbox.syncNameRoles();
  assert.equal(role(inbox, "leitung"), "director");
  assert.equal(inbox.sessions().find(s => s.id === "auftrag")?.roleConflict, null);
  assert.deepEqual(inbox.take("leitung", "mcp-read").map(m => m.id), [message.id]);
  inbox.endSession("leitung");
  assert.equal(role(inbox, "auftrag"), null);
});

test("Bestehende Director-Zuweisung an einen Nicht-Claude-Chat weicht beim Start dem Claude-Vorrang (#48)", () => {
  for (const actor of ["name", "dashboard"]) {
    const { inbox, board, db } = setup();
    inbox.upsertSession({ id: "inhaber", app: "codex", cwd: "/p/a", name: "Director-Auftrag" });
    inbox.setRole("inhaber", "director", actor);
    const restarted = new Inbox(db, board);
    restarted.upsertSession({ id: "leitung", app: "claude", cwd: "/p/b", name: "Director" });
    restarted.syncNameRoles();
    assert.equal(role(restarted, "inhaber"), null);
    assert.equal(role(restarted, "leitung"), "director");
    assert.equal(restarted.roleChanges().find((c) => c.toSession === "leitung")?.actor, "automatisch: Claude-Vorrang");
    restarted.endSession("leitung");
    assert.equal(role(restarted, "inhaber"), null);
    db.close();
  }
});

// ---- Kriterium 1: Rolle aus dem wirksamen Anzeigenamen, gleich welche Quelle -------------

test("#28/1 Claude: per /rename gesetzter Name im Registry-Abgleich vergibt die Rolle (Befund 1)", () => {
  const { inbox } = setup();
  // Wie in Production: Der Hook meldet die Session zuerst ohne Namen an ...
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/claribill" });
  // ... der Registry-Abgleich liefert danach den /rename-Namen (touch: false).
  inbox.registrySync().upsert({ pid: process.pid, sessionId: "c1", cwd: "/p/claribill", name: "PM claribill", nameSource: "user", startedAt: null });
  assert.equal(role(inbox, "c1"), "pm");
  // Auch ein automatischer Registry-Name (name_source = 'registry') zählt.
  inbox.upsertSession({ id: "c2", app: "claude", cwd: "/p/geembee" });
  inbox.registrySync().upsert({ pid: process.pid, sessionId: "c2", cwd: "/p/geembee", name: "PM geembee", nameSource: "auto", startedAt: null });
  assert.equal(role(inbox, "c2"), "pm");
});

test("#28/1 Codex: nativer Name aus der App vergibt die Rolle, auch bei späterer Umbenennung (Befund 2)", () => {
  const { inbox, titles } = setup();
  inbox.upsertSession({ id: "x1", app: "codex", cwd: "/p/adsimple-at" });
  assert.equal(role(inbox, "x1"), null);
  titles.set("codex:x1", "PM adsimple.at");
  inbox.syncNameRoles?.(); // nach jedem Abgleich der nativen Namen
  assert.equal(role(inbox, "x1"), "pm", "nativer Codex-Name gilt");
  // Nächster Hook ohne Namen: Rolle bleibt
  inbox.upsertSession({ id: "x1", app: "codex", cwd: "/p/adsimple-at", status: "working" });
  assert.equal(role(inbox, "x1"), "pm");
  // Ein Codex-Chat, der erst später umbenannt wird
  inbox.upsertSession({ id: "x2", app: "codex", cwd: "/p/off" });
  titles.set("codex:x2", "Director");
  inbox.syncNameRoles?.();
  assert.equal(role(inbox, "x2"), "director");
});

test("#28/1 Antigravity: Name vom Hook vergibt die Rolle bei Anmeldung", () => {
  const { inbox } = setup();
  assert.equal(inbox.upsertSession({ id: "a1", app: "antigravity", cwd: "/p/firma", name: "PM firma" }).role, "pm");
});

// ---- Kriterium 2: genau ein PM/Director; Konflikte sichtbar statt still umgehängt ---------

test("#28/2 Zweiter Namensanspruch hängt nicht still um: Inhaber behält, Konflikt wird genannt", () => {
  const { inbox, titles } = setup();
  inbox.upsertSession({ id: "cl", app: "claude", cwd: "/p/mailaura", name: "PM mailaura" });
  assert.equal(role(inbox, "cl"), "pm");
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/mailaura" });
  titles.set("codex:cx", "PM mailaura");
  inbox.syncNameRoles?.();
  assert.equal(role(inbox, "cl"), "pm", "bisheriger Inhaber behält die Rolle");
  assert.equal(role(inbox, "cx"), null);
  const cx = inbox.sessions().find((s) => s.id === "cx")!;
  assert.deepEqual(cx.roleConflict && { role: cx.roleConflict.role, holderId: cx.roleConflict.holderId }, { role: "pm", holderId: "cl" });
  // Auch ein Hook-Name eines weiteren Chats hängt nicht um
  inbox.upsertSession({ id: "ag", app: "antigravity", cwd: "/p/mailaura", name: "PM mailaura" });
  assert.equal(role(inbox, "cl"), "pm");
  assert.equal(role(inbox, "ag"), null);
  // Director genauso
  inbox.upsertSession({ id: "d1", app: "claude", cwd: "/p/zentrale", name: "Director" });
  inbox.upsertSession({ id: "d2", app: "codex", cwd: "/p/zentrale", name: "Director" });
  assert.equal(role(inbox, "d1"), "director");
  assert.equal(role(inbox, "d2"), null);
  assert.equal(inbox.sessions().find((s) => s.id === "d2")!.roleConflict?.holderId, "d1");
  // Andere Projekte bleiben unberührt
  inbox.upsertSession({ id: "o", app: "claude", cwd: "/p/other", name: "PM other" });
  assert.equal(role(inbox, "o"), "pm");
  assert.equal(role(inbox, "cl"), "pm");
});

test("#28/2 Beanspruchen zwei Nicht-Claude-Chats gleichzeitig eine freie Rolle, bekommt sie keiner still", () => {
  const { inbox, titles } = setup();
  // Mit einem Claude-Chat darunter gilt der Claude-Vorrang (#48), siehe claude-priority.test.ts.
  inbox.upsertSession({ id: "cl", app: "codex", cwd: "/p/chatreact" });
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/chatreact" });
  titles.set("codex:cl", "PM chatreact");
  titles.set("codex:cx", "PM chatreact");
  inbox.syncNameRoles?.();
  assert.equal(role(inbox, "cl"), null);
  assert.equal(role(inbox, "cx"), null);
  for (const id of ["cl", "cx"]) {
    const c = inbox.sessions().find((s) => s.id === id)!.roleConflict;
    assert.equal(c?.role, "pm");
    assert.equal(c?.holderId, null);
  }
  // Ein ausdrücklicher Wechsel löst den Konflikt
  inbox.setRole("cl", "pm", "Test");
  assert.equal(role(inbox, "cl"), "pm");
  assert.equal(inbox.sessions().find((s) => s.id === "cl")!.roleConflict, null);
  assert.equal(inbox.sessions().find((s) => s.id === "cx")!.roleConflict?.holderId, "cl");
});

test("#28/2 Bestehende Rollen bleiben beim Start gegenüber Nicht-Claude-Anwärtern unverändert", () => {
  const { db, board } = setup();
  const first = new Inbox(db, board);
  first.upsertSession({ id: "codexpm", app: "codex", cwd: "/p/firma" });
  first.setRole("codexpm", "pm", "Test");
  // Neuer Daemon-Start: Ein Antigravity-Chat mit PM-Namen meldet sich zuerst.
  // Ein Claude-Chat bekäme die Rolle (#48), siehe claude-priority.test.ts.
  const second = new Inbox(db, board);
  second.upsertSession({ id: "agpm", app: "antigravity", cwd: "/p/firma", name: "PM firma" });
  second.syncNameRoles?.();
  assert.equal(role(second, "codexpm"), "pm");
  assert.equal(role(second, "agpm"), null);
});

test("#28/2 Review: Inhaber verliert PM nicht durch Umbenennen, beendete Chats bekommen keine exklusive Rolle", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "pm", app: "claude", cwd: "/p/x", name: "PM x" });
  inbox.renameSession("pm", "Director x");
  assert.equal(role(inbox, "pm"), "pm", "PM wird nur ausdrücklich abgegeben");
  inbox.upsertSession({ id: "alt", app: "codex", cwd: "/p/x" });
  inbox.endSession("alt");
  assert.throws(() => inbox.setRole("alt", "pm", "dashboard"), /beendet/);
  assert.equal(role(inbox, "pm"), "pm");
});

// ---- Kriterien 3 und 4: set_role über MCP, Rechte, Protokoll, wartende Post ---------------

const TOKEN = "t";
async function daemonWith(inbox: Inbox, board: Board, db: ReturnType<typeof openDb>) {
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-roles-")), timeoutMs: 5000, log: () => {} });
  const d = createDaemon(inbox, board, runner, { log: () => {}, token: TOKEN, probe: { owner: async () => null, agentChain: async () => [] } });
  await new Promise<void>((r) => d.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(d.server.address() as net.AddressInfo).port}`;
  const clients: Client[] = [];
  const call = async (app: string, cwd: string, name: string, args: Record<string, unknown>) => {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${app}?app=${app}`), { requestInit: { headers: { "x-crewpip-token": TOKEN } } }));
    clients.push(c);
    const res = (await c.callTool({ name, arguments: { cwd, ...args } })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((x) => x.text).join("\n"), isError: !!res.isError };
  };
  return { base, call, close: async () => { for (const c of clients) await c.close(); await d.close(); } };
}

test("#28/3+4 set_role: nur Inhaber, Director oder PM crewpip; protokolliert; wartende Post geht an den neuen PM", async (t) => {
  const { db, board, inbox, titles } = setup();
  const d = await daemonWith(inbox, board, db);
  t.after(d.close);
  // claribill: Codex hält die Rolle, der Claude-Chat beansprucht sie noch nicht per Namen
  // (sonst bekäme er sie automatisch, #48).
  inbox.upsertSession({ id: "cx-pm", app: "codex", cwd: "/p/claribill" });
  inbox.setRole("cx-pm", "pm", "Test");
  inbox.upsertSession({ id: "cl-pm", app: "claude", cwd: "/p/claribill/.claude/worktrees/pm" });
  inbox.upsertSession({ id: "fremd", app: "antigravity", cwd: "/p/anderes", name: "Worker anderes" });
  inbox.upsertSession({ id: "dir", app: "cursor", cwd: "/p/zentrale", name: "Director" });
  inbox.upsertSession({ id: "pm-crewpip", app: "claude", cwd: "/p/crewpip", name: "PM crewpip" });
  inbox.upsertSession({ id: "pm-other", app: "codex", cwd: "/p/other", name: "PM other" });

  // Wartende Post an einen PM ohne Empfänger
  inbox.upsertSession({ id: "leer", app: "antigravity", cwd: "/p/leer/.claude/worktrees/w" });
  const waiting = inbox.post({ sessionId: "fremd" }, "pm:leer", "Für den künftigen PM");
  assert.deepEqual(waiting.pending, []);

  // Fremde dürfen nicht
  const denied = await d.call("antigravity", "/p/anderes", "set_role", { session: "session:cl-pm", role: "pm" });
  assert.equal(denied.isError, true);
  assert.equal(role(inbox, "cx-pm"), "pm");
  const deniedPm = await d.call("codex", "/p/other", "set_role", { session: "cl-pm", role: "pm" });
  assert.equal(deniedPm.isError, true, "PM eines anderen Projekts darf nicht");

  // Der Inhaber darf übergeben
  const ok = await d.call("codex", "/p/claribill", "set_role", { session: "session:cl-pm", role: "pm" });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(role(inbox, "cl-pm"), "pm");
  assert.equal(role(inbox, "cx-pm"), null);
  titles.set("claude:cl-pm", "PM claribill");

  // Director und PM crewpip dürfen überall
  assert.equal((await d.call("cursor", "/p/zentrale", "set_role", { session: "leer", role: "pm" })).isError, false);
  assert.equal(role(inbox, "leer"), "pm");
  assert.deepEqual(inbox.pendingFor("leer").map((m) => m.id), [waiting.id], "wartende Post geht an den neuen PM");
  assert.equal((await d.call("claude", "/p/crewpip", "set_role", { session: "cx-pm", role: "worker" })).isError, false);
  assert.equal(role(inbox, "cx-pm"), "worker");

  // Protokoll: wer, wann, von wem zu wem
  const log = inbox.roleChanges();
  const handover = log.find((c) => c.toSession === "cl-pm" && c.role === "pm");
  assert.ok(handover, "Übergabe protokolliert");
  assert.equal(handover!.fromSession, "cx-pm");
  assert.equal(handover!.actor, "session:cx-pm");
  assert.match(handover!.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(log.find((c) => c.toSession === "leer")?.actor, "session:dir");
  // Die Ablehnung ist nicht protokolliert, die Rolle blieb
  assert.ok(!log.some((c) => c.actor === "session:fremd"));

  // list_sessions nennt Konflikte
  inbox.upsertSession({ id: "cx-2", app: "codex", cwd: "/p/claribill/.claude/worktrees/x" });
  titles.set("codex:cx-2", "PM claribill");
  inbox.syncNameRoles?.();
  // Am Claude-Anwärter vorbei lehnt set_role mit Begründung ab (#48).
  const blocked = await d.call("cursor", "/p/zentrale", "set_role", { session: "cx-2", role: "pm" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /Claude-Vorrang/);
  assert.equal(role(inbox, "cl-pm"), "pm");
  const listed = await d.call("antigravity", "/p/anderes", "list_sessions", {});
  assert.match(listed.text, /Konflikt/);
  assert.match(listed.text, /PM claribill.*\[PM\]/);
});

test("#28/3 Dashboard: Rollenwechsel über die API wird mit Akteur protokolliert", async (t) => {
  const { db, board, inbox } = setup();
  const d = await daemonWith(inbox, board, db);
  t.after(d.close);
  inbox.upsertSession({ id: "a", app: "claude", cwd: "/p/x", name: "PM x" });
  inbox.upsertSession({ id: "b", app: "codex", cwd: "/p/x" });
  const patch = () => fetch(`${d.base}/api/sessions/b`, { method: "PATCH", headers: { "content-type": "application/json", "x-crewpip-token": TOKEN }, body: JSON.stringify({ role: "pm" }) });
  // Claude-Vorrang (#48): solange a die Rolle per Namen beansprucht, lehnt die API ab.
  const denied = await patch();
  assert.equal(denied.status, 400);
  assert.match(((await denied.json()) as { error: string }).error, /Claude-Vorrang/);
  inbox.renameSession("a", "Planung x");
  const res = await patch();
  assert.equal(res.status, 200);
  assert.equal(role(inbox, "b"), "pm");
  assert.equal(role(inbox, "a"), null);
  const c = inbox.roleChanges().find((x) => x.toSession === "b");
  assert.equal(c?.fromSession, "a");
  assert.equal(c?.actor, "dashboard");
  const api = (await (await fetch(`${d.base}/api/role-changes`, { headers: { "x-crewpip-token": TOKEN } })).json()) as { toSession: string }[];
  assert.ok(api.some((x) => x.toSession === "b"));
});

after(() => {});
