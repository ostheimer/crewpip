import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { Board } from "../src/board.js";
import { Runner } from "../src/runner/index.js";
import { createDaemon } from "../src/http.js";

/**
 * Akzeptanztest zu Issue #15: Die Übersicht zeigt, welche Chats tatsächlich Nachrichten
 * ausgetauscht haben. Grundlage sind Zustellungen, nicht Adressen: Eine Nachricht an
 * `pm:<projekt>` oder `director` zählt für den Chat, der sie abgeholt hat.
 */
function setup() {
  const db = openDb(":memory:");
  const inbox = new Inbox(db, new Board(db));
  inbox.upsertSession({ id: "w1", app: "codex", cwd: "/p/shop", name: "worker" });
  inbox.upsertSession({ id: "pm1", app: "claude", cwd: "/p/shop", name: "PM shop", role: "pm" });
  inbox.upsertSession({ id: "dir", app: "claude", cwd: "/p/zentrale", name: "Director", role: "director" });
  return { db, inbox };
}

test("Nachrichtenwege: Rollenadressen zählen für den abholenden Chat, gezählt und mit letztem Zeitpunkt", () => {
  const { inbox } = setup();
  inbox.post({ sessionId: "w1" }, "pm:shop", "Befund 1");
  inbox.post({ sessionId: "w1" }, "pm:shop", "Befund 2");
  inbox.post({ sessionId: "pm1" }, "director", "Stand");
  inbox.post({ human: "Andreas" }, "session:w1", "Bitte prüfen");
  inbox.take("pm1", "hook-prompt");
  inbox.take("dir", "mcp-read");
  inbox.take("w1", "hook-stop");

  const flows = inbox.flows(new Date(Date.now() - 86400000).toISOString());
  const edge = (from: string, to: string) => flows.find((f) => (f.from.kind === "session" ? f.from.id : `human:${f.from.name}`) === from && f.to.id === to);

  const w1pm = edge("w1", "pm1");
  assert.ok(w1pm, "pm:shop wird dem PM-Chat zugeordnet, der abgeholt hat");
  assert.equal(w1pm.count, 2);
  assert.equal(w1pm.from.kind === "session" && w1pm.from.app, "codex");
  assert.equal(w1pm.to.app, "claude");
  assert.equal(w1pm.to.projectId, inbox.sessions().find((s) => s.id === "pm1")!.projectId);
  assert.ok(Date.parse(w1pm.lastAt) > 0);

  assert.equal(edge("pm1", "dir")?.count, 1, "director wird dem Director-Chat zugeordnet");
  assert.equal(edge("human:Andreas", "w1")?.count, 1, "Nachrichten vom Board erscheinen mit Absender Mensch");
  assert.equal(flows.length, 3);
  assert.ok(!JSON.stringify(flows).includes("Befund"), "keine Nachrichteninhalte");
});

test("Nachrichtenwege: nur Zustellungen im Zeitfenster, nicht abgeholte Post zählt nicht", () => {
  const { db, inbox } = setup();
  const alt = inbox.post({ sessionId: "w1" }, "pm:shop", "alt");
  inbox.take("pm1", "hook-prompt");
  db.prepare("UPDATE deliveries SET at = ? WHERE message_id = ?").run(new Date(Date.now() - 2 * 86400000).toISOString(), alt.id);
  inbox.post({ sessionId: "w1" }, "director", "liegt noch");

  assert.deepEqual(inbox.flows(new Date(Date.now() - 86400000).toISOString()), []);
  assert.equal(inbox.flows(new Date(Date.now() - 3 * 86400000).toISOString()).length, 1);
});

test("GET /api/flows liefert die Wege der letzten 24 Stunden", async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  const inbox = new Inbox(db, board);
  inbox.upsertSession({ id: "a", app: "codex", cwd: "/p/x", name: "a" });
  inbox.upsertSession({ id: "b", app: "claude", cwd: "/p/x", name: "b" });
  inbox.post({ sessionId: "a" }, "session:b", "hallo");
  inbox.take("b", "hook-prompt");
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-flows-")), log: () => {} });
  const daemon = createDaemon(inbox, board, runner, { token: "t", log: () => {} });
  await new Promise<void>((r) => daemon.server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}/api/flows`, { headers: { "x-crewpip-token": "t" } });
    assert.equal(res.status, 200);
    const flows = await res.json();
    assert.equal(flows.length, 1);
    assert.equal(flows[0].from.id, "a");
    assert.equal(flows[0].to.id, "b");
  } finally {
    await daemon.close();
  }
});
