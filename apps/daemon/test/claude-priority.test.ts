import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { Board } from "../src/board.js";

// Akzeptanztests Issue #48: Bei PM und Director bekommt automatisch der Claude-Chat die Rolle.

const AUTO = "automatisch: Claude-Vorrang";

function setup() {
  const db = openDb(":memory:");
  const titles = new Map<string, string>();
  const board = new Board(db, { titles, projects: new Map() });
  return { db, board, titles, inbox: new Inbox(db, board) };
}
const role = (inbox: Inbox, id: string) => inbox.sessions().find((s) => s.id === id)?.role ?? null;
const conflict = (inbox: Inbox, id: string) => inbox.sessions().find((s) => s.id === id)?.roleConflict ?? null;

test("#48 Regression: Codex hält PM, ein Claude-Chat mit „PM <projekt>“ kommt dazu und bekommt die Rolle", () => {
  const { db, board } = setup();
  const first = new Inbox(db, board);
  first.upsertSession({ id: "cx", app: "codex", cwd: "/p/claribill", name: "PM claribill" });
  assert.equal(role(first, "cx"), "pm");
  // Neustart des Dienstes: der Claude-Chat meldet sich über die Registry an.
  const inbox = new Inbox(db, board);
  inbox.registrySync().upsert({ pid: process.pid, sessionId: "cl", cwd: "/p/claribill", name: "PM claribill", nameSource: "user", startedAt: null });
  inbox.syncNameRoles();
  assert.equal(role(inbox, "cl"), "pm");
  assert.equal(role(inbox, "cx"), null);
  assert.equal(conflict(inbox, "cl"), null);
  // Der Codex-Chat beansprucht weiter per Namen; der Claude-Vorrang hat entschieden, also
  // zeigen Dashboard und list_sessions keinen Konflikt mehr.
  assert.equal(conflict(inbox, "cx"), null);
  const change = inbox.roleChanges().find((c) => c.toSession === "cl" && c.role === "pm");
  assert.equal(change?.fromSession, "cx");
  assert.equal(change?.actor, AUTO);
  // Ein weiterer Abgleich ändert nichts mehr.
  const n = inbox.roleChanges().length;
  inbox.syncNameRoles();
  assert.equal(inbox.roleChanges().length, n);
});

test("#48 Auch eine per set_role vergebene Rolle eines Nicht-Claude-Chats geht an den Claude-Anwärter", () => {
  const { inbox, titles } = setup();
  inbox.upsertSession({ id: "ag", app: "antigravity", cwd: "/p/cmm" });
  inbox.setRole("ag", "pm", "session:pm-crewpip");
  inbox.upsertSession({ id: "cl", app: "claude", cwd: "/p/cmm/.claude/worktrees/pm" });
  titles.set("claude:cl", "PM CMM (Mac Studio)");
  inbox.syncNameRoles();
  assert.equal(role(inbox, "cl"), "pm");
  assert.equal(role(inbox, "ag"), null);
});

test("#48 Director: der Claude-Chat setzt sich gegen Codex durch, ein freier Doppelanspruch wird aufgelöst", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "dx", app: "codex", cwd: "/p/zentrale", name: "Director" });
  assert.equal(role(inbox, "dx"), "director");
  inbox.upsertSession({ id: "dc", app: "claude", cwd: "/p/leitung", name: "Director" });
  assert.equal(role(inbox, "dc"), "director");
  assert.equal(role(inbox, "dx"), null);
  assert.equal(inbox.roleChanges().find((c) => c.toSession === "dc")?.actor, AUTO);
});

test("#48 Beanspruchen Claude und Codex gleichzeitig eine freie Rolle, bekommt sie der Claude-Chat", () => {
  const { inbox, titles } = setup();
  inbox.upsertSession({ id: "cl", app: "claude", cwd: "/p/chatreact" });
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/chatreact" });
  titles.set("claude:cl", "PM chatreact");
  titles.set("codex:cx", "PM chatreact");
  inbox.syncNameRoles();
  assert.equal(role(inbox, "cl"), "pm");
  assert.equal(role(inbox, "cx"), null);
  assert.equal(conflict(inbox, "cx"), null);
});

test("#48 Zwei Claude-Anwärter: CrewPip ändert nichts, der Konflikt bleibt sichtbar", () => {
  const { inbox, titles } = setup();
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/firma", name: "PM firma" });
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/firma" });
  inbox.upsertSession({ id: "c2", app: "claude", cwd: "/p/firma" });
  titles.set("claude:c1", "PM firma");
  titles.set("claude:c2", "PM firma");
  inbox.syncNameRoles();
  assert.equal(role(inbox, "cx"), "pm");
  assert.equal(role(inbox, "c1"), null);
  assert.equal(role(inbox, "c2"), null);
  assert.equal(conflict(inbox, "c1")?.holderId, "cx");
  assert.ok(!inbox.roleChanges().some((c) => c.actor === AUTO));
  // Hält einer der beiden Claude-Chats die Rolle, bleibt sie dort, auch ohne Namensanspruch.
  inbox.setRole("c1", "pm", "Test");
  inbox.renameSession("c1", "Planung");
  inbox.syncNameRoles();
  assert.equal(role(inbox, "c1"), "pm");
  assert.equal(role(inbox, "c2"), null);
});

