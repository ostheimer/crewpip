import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { Board } from "../src/board.js";

/**
 * Regel aus docs/verbindung.md: Ein Chat gilt als verbunden, wenn er nicht beendet ist,
 * sein Hook sich mindestens einmal gemeldet hat und sein Agent-Prozess noch lebt.
 * Ruhe (idle, alter letzter Kontakt) trennt ihn nicht.
 */

const ALIVE = process.pid;
/** macOS vergibt höchstens 99998, Linux standardmäßig höchstens 4194304. */
const DEAD = 2147483646;

function fresh(): Inbox {
  const db = openDb(":memory:");
  return new Inbox(db, new Board(db));
}

const byId = (inbox: Inbox, id: string) => inbox.sessions({ includeEnded: true }).find((s) => s.id === id)!;

test("Claude-Chat aus der Registry ohne Hook-Kontakt ist eingetragen, aber nicht verbunden", () => {
  const inbox = fresh();
  inbox.registrySync().upsert({ sessionId: "c1", cwd: "/p/a", name: "Director", nameSource: "user", pid: ALIVE, startedAt: "2026-11-18T14:15:42.479Z" });
  assert.equal(byId(inbox, "c1").connection, "no-hook");
});

test("Claude-Chat mit Hook und lebendem Prozess ist verbunden, auch wenn er lange ruht", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a", pid: ALIVE, status: "idle" });
  inbox.setProcChain("c1", [{ pid: ALIVE, comm: "claude" }]);
  const s = byId(inbox, "c1");
  assert.equal(s.status, "idle");
  assert.equal(s.connection, "connected");
});

test("Prozess beendet, Eintrag noch offen: veraltet", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a", pid: DEAD });
  inbox.setProcChain("c1", [{ pid: DEAD, comm: "claude" }]);
  assert.equal(byId(inbox, "c1").connection, "stale");
});

test("Codex-Thread hängt am gemeinsamen Codex-Prozess: verbunden, solange der lebt", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "x1", app: "codex", cwd: "/p/a" });
  inbox.setProcChain("x1", [{ pid: ALIVE, comm: "codex" }, { pid: 1, comm: "ChatGPT" }]);
  inbox.upsertSession({ id: "x2", app: "codex", cwd: "/p/b" });
  inbox.setProcChain("x2", [{ pid: DEAD, comm: "codex" }]);
  assert.equal(byId(inbox, "x1").connection, "connected");
  assert.equal(byId(inbox, "x2").connection, "stale");
});

test("Beendete Chats und MCP-Platzhalter ohne Hook", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a", pid: ALIVE });
  inbox.setProcChain("c1", [{ pid: ALIVE, comm: "claude" }]);
  inbox.endSession("c1");
  assert.equal(byId(inbox, "c1").connection, "ended");
  const placeholder = inbox.resolveByCwd("codex", "/p/b");
  assert.equal(byId(inbox, placeholder.id).connection, "no-hook");
});

test("Das Archivsignal der Antigravity-App überstimmt den gemeinsamen lebenden Prozess, bis das Gespräch entarchiviert wird", () => {
  const db = openDb(":memory:");
  const archived = new Map<string, "archived" | "open">([["app-archiv", "archived"], ["app-offen", "open"], ["ide", "archived"], ["codex", "archived"]]);
  const inbox = new Inbox(db, new Board(db), archived);
  try {
    for (const id of ["app-archiv", "app-offen", "ide", "codex"]) {
      inbox.upsertSession({ id, app: id === "codex" ? "codex" : "antigravity", cwd: "/p/ag" });
      inbox.setProcChain(id, [{ pid: ALIVE, comm: "language_server" }, { pid: ALIVE, comm: id === "ide" ? "Antigravity IDE" : "Antigravity" }]);
    }
    assert.equal(byId(inbox, "app-archiv").connection, "archived");
    for (const id of ["app-offen", "ide", "codex"]) assert.equal(byId(inbox, id).connection, "connected");
    archived.delete("app-archiv");
    assert.equal(byId(inbox, "app-archiv").connection, "unconfirmed");
    archived.set("app-archiv", "open");
    assert.equal(byId(inbox, "app-archiv").connection, "connected");
    archived.set("app-archiv", "archived");
    inbox.endSession("app-archiv");
    assert.equal(byId(inbox, "app-archiv").connection, "ended");
  } finally { db.close(); }
});
