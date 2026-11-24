/**
 * Akzeptanztests für Antigravity als vierte App (#20): Hook-Weg mit conversationId,
 * einmalige Zustellung trotz PreInvocation vor jedem Modellaufruf, Schleifensperre über
 * Turn-Grenzen und Unterscheidung mehrerer Gespräche über den gemeinsamen Prozess.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseTarget, APP_LABELS, type HookResponse, type Message } from "@crewpip/shared";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { Board } from "../src/board.js";
import { Runner } from "../src/runner/index.js";
import { createDaemon, type DaemonHandle } from "../src/http.js";
import { snippets } from "../src/setup.js";
import type { Proc, ProcessProbe } from "../src/peer.js";

const TOKEN = "test-token";
let daemon: DaemonHandle;
let base = "";
const proc = { caller: null as Proc | null, chain: [] as Proc[] };
const probe: ProcessProbe = { owner: async () => proc.caller, agentChain: async () => proc.chain };
/** Alle Antigravity-Gespräche laufen über den language_server der App (gemessen 20.11.2026). */
const LS: Proc = { pid: 960001, comm: "language_server" };

before(async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-runs-")), timeoutMs: 5000, log: () => {} });
  daemon = createDaemon(new Inbox(db, board), board, runner, { log: () => {}, token: TOKEN, probe });
  await new Promise<void>((r) => daemon.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(daemon.server.address() as net.AddressInfo).port}`;
});
after(async () => {
  await daemon.close();
});

function get(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-crewpip-token", TOKEN);
  return globalThis.fetch(url, { ...init, headers });
}
async function hook(event: string, body: Record<string, unknown>) {
  const res = await get(`${base}/hooks/antigravity/notice/${event}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "antigravity", ...body }) });
  assert.equal(res.status, 200);
  return (await res.json()) as HookResponse;
}
const postHuman = (to: string, text: string) =>
  get(`${base}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "Mensch", to, text }) });
const text = (res: unknown) => (res as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

test("Antigravity ist eine eigene App-Art mit Namen und Zieladresse", () => {
  assert.equal(APP_LABELS.antigravity, "Antigravity");
  assert.deepEqual(parseTarget("app:antigravity"), { kind: "app", app: "antigravity" });
});

test("Hook meldet ein Antigravity-Gespräch unter seiner conversationId an", async () => {
  proc.chain = [LS, { pid: 960000, comm: "Antigravity" }];
  const r = await hook("session-start", { sessionId: "ag-1", cwd: "/p/ag-projekt" });
  proc.chain = [];
  assert.equal(r.session?.id, "ag-1");
  assert.match(r.session!.label, /^Antigravity · ag-projekt \//);
  const s = daemon.inbox.sessions().find((x) => x.id === "ag-1")!;
  assert.equal(s.app, "antigravity");
  assert.equal(s.connection, "stale", "Testprozess lebt nicht; entscheidend ist, dass die Kette gespeichert ist");
});

test("Antigravity-Hooks lassen Post bis zur einmaligen Übernahme über MCP im Postfach", async (t) => {
  const cwd = "/p/abholung";
  const sessionId = "ag-abholung";
  const payload = { sessionId, cwd };
  const register = await get(`${base}/hooks/antigravity/session-start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(register.status, 200);
  await postHuman(`session:${sessionId}`, "Prüfwort 36");
  const deliveries = async () => {
    const messages = await (await get(`${base}/api/messages`)).json() as Message[];
    return messages.find(m => m.text === "Prüfwort 36")!.deliveries.map(d => d.method);
  };
  const req = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, turnStart: false }) };
  // Beide Versionsrichtungen beim Update: Auf dem Ausgangsstand quittiert schon der alte
  // Hook. Er darf auf dem neuen Daemon auch den Hinweis an den aktualisierten Hook nicht verbrauchen.
  const legacy = await get(`${base}/hooks/antigravity/prompt`, req);
  const legacyResponse = await legacy.json() as HookResponse;
  assert.deepEqual(legacyResponse.messages, []);
  assert.ok(!legacyResponse.inboxNotice);
  assert.deepEqual(await deliveries(), []);
  const first = await hook("prompt", { ...payload, turnStart: false });
  assert.equal(first.inboxNotice, true, "erster neuer Hook im selben Turn erhält den Hinweis");
  const start = await hook("session-start", payload);
  assert.deepEqual(start.messages, [], "Start-Hook erhält keine Nachrichteninhalte");
  assert.equal(start.inboxNotice, true);
  const denied = await fetch(`${base}/hooks/antigravity/notice/prompt`, req);
  assert.equal(denied.status, 401, "der Hinweis-Endpunkt verlangt wie bisher das lokale Token");
  const prompt = await hook("prompt", { ...payload, turnStart: true });
  assert.deepEqual(prompt.messages, []);
  for (let i = 0; i < 3; i++) {
    assert.ok(!(await hook("prompt", { ...payload, turnStart: false })).inboxNotice);
  }
  const stop = await hook("stop", payload);
  assert.equal(stop.inboxNotice, true, "Stop bietet einen weiteren Abholweg");
  assert.ok(!(await hook("stop", payload)).inboxNotice, "derselbe Rückstand startet keine Endlosschleife");
  const newHook = await get(`${base}/hooks/antigravity/notice/prompt`, req);
  assert.equal(newHook.status, 200);
  assert.deepEqual(((await newHook.json()) as HookResponse).messages, [], "der versionierte Hinweis-Endpunkt quittiert ebenfalls nichts");
  assert.deepEqual(await deliveries(), [], "keine vermeintliche Zustellung durch Hooks");
  const client = new Client({ name: "abnahmetest", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/antigravity?app=antigravity`), { requestInit: { headers: { "x-crewpip-token": TOKEN } } }));
  t.after(() => client.close());
  const read = () => client.callTool({ name: "read_inbox", arguments: { cwd } });
  assert.match(text(await client.callTool({ name: "list_sessions", arguments: { cwd } })), /\* Antigravity/);
  const pair = await Promise.all([read(), read()]);
  assert.equal(pair.filter(r => text(r).includes("Prüfwort 36")).length, 1);
  assert.deepEqual(await deliveries(), ["mcp-read"]);
  await postHuman(`session:${sessionId}`, "Prüfwort warten");
  assert.equal((await hook("prompt", { ...payload, turnStart: false })).inboxNotice, true);
  const wait = await client.callTool({ name: "wait_for_message", arguments: { cwd, timeout_seconds: 1 } });
  assert.match(text(wait), /Prüfwort warten/);
  assert.doesNotMatch(text(await read()), /Prüfwort/);
  assert.ok(!(await hook("stop", payload)).inboxNotice);
});

test("Schleifensperre bleibt bei PreInvocation im selben Turn erhalten", async () => {
  const payload = { sessionId: "ag-1", cwd: "/p/ag-projekt" };
  const max = 10;
  for (let i = 0; i < max; i++) daemon.inbox.countStopContinuation("ag-1", max);
  await postHuman("session:ag-1", "#20 gesperrt");
  assert.equal((await hook("stop", payload)).mayContinue, false);
  await hook("prompt", { ...payload, turnStart: false });
  assert.ok(!(await hook("stop", payload)).inboxNotice);
  await hook("prompt", { ...payload, turnStart: true });
  const stop = await hook("stop", payload);
  assert.equal(stop.mayContinue, true);
  assert.equal(stop.inboxNotice, true);
  assert.equal(daemon.inbox.pendingFor("ag-1")[0]?.text, "#20 gesperrt");
});

test("Zwei Gespräche im selben Repo teilen den Prozess: Schlüssel trennt sie, ohne Schlüssel wird abgelehnt", async () => {
  const cwd = "/p/ag-gemeinsam";
  proc.chain = [LS, { pid: 960000, comm: "Antigravity" }];
  await hook("session-start", { sessionId: "ag-a", cwd });
  const b = await hook("session-start", { sessionId: "ag-b", cwd });
  proc.chain = [];
  const keyB = b.sessionKey!;
  const keyA = (await hook("prompt", { sessionId: "ag-a", cwd, turnStart: true })).sessionKey!;
  assert.ok(keyA && keyB && keyA !== keyB);
  // Jede Einspielung bleibt in Antigravity als sichtbare Nachricht stehen. Weitere Modellaufrufe
  // im selben Turn bekommen den Schlüssel deshalb nicht noch einmal, außer zusammen mit Post.
  assert.equal((await hook("prompt", { sessionId: "ag-a", cwd, turnStart: false })).sessionKey, undefined, "kein Schlüssel bei jedem Modellaufruf");
  await postHuman("session:ag-a", "#20 an a");
  const mitPost = await hook("prompt", { sessionId: "ag-a", cwd, turnStart: false });
  assert.equal(mitPost.sessionKey, keyA, "mit Post reist der Schlüssel mit");
  assert.equal(mitPost.inboxNotice, true);
  assert.deepEqual(mitPost.messages, []);

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/antigravity?app=antigravity`), { requestInit: { headers: { "x-crewpip-token": TOKEN } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    proc.caller = LS;
    try {
      return await client.callTool({ name, arguments: { cwd, ...args } });
    } finally {
      proc.caller = null;
    }
  };
  const ohne = (await call("post_message", { to: "all", text: "#20 ohne" })) as { isError?: boolean };
  assert.equal(ohne.isError, true, "ohne Schlüssel abgelehnt");
  assert.match(text(ohne), /nicht sicher erkennen/);
  assert.doesNotMatch(text(await call("list_sessions", {})), /\* Antigravity/, "ohne Schlüssel kein Stern");
  assert.match(text(await call("list_sessions", { session_key: keyA })), /\* Antigravity \/ /, "eigener Stern");
  assert.doesNotMatch(text(await call("read_inbox", { session_key: keyB })), /#20 an a/);
  assert.match(text(await call("read_inbox", { session_key: keyA })), /#20 an a/);
  assert.match(text(await call("post_message", { to: "all", text: "#20 mit", session_key: keyB })), /von Antigravity · ag-gemeinsam \//);
  await client.close();
});

test("Snippets für Antigravity: MCP über serverUrl mit Token-Header, Hooks im flachen Format", () => {
  const mcp = JSON.parse(snippets.antigravityMcp.content);
  assert.match(mcp.mcpServers.crewpip.serverUrl, /\/mcp\/antigravity\?app=antigravity$/);
  assert.ok(mcp.mcpServers.crewpip.headers["x-crewpip-token"]);
  const hooks = JSON.parse(snippets.antigravityHooks.content);
  const def = hooks.crewpip;
  assert.deepEqual(Object.keys(def).sort(), ["PreInvocation", "SessionStart", "Stop"]);
  assert.match(def.SessionStart[0].command, /crewpip-hook\.mjs antigravity session-start$/);
  assert.match(def.PreInvocation[0].command, /crewpip-hook\.mjs antigravity prompt$/);
  assert.match(def.Stop[0].command, /crewpip-hook\.mjs antigravity stop$/);
  assert.equal(def.Stop[0].hooks, undefined, "Stop ist eine flache Liste");
});
