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
import { parseTarget, APP_LABELS } from "@crewpip/shared";
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
  const res = await get(`${base}/hooks/antigravity/${event}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "antigravity", ...body }) });
  return (await res.json()) as { session: { id: string; label: string } | null; messages: { text: string }[]; mayContinue: boolean; sessionKey?: string };
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

test("PreInvocation: jede Nachricht genau einmal, auch bei vielen Modellaufrufen im Turn", async () => {
  await postHuman("session:ag-1", "#20 eins");
  const turn = "t-1";
  const first = await hook("prompt", { sessionId: "ag-1", cwd: "/p/ag-projekt", turn });
  assert.deepEqual(first.messages.map((m) => m.text), ["#20 eins"]);
  for (let i = 0; i < 3; i++) {
    const again = await hook("prompt", { sessionId: "ag-1", cwd: "/p/ag-projekt", turn });
    assert.deepEqual(again.messages, [], `Modellaufruf ${i + 2}: nichts doppelt`);
  }
  const msgs = (await (await get(`${base}/api/messages`)).json()) as { text: string; deliveries: { sessionId: string; method: string }[] }[];
  const d = msgs.find((m) => m.text === "#20 eins")!.deliveries;
  assert.deepEqual(d.map((x) => [x.sessionId, x.method]), [["ag-1", "hook-prompt"]], "genau ein Zustellnachweis");
});

test("Schleifensperre: PreInvocation im selben Turn hebt sie nicht auf, ein neuer Prompt schon", async () => {
  const max = 10;
  for (let i = 0; i < max; i++) daemon.inbox.countStopContinuation("ag-1", max);
  await postHuman("session:ag-1", "#20 gesperrt");
  let stop = await hook("stop", { sessionId: "ag-1", cwd: "/p/ag-projekt" });
  assert.equal(stop.mayContinue, false, "Sperre greift");
  // Nach einem Stop mit "continue" ruft Antigravity das Modell erneut auf; PreInvocation
  // feuert mit demselben Turn. Das darf die Sperre nicht zurücksetzen.
  await hook("prompt", { sessionId: "ag-1", cwd: "/p/ag-projekt", turn: "t-1" });
  stop = await hook("stop", { sessionId: "ag-1", cwd: "/p/ag-projekt" });
  assert.equal(stop.mayContinue, true, "PreInvocation hat die Nachricht schon zugestellt, nichts mehr offen");
  await postHuman("session:ag-1", "#20 noch eine");
  stop = await hook("stop", { sessionId: "ag-1", cwd: "/p/ag-projekt" });
  assert.equal(stop.mayContinue, false, "gleicher Turn: Sperre bleibt");
  // Ein neuer menschlicher Prompt ist ein neuer Turn.
  const neu = await hook("prompt", { sessionId: "ag-1", cwd: "/p/ag-projekt", turn: "t-2" });
  assert.deepEqual(neu.messages.map((m) => m.text), ["#20 noch eine"]);
  await postHuman("session:ag-1", "#20 nach Prompt");
  stop = await hook("stop", { sessionId: "ag-1", cwd: "/p/ag-projekt" });
  assert.equal(stop.mayContinue, true);
  assert.deepEqual(stop.messages.map((m) => m.text), ["#20 nach Prompt"]);
});

test("Zwei Gespräche im selben Repo teilen den Prozess: Schlüssel trennt sie, ohne Schlüssel wird abgelehnt", async () => {
  const cwd = "/p/ag-gemeinsam";
  proc.chain = [LS, { pid: 960000, comm: "Antigravity" }];
  await hook("session-start", { sessionId: "ag-a", cwd });
  const b = await hook("session-start", { sessionId: "ag-b", cwd });
  proc.chain = [];
  const keyB = b.sessionKey!;
  const keyA = (await hook("prompt", { sessionId: "ag-a", cwd, turn: "x" })).sessionKey!;
  assert.ok(keyA && keyB && keyA !== keyB);

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
