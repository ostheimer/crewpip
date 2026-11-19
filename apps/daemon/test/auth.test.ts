import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net, { type AddressInfo } from "node:net";
import { openDb } from "../src/db.js";
import { Board } from "../src/board.js";
import { Inbox } from "../src/inbox.js";
import { Runner } from "../src/runner/index.js";
import { createDaemon, type DaemonHandle } from "../src/http.js";
import { hostAllowed, loadOrCreateToken, tokenFromRequest } from "../src/auth.js";

const TOKEN = "geheim-fuer-den-test";
let daemon: DaemonHandle;
let base = "";

before(async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "l-")), log: () => {} });
  daemon = createDaemon(new Inbox(db, board), board, runner, { token: TOKEN, log: () => {} });
  await new Promise<void>((r) => daemon.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`;
});
after(async () => {
  await daemon.close();
});

test("Ohne Token kommt niemand an Daten oder Aktionen", async () => {
  for (const url of ["/api/health", "/api/sessions", "/api/tasks", "/api/runs"]) {
    assert.equal((await fetch(base + url)).status, 401, url);
  }
  assert.equal((await fetch(`${base}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/hooks/claude/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/mcp/claude`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
});

test("Ein falsches Token wird abgewiesen, ein richtiges durchgelassen", async () => {
  assert.equal((await fetch(`${base}/api/health`, { headers: { "x-crewpip-token": "falsch" } })).status, 401);
  assert.equal((await fetch(`${base}/api/health`, { headers: { "x-crewpip-token": TOKEN } })).status, 200);
  assert.equal((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  // Ein Token gleicher Länge darf nicht durchrutschen.
  assert.equal((await fetch(`${base}/api/health`, { headers: { "x-crewpip-token": "x".repeat(TOKEN.length) } })).status, 401);
});

test("Fremde Herkunft und fremder Host werden abgelehnt, auch mit gültigem Token", async () => {
  const withOrigin = await fetch(`${base}/api/health`, { headers: { "x-crewpip-token": TOKEN, origin: "https://boese.example" } });
  assert.equal(withOrigin.status, 403, "eine Webseite darf den Daemon nicht ansprechen");

  // Host-Kopf von Hand setzen: so sähe DNS-Rebinding aus.
  const sock = await new Promise<string>((resolve) => {
    const port = (daemon.server.address() as AddressInfo).port;
    const c = net.createConnection(port, "127.0.0.1", () => {
      c.write(`GET /api/health HTTP/1.1\r\nHost: boese.example\r\nx-crewpip-token: ${TOKEN}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    c.on("data", (d) => (buf += d.toString()));
    c.on("end", () => resolve(buf));
  });
  assert.match(sock.split("\r\n")[0]!, /421/, "ein fremder Host wird abgewiesen");
});

test("Die Oberfläche bleibt erreichbar, die Startseite trägt das Token", async () => {
  // Ohne ausgelieferte Web-Dateien gibt es keine Startseite; geprüft wird die Einsetzung selbst.
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "web-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<html><head><title>x</title></head><body></body></html>");
  const db = openDb(":memory:");
  const board = new Board(db);
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "l-")), log: () => {} });
  const d2 = createDaemon(new Inbox(db, board), board, runner, { token: TOKEN, webDist: dist, log: () => {} });
  await new Promise<void>((r) => d2.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(d2.server.address() as AddressInfo).port}/`;
  const html = await (await fetch(url)).text();
  assert.match(html, new RegExp(`window.__CREWPIP_TOKEN__="${TOKEN}"`), "das Token steht in der Startseite");
  const foreign = await fetch(url, { headers: { origin: "https://boese.example" } });
  assert.equal(foreign.status, 403, "eine fremde Seite bekommt die Startseite gar nicht");
  assert.ok(!(await foreign.text()).includes(TOKEN), "und damit auch nicht das Token");
  await d2.close();
});

test("WebSocket verlangt das Token", async () => {
  const { WebSocket } = await import("ws");
  const wsBase = base.replace("http", "ws");
  const status = (u: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(u);
      ws.on("open", () => { ws.close(); resolve("offen"); });
      ws.on("error", (e: Error) => resolve(e.message));
    });
  assert.match(await status(`${wsBase}/ws`), /401/);
  assert.equal(await status(`${wsBase}/ws?token=${TOKEN}`), "offen");
});

test("Hilfsfunktionen: Hosts, Kopfzeilen, Tokendatei", () => {
  assert.equal(hostAllowed("127.0.0.1:7357", []), true);
  assert.equal(hostAllowed("localhost:7357", []), true);
  assert.equal(hostAllowed("[::1]:7357", []), true);
  assert.equal(hostAllowed("boese.example", []), false);
  assert.equal(hostAllowed("mac.tail1234.ts.net:7357", ["mac.tail1234.ts.net:7357"]), true, "zusätzlich erlaubte Hosts");
  assert.equal(hostAllowed(undefined, []), false);
  assert.equal(tokenFromRequest({ get: (h: string) => (h === "authorization" ? "Bearer abc" : undefined) } as never), "abc");
  assert.equal(tokenFromRequest({ get: () => undefined } as never), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tok-"));
  process.env.CREWPIP_TOKEN_FILE = path.join(dir, "token");
  delete process.env.CREWPIP_TOKEN;
  try {
    const t = loadOrCreateToken();
    assert.ok(t.length >= 32, "das Token ist lang genug");
    assert.equal(loadOrCreateToken(), t, "ein zweiter Aufruf liefert dasselbe");
    assert.equal(fs.statSync(process.env.CREWPIP_TOKEN_FILE).mode & 0o777, 0o600, "nur der Eigentümer darf lesen");
  } finally {
    delete process.env.CREWPIP_TOKEN_FILE;
  }
});