test("#48 Beendete oder archivierte Claude-Chats sind keine Anwärter", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/firma", name: "PM firma" });
  // Archiviert ein Mensch den Claude-Chat, fehlt er in der Registry und wird beendet.
  inbox.registrySync().upsert({ pid: 999_999_999, sessionId: "cl", cwd: "/p/firma", name: "PM firma", nameSource: "user", startedAt: null });
  inbox.registrySync().endMissing([]);
  inbox.syncNameRoles();
  assert.equal(role(inbox, "cx"), "pm");
  assert.equal(role(inbox, "cl"), null);
  // Ein Claude-Chat mit totem Prozess gilt ebenfalls nicht als laufend.
  inbox.upsertSession({ id: "tot", app: "claude", cwd: "/p/firma", name: "PM firma", pid: 999_999_999 });
  inbox.syncNameRoles();
  assert.equal(role(inbox, "cx"), "pm");
  assert.equal(role(inbox, "tot"), null);
});

test("#48 Ein Claude-Chat, der Director ist, verliert ihn nicht durch einen PM-Anspruch", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/firma", name: "PM firma" });
  inbox.upsertSession({ id: "d", app: "claude", cwd: "/p/firma", name: "Director" });
  inbox.renameSession("d", "PM firma");
  inbox.syncNameRoles();
  assert.equal(role(inbox, "d"), "director");
  assert.equal(role(inbox, "cx"), "pm");
});

test("#48 set_role an einem Claude-Anwärter vorbei wird abgelehnt und nicht protokolliert", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "cl", app: "claude", cwd: "/p/firma", name: "PM firma" });
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/firma" });
  const n = inbox.roleChanges().length;
  assert.throws(() => inbox.setRole("cx", "pm", "dashboard"), /Claude-Vorrang/);
  assert.equal(role(inbox, "cl"), "pm");
  assert.equal(role(inbox, "cx"), null);
  assert.equal(inbox.roleChanges().length, n);
  // Auch Abgeben scheitert, solange ein weiterer Chat die Rolle beansprucht.
  inbox.renameSession("cx", "PM firma");
  assert.throws(() => inbox.setRole("cl", null, "dashboard"), /Claude-Vorrang/);
  assert.equal(role(inbox, "cl"), "pm");
  // Ohne Namensanspruch des Claude-Chats ist die Übergabe frei.
  inbox.renameSession("cl", "Planung");
  inbox.setRole("cx", "pm", "dashboard");
  assert.equal(role(inbox, "cx"), "pm");
});

// Regression #51: Ein Claude-Chat, der schon die andere exklusive Rolle hält, gewinnt nie
// automatisch. Dann darf er weder set_role blockieren noch einen Dauerkonflikt erzeugen.

test("#51 Regression: Claude-Director mit „PM <projekt>“ blockiert set_role auf einen anderen PM nicht", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/firma", name: "PM firma" });
  inbox.upsertSession({ id: "d", app: "claude", cwd: "/p/firma", name: "Director" });
  inbox.renameSession("d", "PM firma");
  inbox.upsertSession({ id: "neu", app: "codex", cwd: "/p/firma" });
  inbox.syncNameRoles();
  assert.equal(role(inbox, "d"), "director");
  assert.equal(role(inbox, "cx"), "pm");
  // Zwei Chats beanspruchen PM, die Automatik entscheidet nicht: Der Konflikt bleibt sichtbar …
  assert.equal(conflict(inbox, "d")?.holderId, "cx");
  // … und lässt sich per set_role lösen.
  inbox.setRole("neu", "pm", "dashboard");
  assert.equal(role(inbox, "neu"), "pm");
  assert.equal(role(inbox, "cx"), null);
  assert.equal(role(inbox, "d"), "director");
  assert.ok(!inbox.roleChanges().some((c) => c.actor === AUTO));
});

test("#51 Regression: Claude-Director mit „PM <projekt>“ neben einem Claude-PM zeigt keinen Dauerkonflikt", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "p", app: "claude", cwd: "/p/firma", name: "PM firma" });
  inbox.upsertSession({ id: "d", app: "claude", cwd: "/p/firma", name: "Director" });
  inbox.renameSession("d", "PM firma");
  inbox.syncNameRoles();
  assert.equal(role(inbox, "p"), "pm");
  assert.equal(role(inbox, "d"), "director");
  // Der Director gewinnt PM nie automatisch; damit ist p der einzige Claude-Anwärter und hält die Rolle.
  assert.equal(conflict(inbox, "d"), null);
});

test("#51 Ein Claude-Director mit PM-Namen zählt nicht mit: der zweite Claude-Anwärter bekommt PM", () => {
  const { inbox, titles } = setup();
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/p/firma", name: "PM firma" });
  inbox.upsertSession({ id: "d", app: "claude", cwd: "/p/firma", name: "Director" });
  inbox.renameSession("d", "PM firma");
  inbox.upsertSession({ id: "cl", app: "claude", cwd: "/p/firma" });
  titles.set("claude:cl", "PM firma");
  inbox.syncNameRoles();
  assert.equal(role(inbox, "cl"), "pm");
  assert.equal(role(inbox, "d"), "director");
  assert.equal(role(inbox, "cx"), null);
});
