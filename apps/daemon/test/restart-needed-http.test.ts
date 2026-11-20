import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { Board } from "../src/board.js";
import { Runner } from "../src/runner/index.js";
import { createDaemon, type DaemonHandle } from "../src/http.js";
import type { Proc, ProcessProbe } from "../src/peer.js";

/** #21 über den echten Hook-Weg: Fortsetzung in neuem Prozess und Hook ohne ermittelbare Kette. */

const TOKEN = "test-token";
const ALIVE = process.pid;
const DEAD = 2147483646;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let daemon: DaemonHandle;
let inbox: Inbox;
let base = "";
const proc = { chain: [] as Proc[] };
const probe: ProcessProbe = { owner: async () => null, agentChain: async () => proc.chain };

before(async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  inbox = new Inbox(db, board);
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-runs-")), timeoutMs: 5000, log: () => {} });
  daemon = createDaemon(inbox, board, runner, { log: () => {}, token: TOKEN, probe });
  await new Promise<void>((r) => daemon.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(daemon.server.address() as net.AddressInfo).port}`;
});
after(async () => {
  await daemon.close();
});

async function hook(event: string, sessionId: string) {
  const res = await fetch(`${base}/hooks/claude/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-crewpip-token": TOKEN },
    body: JSON.stringify({ app: "claude", sessionId, cwd: "/p/a" }),
  });
  assert.equal(res.status, 200);
}
const connection = (id: string) => inbox.sessions().find((s) => s.id === id)!.connection;
const registry = (id: string) =>
  inbox.registrySync().upsert({ sessionId: id, cwd: "/p/a", name: null, nameSource: null, pid: ALIVE, startedAt: ago(3600_000), status: "idle", statusAt: ago(600_000) });

test("Fortsetzung in neuem Prozess: der nächste Hook ermittelt die Kette neu und verbindet", async () => {
  registry("r1");
  inbox.setProcChain("r1", [{ pid: DEAD, comm: "claude" }]);
  assert.equal(connection("r1"), "restart-needed");
  proc.chain = [{ pid: ALIVE, comm: "claude" }, { pid: 1, comm: "Claude" }];
  await hook("prompt", "r1");
  assert.equal(connection("r1"), "connected");
});

test("Hook kam an, aber die Prozesskette ließ sich nicht ermitteln: nicht „Neustart nötig“", async () => {
  registry("r2");
  proc.chain = [];
  await hook("stop", "r2");
  assert.notEqual(connection("r2"), "restart-needed", "ein angekommener Hook beweist, dass der Prozess die Hooks geladen hat");
});
