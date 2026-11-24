import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { Board } from "../src/board.js";
import { Runner } from "../src/runner/index.js";
import { codexApp } from "../src/runner/apps.js";
import { createDaemon, type DaemonHandle } from "../src/http.js";
import type { Proc, ProcessProbe } from "../src/peer.js";

const TOKEN = "test-token";
let daemon: DaemonHandle;
let base = "";
const logs: string[] = [];
/** Attrappe für das Betriebssystem: der Test legt fest, welcher Prozess gerade anruft. */
const proc = { caller: null as Proc | null, chain: [] as Proc[] };
const probe: ProcessProbe = { owner: async () => proc.caller, agentChain: async () => proc.chain };

before(async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-runs-")), timeoutMs: 5000, log: (l) => logs.push(l) });
  daemon = createDaemon(new Inbox(db, board), board, runner, { log: (l) => logs.push(l), token: TOKEN, probe });
  await new Promise<void>((r) => daemon.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(daemon.server.address() as net.AddressInfo).port}`;
});
after(async () => {
  await daemon.close();
});

async function mcpClient(app: string) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp/${app}?app=${app}`), {
      requestInit: { headers: { "x-crewpip-token": TOKEN } },
    }),
  );
  return client;
}

/** fetch mit Token, damit die Tests nicht an der Anmeldung scheitern. */
function get(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-crewpip-token", TOKEN);
  return globalThis.fetch(url, { ...init, headers });
}
const text = (res: unknown) => (res as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

async function hook(app: string, event: string, body: Record<string, unknown>) {
  const res = await get(`${base}/hooks/${app}/${event}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { session: { id: string; label: string } | null; messages: { text: string }[]; mayContinue: boolean; sessionKey?: string } };
}
const postHuman = (to: string, text: string) =>
  get(`${base}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "Mensch", to, text }) });

test("Hooks melden Sessions mit Projekt und Status an", async () => {
  const r = await hook("claude", "session-start", { app: "claude", sessionId: "c-example", cwd: "/p/example-project", name: "api-worker" });
  assert.equal(r.status, 200);
  assert.equal(r.json.session?.label, "Claude · example-project / api-worker");
  await hook("codex", "session-start", { app: "codex", sessionId: "x-example", cwd: "/p/example-project" });
  await hook("claude", "prompt", { app: "claude", sessionId: "c-example", cwd: "/p/example-project" });
  const sessions = (await (await get(`${base}/api/sessions`)).json()) as { id: string; status: string; project: string }[];
  assert.equal(sessions.find((s) => s.id === "c-example")?.status, "working");
  assert.equal(sessions.find((s) => s.id === "x-example")?.project, "example-project");
  assert.equal((await hook("claude", "prompt", { app: "claude" })).json.session, null, "ohne Session-ID passiert nichts");
});

test("MCP: Tools erkennen die Session über cwd, post_message erreicht Projekt und Session", async () => {
  const codex = await mcpClient("codex");
  assert.deepEqual((await codex.listTools()).tools.map((t) => t.name).sort(), [
    "claim_task", "create_task", "list_runs", "list_sessions", "list_tasks", "post_message",
    "read_inbox", "set_role", "start_run", "stop_run", "update_task", "wait_for_message",
  ]);

  const list = text(await codex.callTool({ name: "list_sessions", arguments: { cwd: "/p/example-project" } }));
  assert.match(list, /Projekt example-project/);
  assert.match(list, /\* Codex \/ Session/);
  assert.match(list, /Ziel: session:c-example/);

  const posted = text(await codex.callTool({ name: "post_message", arguments: { cwd: "/p/example-project", to: "session:c-example", text: "Migration 0042 ist auf main" } }));
  assert.match(posted, /von Codex · example-project \/ Session .* an Claude · example-project \/ api-worker \(wartet bei: Claude · example-project \/ api-worker\)/);

  const claude = await mcpClient("claude");
  const inboxText = text(await claude.callTool({ name: "read_inbox", arguments: { cwd: "/p/example-project" } }));
  assert.match(inboxText, /von: Codex · example-project \/ Session/);
  assert.match(inboxText, /antworten an: session:x-example/);
  assert.match(inboxText, /Migration 0042 ist auf main/);
  assert.match(text(await claude.callTool({ name: "read_inbox", arguments: { cwd: "/p/example-project" } })), /Keine neuen Nachrichten/);

  // Ohne Hook-Anmeldung legt der Daemon eine Session "ohne Hook" an
  const cursor = await mcpClient("cursor");
  assert.match(text(await cursor.callTool({ name: "list_sessions", arguments: { cwd: "/p/neu" } })), /\* Cursor \/ ohne Hook/);
  await codex.close(); await claude.close(); await cursor.close();
});

