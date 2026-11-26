import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { Board } from "../src/board.js";

// Regressionstests Issue #44: Post an eine Rolle wird genau einmal zugestellt, auch wenn die
// Rolle danach an eine andere Session geht (gleicher Chat nach Neustart oder anderer Chat).

function setup() {
  const db = openDb(":memory:");
  const board = new Board(db, { titles: new Map(), projects: new Map() });
  return { db, inbox: new Inbox(db, board) };
}

for (const [fall, nachfolger] of [
  ["gleicher Chat nach Neustart", { id: "pm-neu", app: "claude" as const, cwd: "/p/crewpip" }],
  ["anderer Chat", { id: "pm-codex", app: "codex" as const, cwd: "/p/crewpip/.claude/worktrees/x" }],
] as const) {
  test(`#44 Rollen-Post an pm: kommt nach Rollenwechsel (${fall}) nicht erneut`, () => {
    const { inbox } = setup();
    inbox.upsertSession({ id: "absender", app: "codex", cwd: "/p/werkstatt" });
    inbox.upsertSession({ id: "pm-alt", app: "claude", cwd: "/p/crewpip" });
    inbox.setRole("pm-alt", "pm", "Test");

    const alt = inbox.post({ sessionId: "absender" }, "pm:crewpip", "Schon zugestellt");
    assert.deepEqual(inbox.take("pm-alt", "hook-prompt").map((m) => m.id), [alt.id]);

    // Rolle wechselt: alte Session endet, Nachfolger übernimmt die Rolle
    inbox.endSession("pm-alt");
    inbox.upsertSession(nachfolger);
    inbox.setRole(nachfolger.id, "pm", "Test");
    const neu = inbox.post({ sessionId: "absender" }, "pm:crewpip", "Noch nicht zugestellt");

    assert.deepEqual(inbox.pendingFor(nachfolger.id).map((m) => m.id), [neu.id], "nur die noch nicht zugestellte Post");
    assert.deepEqual(inbox.message(alt.id)?.pending, [], "zugestellte Rollen-Post wartet auf niemanden mehr");
    assert.deepEqual(inbox.take(nachfolger.id, "hook-prompt").map((m) => m.id), [neu.id]);
    assert.deepEqual(inbox.pendingFor(nachfolger.id), []);
  });
}

test("#44 Director-Post kommt nach Rollenwechsel nicht erneut, wartende schon", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "absender", app: "codex", cwd: "/p/werkstatt" });
  inbox.upsertSession({ id: "dir-alt", app: "claude", cwd: "/p/zentrale" });
  inbox.setRole("dir-alt", "director", "Test");
  const alt = inbox.post({ sessionId: "absender" }, "director", "Schon zugestellt");
  inbox.take("dir-alt", "mcp-read");
  inbox.endSession("dir-alt");

  const wartend = inbox.post({ sessionId: "absender" }, "director", "Wartet auf den neuen Director");
  inbox.upsertSession({ id: "dir-neu", app: "claude", cwd: "/p/zentrale" });
  inbox.setRole("dir-neu", "director", "Test");
  assert.deepEqual(inbox.pendingFor("dir-neu").map((m) => m.id), [wartend.id]);
  assert.notEqual(alt.id, wartend.id);
});

test("#44 Andere Ziele bleiben je Session: all-Post erreicht jede Session einzeln", () => {
  const { inbox } = setup();
  inbox.upsertSession({ id: "absender", app: "codex", cwd: "/p/werkstatt" });
  inbox.upsertSession({ id: "a", app: "claude", cwd: "/p/a" });
  inbox.upsertSession({ id: "b", app: "claude", cwd: "/p/b" });
  const m = inbox.post({ sessionId: "absender" }, "all", "Rundruf");
  inbox.take("a", "mcp-read");
  assert.deepEqual(inbox.pendingFor("b").map((x) => x.id), [m.id]);
});
