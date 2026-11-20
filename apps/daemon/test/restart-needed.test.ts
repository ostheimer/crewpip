import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { Inbox, connectionOf } from "../src/inbox.js";
import { Board } from "../src/board.js";

/**
 * Befund aus #21: Claude Code liest die Hook-Liste beim Start des Prozesses. Chats, die schon
 * liefen, als die CrewPip-Hooks in ~/.claude/settings.json kamen (19.11.2026), haben sie teils
 * nie übernommen (Director, PM CMM, PM firmenwebseiten.at: Stop-Hook-Zusammenfassungen im
 * Transkript mit 5 statt 6 Hooks bis Prozessende). Solche Chats haben Turns, aber CrewPip hört
 * nie einen Hook aus ihrem Prozess. Das Dashboard muss das als „Neustart nötig“ zeigen statt als
 * offenes „Ohne Hook“, und ein Hook aus einem früheren Prozess derselben Session darf nicht als
 * Verbindung gelten.
 */

const ALIVE = process.pid;
/** macOS vergibt höchstens 99998, Linux standardmäßig höchstens 4194304. */
const DEAD = 2147483646;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600_000;
/** Prozessstart vor einem Tag, letzter Turn vor einer Stunde beendet. */
const START = ago(24 * HOUR);
const AFTER_TURN = ago(HOUR);

function fresh(): Inbox {
  const db = openDb(":memory:");
  return new Inbox(db, new Board(db));
}

const byId = (inbox: Inbox, id: string) => inbox.sessions({ includeEnded: true }).find((s) => s.id === id)!;

function registry(inbox: Inbox, e: { status?: string | null; statusAt?: string | null; pid?: number } = {}) {
  inbox.registrySync().upsert({
    sessionId: "c1",
    cwd: "/p/a",
    name: "Director",
    nameSource: "user",
    pid: e.pid ?? ALIVE,
    startedAt: START,
    status: e.status === undefined ? "idle" : e.status,
    statusAt: e.statusAt === undefined ? AFTER_TURN : e.statusAt,
  });
}

test("#21: Chat hatte nach dem Prozessstart einen Turn, aber kein Hook aus diesem Prozess: Neustart nötig", () => {
  const inbox = fresh();
  registry(inbox);
  assert.equal(byId(inbox, "c1").connection, "restart-needed");
});

test("#21: Hook aus einem früheren Prozess derselben Session zählt nicht als Verbindung", () => {
  // Die Desktop-App setzt eine Session nach einem Neustart mit derselben ID in einem neuen
  // Prozess fort. Die gespeicherte Kette stammt vom alten Prozess.
  const inbox = fresh();
  registry(inbox);
  inbox.setProcChain("c1", [{ pid: DEAD, comm: "claude" }, { pid: 1, comm: "Claude" }]);
  assert.notEqual(byId(inbox, "c1").connection, "connected");
  assert.equal(byId(inbox, "c1").connection, "restart-needed");
  assert.equal(inbox.procChainAlive("c1"), false, "der nächste Hook muss die Kette neu ermitteln");
});

test("#21: Hook aus dem laufenden Prozess: verbunden, auch nach vielen Turns", () => {
  const inbox = fresh();
  registry(inbox);
  inbox.setProcChain("c1", [{ pid: ALIVE, comm: "claude" }, { pid: 1, comm: "Claude" }]);
  assert.equal(byId(inbox, "c1").connection, "connected");
  assert.equal(inbox.procChainAlive("c1"), true);
});

test("#21: ohne abgeschlossenen Turn seit dem Start bleibt es bei „Ohne Hook“", () => {
  const inbox = fresh();
  // Status unverändert seit dem Start
  registry(inbox, { statusAt: START });
  assert.equal(byId(inbox, "c1").connection, "no-hook");
  // Turn läuft noch
  registry(inbox, { status: "busy" });
  assert.equal(byId(inbox, "c1").connection, "no-hook");
  // Turn gerade erst beendet: der Stop-Hook darf noch unterwegs sein
  registry(inbox, { statusAt: ago(2000) });
  assert.equal(byId(inbox, "c1").connection, "no-hook");
  // Registry ohne Status (ältere Claude-Version)
  registry(inbox, { status: null, statusAt: null });
  assert.equal(byId(inbox, "c1").connection, "no-hook");
});

test("#21: connectionOf ohne Registry-Angaben verhält sich wie bisher", () => {
  const row = { id: "x1", pid: null, proc_chain: JSON.stringify([{ pid: ALIVE, comm: "codex" }]), ended_at: null };
  assert.equal(connectionOf(row), "connected");
  assert.equal(connectionOf({ ...row, proc_chain: null }), "no-hook");
});

test("#21: readClaudeRegistry liest Status und Zeitpunkt der letzten Statusänderung", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { readClaudeRegistry } = await import("../src/registry/claude.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-reg-"));
  // Aufbau wie ~/.claude/sessions/<pid>.json von Claude Code 2.1.326 (gemessen 20.11.2026)
  fs.writeFileSync(path.join(dir, `${ALIVE}.json`), JSON.stringify({
    pid: ALIVE, sessionId: "c1", cwd: "/p/a", startedAt: 1795168733310, procStart: "Fri Nov 20 09:58:52 2026",
    status: "idle", statusUpdatedAt: 1795169958563, updatedAt: 1795169958563,
  }));
  const [e] = readClaudeRegistry(dir);
  assert.equal(e!.status, "idle");
  assert.equal(e!.statusAt, new Date(1795169958563).toISOString());
});