test("MCP: wait_for_message wacht auf, wenn ein Mensch an das Projekt schreibt", async () => {
  const codex = await mcpClient("codex");
  const waiting = codex.callTool({ name: "wait_for_message", arguments: { cwd: "/p/example-project", timeout_seconds: 5 } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await postHuman("project:example-project", "Stopp mit dem Deploy")).status, 201);
  const got = text(await waiting);
  assert.match(got, /von: Mensch/);
  assert.match(got, /an: Projekt example-project/);
  assert.match(got, /antworten an: human:Mensch/);
  await codex.close();
});

for (const name of ["read_inbox", "wait_for_message"]) {
  test(`MCP: Verbindungsabbruch während der Identitätsprüfung lässt Post für ${name} liegen`, { timeout: 5000 }, async (t) => {
    const cwd = `/p/abbruch-${name}`;
    const id = `abbruch-${name}`;
    daemon.inbox.upsertSession({ id, app: "antigravity", cwd });
    const message = daemon.inbox.post({ human: "Mensch" }, `session:${id}`, "für den nächsten Abruf");

    const searching = Promise.withResolvers<void>();
    const owner = Promise.withResolvers<null>();
    t.mock.method(probe, "owner", () => {
      searching.resolve();
      return owner.promise;
    });
    const closed = new Promise<void>((resolve) => daemon.server.once("request", (_req, res) => res.once("close", resolve)));
    const controller = new AbortController();
    const request = get(`${base}/mcp/antigravity`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { cwd } } }),
      signal: controller.signal,
    }).then(response => response.text());
    await searching.promise;
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    await closed;
    owner.resolve(null);
    // Die Identität ist ermittelt, der Handler und seine Folge-Promises sind gelaufen.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(daemon.inbox.message(message.id)!.deliveries, []);
    assert.deepEqual(daemon.inbox.pendingFor(id).map(m => m.id), [message.id]);
  });
}

test("Hooks: prompt liefert Ausstehendes, stop respektiert die Schleifensperre", async () => {
  // Die Projekt-Nachricht von oben wartet noch bei c-example
  let r = await hook("claude", "prompt", { app: "claude", sessionId: "c-example", cwd: "/p/example-project" });
  assert.deepEqual(r.json.messages.map((m) => m.text), ["Stopp mit dem Deploy"]);

  r = await hook("claude", "stop", { app: "claude", sessionId: "c-example", cwd: "/p/example-project" });
  assert.deepEqual(r.json.messages, [], "nichts Neues: kein Fortsetzen");

  await postHuman("session:c-example", "zwei");
  r = await hook("claude", "stop", { app: "claude", sessionId: "c-example", cwd: "/p/example-project" });
  assert.deepEqual(r.json.messages.map((m) => m.text), ["zwei"]);

  for (let i = 0; i < 20; i++) daemon.inbox.countStopContinuation("c-example", 100);
  await postHuman("session:c-example", "drei");
  r = await hook("claude", "stop", { app: "claude", sessionId: "c-example", cwd: "/p/example-project" });
  assert.equal(r.json.mayContinue, false);
  assert.deepEqual(r.json.messages, []);
  r = await hook("claude", "prompt", { app: "claude", sessionId: "c-example", cwd: "/p/example-project" });
  assert.deepEqual(r.json.messages.map((m) => m.text), ["drei"], "menschlicher Prompt hebt die Sperre auf");
  assert.equal((await hook("claude", "unknown", {})).status, 404);
});


test("API: Läufe starten, Grenzen und Verfügbarkeit", async () => {
  const apps = (await (await get(`${base}/api/runner/apps`)).json()) as { app: string; bin: string | null; loggedIn: boolean | null; hint: string }[];
  assert.deepEqual(apps.map((a) => a.app).sort(), ["claude", "codex"]);
  assert.ok(apps.every((a) => "loggedIn" in a), "der Anmeldestatus gehört zur Auskunft");

  // Ohne Projekt oder Task lehnt der Daemon ab
  const bad = await get(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", app: "codex", mode: "read-only" }) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /Weder Task noch Projekt/);

  // Mit Stub-Programm läuft ein echter Prozess durch
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-stub-"));
  const stub = path.join(stubDir, "stub.sh");
  fs.writeFileSync(stub, `#!/bin/sh\necho '{"type":"item.completed","item":{"type":"agent_message","text":"erledigt"}}'\nexit 0`, { mode: 0o755 });
  const original = codexApp.bin;
  const originalAuth = codexApp.loggedIn;
  codexApp.bin = () => stub;
  codexApp.loggedIn = () => true;
  try {
    // Ein Lauf braucht ein Verzeichnis, das es wirklich gibt.
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-proj-")));
    await hook("claude", "session-start", { app: "claude", sessionId: "s-real", cwd: real });
    const projects = (await (await get(`${base}/api/projects`)).json()) as { id: string; root: string }[];
    const p = projects.find((x) => x.root === real)!;
    const started = await get(`${base}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, prompt: "Sieh dir das an", app: "codex", mode: "read-only" }),
    });
    assert.equal(started.status, 201);
    const run = (await started.json()) as { id: number; status: string; mode: string };
    assert.equal(run.mode, "read-only");
    for (let i = 0; i < 60; i++) {
      const cur = (await (await get(`${base}/api/runs`)).json()) as { id: number; status: string; summary: string }[];
      if (cur.find((r) => r.id === run.id)!.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const after = (await (await get(`${base}/api/runs`)).json()) as { id: number; status: string; summary: string }[];
    assert.equal(after.find((r) => r.id === run.id)!.status, "done");
    assert.equal(after.find((r) => r.id === run.id)!.summary, "erledigt");
    const items = (await (await get(`${base}/api/runs/${run.id}/items`)).json()) as { kind: string; text: string }[];
    assert.deepEqual(items, [{ kind: "message", text: "erledigt", at: items[0]!.at as unknown as string }] as never);
  } finally {
    codexApp.bin = original;
    codexApp.loggedIn = originalAuth;
  }
});

test("API: Umbenennen und Fehler", async () => {
  const r = await get(`${base}/api/sessions/c-example`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "deploy" }) });
  assert.equal(((await r.json()) as { label: string }).label, "Claude · example-project / deploy");
  assert.equal((await postHuman("session:gibts-nicht", "x")).status, 400);
  assert.equal((await postHuman("foo:bar", "x")).status, 400);
});

test("API: eine Session austragen, sie kehrt bei neuer Aktivität zurück", async () => {
  await hook("codex", "session-start", { app: "codex", sessionId: "x-weg", cwd: "/p/alt" });
  assert.equal((await get(`${base}/api/sessions/x-weg`, { method: "DELETE" })).status, 204);
  const after = (await (await get(`${base}/api/sessions`)).json()) as { id: string }[];
  assert.ok(!after.some((s) => s.id === "x-weg"));
  await hook("codex", "prompt", { app: "codex", sessionId: "x-weg", cwd: "/p/alt" });
  const back = (await (await get(`${base}/api/sessions`)).json()) as { id: string }[];
  assert.ok(back.some((s) => s.id === "x-weg"), "meldet sie sich wieder, ist sie zurück");
});

test("API: Aufgaben anlegen, zuweisen (mit Nachricht an die Session) und Status wechseln", async () => {
  const projects = (await (await get(`${base}/api/projects`)).json()) as { id: string; name: string }[];
  const p = projects.find((x) => x.name === "example-project")!;
  assert.ok(p, "Projekte entstehen automatisch aus den Sessions");

  const created = await get(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: p.id, title: "Deploy prüfen", body: "vor dem Release" }),
  });
  assert.equal(created.status, 201);
  const task = (await created.json()) as { id: number; status: string; createdBy: string };
  assert.equal(task.status, "open");
  assert.equal(task.createdBy, "Mensch", "Ohne Namen darf kein persönlicher Standard verwendet werden");

  const before = ((await (await get(`${base}/api/messages`)).json()) as unknown[]).length;
  const assigned = await get(`${base}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignee: "c-example", status: "claimed" }),
  });
  assert.equal(assigned.status, 200);
  const msgs = (await (await get(`${base}/api/messages`)).json()) as { text: string; to: { kind: string; id?: string } }[];
  assert.equal(msgs.length, before + 1, "die Zuweisung erzeugt genau eine Nachricht");
  assert.match(msgs[msgs.length - 1]!.text, new RegExp(`Aufgabe #${task.id} ist dir zugewiesen: Deploy prüfen`));
  assert.equal(msgs[msgs.length - 1]!.to.id, "c-example");

  const bad = await get(`${base}/api/tasks/${task.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "review" }),
  });
  assert.equal(bad.status, 200);
  const worse = await get(`${base}/api/tasks/${task.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "claimed" }),
  });
  assert.equal(worse.status, 200);
  assert.equal((await get(`${base}/api/tasks/9999`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
});

test("MCP: Aufgaben anlegen, übernehmen und fortschreiben", async () => {
  const claude = await mcpClient("claude");
  const cwd = "/p/example-project";
  const created = text(await claude.callTool({ name: "create_task", arguments: { cwd, title: "Tests grün machen", body: "CI ist rot" } }));
  assert.match(created, /Angelegt:\n#\d+ \[offen\] Tests grün machen/);
  const id = Number(created.match(/#(\d+)/)![1]);

  assert.match(text(await claude.callTool({ name: "list_tasks", arguments: { cwd } })), /Tests grün machen/);
  const claimed = text(await claude.callTool({ name: "claim_task", arguments: { cwd, id } }));
  assert.match(claimed, /Übernommen:/);
  assert.match(claimed, /\[in Arbeit\]/);
  assert.match(claimed, /keinen eigenen Worktree/);

  // Eine andere Session bekommt ihn nicht mehr
  const codex = await mcpClient("codex");
  const denied = await codex.callTool({ name: "claim_task", arguments: { cwd, id } });
  assert.equal((denied as { isError?: boolean }).isError, true);
  assert.match(text(denied), /schon vergeben an Claude/);

  const updated = text(await claude.callTool({ name: "update_task", arguments: { cwd, id, status: "review", note: "fertig, bitte prüfen" } }));
  assert.match(updated, /\[zu prüfen\]/);
  assert.match(updated, /fertig, bitte prüfen/);
  await claude.close();
  await codex.close();
});

test("API: Rolle setzen und an sie adressieren", async () => {
  await hook("claude", "session-start", { app: "claude", sessionId: "s-dir", cwd: "/p/example-project", name: "Director" });
  const listed = (await (await get(`${base}/api/sessions`)).json()) as { id: string; role: string | null }[];
  assert.equal(listed.find((s) => s.id === "s-dir")?.role, "director", "der Name vergibt die Rolle");

  const patched = await get(`${base}/api/sessions/c-example`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "pm" }),
  });
  assert.equal(((await patched.json()) as { role: string }).role, "pm");
  assert.equal(
    (await (await get(`${base}/api/sessions/c-example`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "chef" }) })).status),
    400,
  );

  const res = await get(`${base}/api/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "Mensch", to: "director", text: "Bitte priorisieren" }),
  });
  assert.equal(res.status, 201);
  const m = (await res.json()) as { toLabel: string; pending: string[] };
  assert.equal(m.toLabel, "den Director");
  assert.ok(m.pending.some((p) => p.includes("Director")), "die Nachricht wartet beim Director");
});

test("MCP: start_run läuft nur mit Grenzen, und der Anstoßende wird benachrichtigt", async () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-run-")));
  await hook("claude", "session-start", { app: "claude", sessionId: "s-chef", cwd: real, name: "Director" });

  const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stub-")), "s.sh");
  fs.writeFileSync(stub, `#!/bin/sh\necho '{"type":"item.completed","item":{"type":"agent_message","text":"Bericht: alles gruen"}}'\nexit 0`, { mode: 0o755 });
  const originalBin = codexApp.bin;
  const originalAuth = codexApp.loggedIn;
  codexApp.bin = () => stub;
  codexApp.loggedIn = () => true;
  const claude = await mcpClient("claude");
  try {
    // Schreibend ohne Worktree wird abgelehnt.
    const denied = await claude.callTool({ name: "start_run", arguments: { cwd: real, prompt: "bau um", app: "codex", mode: "worktree-write" } });
    assert.equal((denied as { isError?: boolean }).isError, true);
    assert.match(text(denied), /brauchen einen Worktree/);

    const started = text(await claude.callTool({ name: "start_run", arguments: { cwd: real, prompt: "Sieh dir das an", app: "codex" } }));
    assert.match(started, /Gestartet:/);
    assert.match(started, /nur lesen/, "ohne Angabe wird nur gelesen");
    assert.match(started, /angestoßen von: Claude · .* \/ Director/);
    const id = Number(started.match(/#(\d+)/)![1]);

    // Rückmeldung an den Anstoßenden, sobald der Lauf fertig ist.
    for (let i = 0; i < 60; i++) {
      if (daemon.inbox.pendingFor("s-chef").length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const back = daemon.inbox.pendingFor("s-chef");
    assert.equal(back.length, 1, "genau eine Rückmeldung");
    assert.ok(back[0]!.text.startsWith(`Lauf #${id} (codex, read-only) ist done`), back[0]!.text.slice(0, 80));
    assert.ok(back[0]!.text.startsWith(`Lauf #${id} (codex, read-only) ist done`), back[0]!.text.slice(0, 80));

    assert.ok(text(await claude.callTool({ name: "list_runs", arguments: { cwd: real, mine_only: true } })).includes(`#${id} [fertig]`));
    // Einen Lauf, den keine Session angestoßen hat, darf diese Session nicht abbrechen. Der Test
    // legt ihn selbst an, statt sich auf den Lauf aus einem anderen Test zu verlassen.
    const projects = (await (await get(`${base}/api/projects`)).json()) as { id: string; root: string }[];
    const foreignRun = (await (
      await get(`${base}/api/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: projects.find((x) => x.root === real)!.id, prompt: "nicht von mir", app: "codex", mode: "read-only" }),
      })
    ).json()) as { id: number };
    assert.notEqual(foreignRun.id, id, "der fremde Lauf ist ein anderer als der eigene");
    const foreign = await claude.callTool({ name: "stop_run", arguments: { cwd: real, id: foreignRun.id } });
    assert.equal((foreign as { isError?: boolean }).isError, true, "fremde Läufe darf man nicht abbrechen");
  } finally {
    codexApp.bin = originalBin;
    codexApp.loggedIn = originalAuth;
    await claude.close();
  }
});

test("Aufgabe #13: zwei Sessions im selben Verzeichnis werden am Prozess erkannt, nicht am Verzeichnis", async () => {
  const cwd = "/p/zweisam";
  const DIR: Proc = { pid: 900001, comm: "claude" };
  const WRK: Proc = { pid: 900002, comm: "claude" };
  const APP: Proc = { pid: 900000, comm: "Claude" };
  proc.chain = [DIR, { pid: 900011, comm: "disclaimer" }, APP];
  await hook("claude", "session-start", { app: "claude", sessionId: "s-director", cwd, name: "Director" });
  proc.chain = [WRK, { pid: 900012, comm: "disclaimer" }, APP];
  await hook("claude", "session-start", { app: "claude", sessionId: "s-worker", cwd, name: "Worker zweisam" });
  proc.chain = [];

  const claude = await mcpClient("claude");
  const other = (who: Proc) => (who === DIR ? "s-worker" : "s-director");
  const call = async (who: Proc | null, name: string, args: Record<string, unknown>) => {
    proc.caller = who;
    try {
      return await claude.callTool({ name, arguments: { cwd, ...args } });
    } finally {
      proc.caller = null;
    }
  };
  // Vor jedem Aufruf meldet sich die jeweils andere Session per Hook und ist damit die zuletzt
  // aktive: genau die Lage, in der der alte Weg über das Verzeichnis den Falschen wählte.
  const say = async (who: Proc, to: string, t: string) => {
    await hook("claude", "prompt", { app: "claude", sessionId: other(who), cwd });
    return text(await call(who, "post_message", { to, text: t }));
  };

  assert.match(await say(DIR, "session:s-worker", "#13-eins"), /von Claude · zweisam \/ Director an/);
  assert.match(await say(WRK, "director", "#13-zwei"), /von Claude · zweisam \/ Worker zweisam an/);
  assert.match(await say(DIR, "session:s-worker", "#13-drei"), /von Claude · zweisam \/ Director an/);
  assert.match(await say(WRK, "director", "#13-vier"), /von Claude · zweisam \/ Worker zweisam an/);

  const msgs = (await (await get(`${base}/api/messages`)).json()) as { text: string; from: { id?: string }; replyTo: string }[];
  const by = (t: string) => msgs.find((m) => m.text === t)!;
  for (const [t, id] of [["#13-eins", "s-director"], ["#13-zwei", "s-worker"], ["#13-drei", "s-director"], ["#13-vier", "s-worker"]]) {
    assert.equal(by(t!).from.id, id, `Absender von "${t}"`);
    assert.equal(by(t!).replyTo, `session:${id}`, `Antwortadresse von "${t}"`);
  }

  // Jede Seite liest nur ihre eigene Post, auch wenn die andere zuletzt aktiv war.
  // ("#13-eins" hat der Worker schon über seinen Hook vor "#13-drei" bekommen.)
  await hook("claude", "prompt", { app: "claude", sessionId: "s-director", cwd });
  const workerPost = text(await call(WRK, "read_inbox", {}));
  assert.match(workerPost, /#13-drei/);
  assert.match(workerPost, /antworten an: session:s-director/);
  assert.doesNotMatch(workerPost, /#13-(zwei|vier)/);

  // Aufgaben tragen ebenfalls den richtigen Namen.
  await hook("claude", "prompt", { app: "claude", sessionId: "s-worker", cwd });
  assert.match(text(await call(DIR, "create_task", { title: "vom Director" })), /angelegt von Claude · zweisam \/ Director/);
  await hook("claude", "prompt", { app: "claude", sessionId: "s-director", cwd });
  assert.match(text(await call(WRK, "create_task", { title: "vom Worker" })), /angelegt von Claude · zweisam \/ Worker zweisam/);

  // Beide stammen aus derselben App: ruft die App selbst an, ist das nicht eindeutig. Dann wird
  // abgelehnt statt geraten, auch ohne erkannten Prozess.
  for (const who of [APP, null]) {
    const r = (await call(who, "post_message", { to: "all", text: "wer bin ich?" })) as { isError?: boolean };
    assert.equal(r.isError, true, `abgelehnt bei ${who ? "gemeinsamem Vorfahren" : "unbekanntem Prozess"}`);
    assert.match(text(r), /nicht sicher erkennen/);
  }
  assert.ok(!msgs.some((m) => m.text === "wer bin ich?"));
  assert.doesNotMatch(text(await call(null, "list_sessions", {})), /^\s+\* /m, "keine Session als eigene markiert");

  // Eine wiederverwendete Prozessnummer mit anderem Programm zählt nicht.
  const reused = (await call({ pid: DIR.pid, comm: "zsh" }, "post_message", { to: "all", text: "fremd" })) as { isError?: boolean };
  assert.equal(reused.isError, true);
});

test("Aufgabe #13: Claude-Sessions aus der Registry werden an ihrer pid erkannt", async () => {
  const cwd = "/p/registriert";
  await hook("claude", "session-start", { app: "claude", sessionId: "r-a", cwd, name: "A" });
  await hook("claude", "session-start", { app: "claude", sessionId: "r-b", cwd, name: "B" });
  daemon.inbox.registrySync().upsert({ pid: 910001, sessionId: "r-a", cwd, name: "A", nameSource: "user", startedAt: null });
  daemon.inbox.registrySync().upsert({ pid: 910002, sessionId: "r-b", cwd, name: "B", nameSource: "user", startedAt: null });
  const claude = await mcpClient("claude");
  proc.caller = { pid: 910001, comm: "claude" };
  try {
    assert.match(text(await claude.callTool({ name: "post_message", arguments: { cwd, to: "session:r-b", text: "von A" } })), /von Claude · registriert \/ A an/);
  } finally {
    proc.caller = null;
  }
});

test("Aufgabe #46: Codex-Threads teilen einen Prozess — der Sitzungsschlüssel aus dem Hook unterscheidet sie", async () => {
  const cwd = "/p/gemeinsam";
  // Alle Codex-Threads der ChatGPT-App laufen über denselben Prozess (gemessen: codex 6665).
  const SHARED: Proc = { pid: 950001, comm: "codex" };
  proc.chain = [SHARED, { pid: 950000, comm: "ChatGPT" }];
  const a = await hook("codex", "session-start", { app: "codex", sessionId: "cx-a", cwd });
  // Solange der Thread allein im Verzeichnis ist, gibt es nichts zu unterscheiden: kein
  // Schlüssel, kein zusätzlicher Text im Kontext.
  assert.equal(a.json.sessionKey, undefined, "allein im Verzeichnis: kein Schlüssel");
  const b = await hook("codex", "session-start", { app: "codex", sessionId: "cx-b", cwd });
  proc.chain = [];

  // Sobald der zweite Thread da ist, bekommt jeder seinen eigenen Schlüssel — der zweite
  // sofort beim Start, der erste beim nächsten Turn.
  const keyB = b.json.sessionKey!;
  const keyA = (await hook("codex", "prompt", { app: "codex", sessionId: "cx-a", cwd })).json.sessionKey!;
  assert.ok(keyA && keyB, "Hook liefert einen Sitzungsschlüssel");
  assert.notEqual(keyA, keyB);
  assert.ok(keyA.length >= 22, "Schlüssel ist nicht zu erraten");
  // Derselbe Thread bekommt bei jedem Turn denselben Schlüssel, sonst wäre er nach einer
  // Zusammenfassung des Chats verloren.
  assert.equal((await hook("codex", "prompt", { app: "codex", sessionId: "cx-a", cwd })).json.sessionKey, keyA);

  const codex = await mcpClient("codex");
  const call = async (args: Record<string, unknown>) => {
    proc.caller = SHARED;
    try {
      return await codex.callTool({ name: "post_message", arguments: { cwd, to: "all", ...args } });
    } finally {
      proc.caller = null;
    }
  };

  // Ohne Schlüssel bleibt die Sperre aus #13 bestehen: der Prozess ist für beide gleich.
  const ohne = (await call({ text: "#46-ohne" })) as { isError?: boolean };
  assert.equal(ohne.isError, true, "ohne Schlüssel abgelehnt");
  assert.match(text(ohne), /nicht sicher erkennen/);

  // Mit Schlüssel ist die Zuordnung eindeutig — und zwar für beide Threads getrennt.
  assert.match(text(await call({ text: "#46-a", session_key: keyA })), /von Codex · gemeinsam \/ .* an/);
  assert.match(text(await call({ text: "#46-b", session_key: keyB })), /von Codex · gemeinsam \/ .* an/);
  const msgs = (await (await get(`${base}/api/messages`)).json()) as { text: string; from: { id?: string }; replyTo: string }[];
  const by = (t: string) => msgs.find((m) => m.text === t)!;
  assert.equal(by("#46-a").from.id, "cx-a");
  assert.equal(by("#46-a").replyTo, "session:cx-a");
  assert.equal(by("#46-b").from.id, "cx-b");
  assert.ok(!msgs.some((m) => m.text === "#46-ohne"), "die abgelehnte Nachricht wurde nicht abgelegt");

  // Ein erfundener Schlüssel führt nicht auf das Verzeichnis zurück, sondern wird abgelehnt.
  // Geprüft wird der Satz, den nur die Schlüsselablehnung trägt: Das Wort „Sitzungsschlüssel“
  // allein steht auch in der Meldung zur Mehrdeutigkeit und würde beide Wege verwechseln.
  const erfunden = (await call({ text: "#46-erfunden", session_key: "x".repeat(32) })) as { isError?: boolean };
  assert.equal(erfunden.isError, true);
  assert.match(text(erfunden), /gehört zu keiner laufenden Session/);

  // Ein Schlüssel aus einer anderen App gilt hier nicht. Einen Schlüssel gibt der Hook aber erst
  // heraus, wenn auch bei Claude zwei Chats denselben Prozess und dasselbe Verzeichnis teilen —
  // mit nur einer Claude-Session bliebe das Feld leer, der Aufruf käme ohne Schlüssel an, und die
  // Ablehnung käme bloß von der Sperre aus #13. Dann wäre dieser Test auch grün, wenn die
  // App-Grenze in der Schlüsselabfrage fehlte.
  const CLAUDE_SHARED: Proc = { pid: 950002, comm: "claude" };
  proc.chain = [CLAUDE_SHARED, { pid: 950000, comm: "Claude" }];
  await hook("claude", "session-start", { app: "claude", sessionId: "cl-eins", cwd, name: "Fremd eins" });
  const fremd = await hook("claude", "session-start", { app: "claude", sessionId: "cl-zwei", cwd, name: "Fremd zwei" });
  proc.chain = [];
  const fremdKey = fremd.json.sessionKey;
  assert.ok(fremdKey && fremdKey.length >= 22, "die Claude-Session hat einen eigenen, echten Schlüssel");
  const quer = (await call({ text: "#46-quer", session_key: fremdKey })) as { isError?: boolean };
  assert.equal(quer.isError, true, "Schlüssel einer Claude-Session gilt nicht für Codex");
  assert.match(text(quer), /gehört zu keiner laufenden Session/, "abgelehnt an der App-Grenze, nicht an der Mehrdeutigkeit");

  // Nach dem Ende des Threads trägt sein Schlüssel nicht mehr.
  await hook("codex", "session-end", { app: "codex", sessionId: "cx-b", cwd });
  const beendet = (await call({ text: "#46-beendet", session_key: keyB })) as { isError?: boolean };
  assert.equal(beendet.isError, true, "Schlüssel einer beendeten Session gilt nicht");
});

test("Aufgabe #46: der Schlüssel reist bei stop mit zugestellter Post mit, nie allein", async () => {
  const cwd = "/p/stopweg";
  const SHARED: Proc = { pid: 960001, comm: "codex" };
  proc.chain = [SHARED, { pid: 960000, comm: "ChatGPT" }];
  await hook("codex", "session-start", { app: "codex", sessionId: "sx-a", cwd });
  await hook("codex", "session-start", { app: "codex", sessionId: "sx-b", cwd });
  proc.chain = [];

  // Ohne Post bleibt der Stop unangetastet: kein Schlüssel, keine Blockade.
  const leer = await hook("codex", "stop", { app: "codex", sessionId: "sx-a", cwd });
  assert.equal(leer.json.sessionKey, undefined, "leerer Stop trägt keinen Schlüssel");
  assert.equal(leer.json.mayContinue, true);

  // Mit Post reist der Schlüssel mit — der einzige Weg für Chats, deren Prompt-Hook nicht
  // feuert (bei Codex gemessen: nur stop kommt an).
  await postHuman("session:sx-a", "Post für den Stop-Weg");
  const voll = await hook("codex", "stop", { app: "codex", sessionId: "sx-a", cwd });
  assert.equal(voll.json.messages.length, 1);
  assert.ok(voll.json.sessionKey, "Stop mit Post trägt den Schlüssel");

  // Und er ist derselbe, den auch der Prompt-Weg nennt.
  assert.equal((await hook("codex", "prompt", { app: "codex", sessionId: "sx-a", cwd })).json.sessionKey, voll.json.sessionKey);
});
