import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";
import { ClaudeRegistryWatcher, readClaudeRegistry } from "../src/registry/claude.js";
import { Board } from "../src/board.js";

function newInbox(): Inbox {
  const db = openDb(":memory:");
  return new Inbox(db, new Board(db));
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-reg-"));
}
function writeEntry(dir: string, pid: number, e: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...e }));
}

test("readClaudeRegistry liest lebende Einträge und lässt tote sowie kaputte aus", () => {
  const dir = tmpDir();
  writeEntry(dir, process.pid, { sessionId: "live", cwd: "/p/crewpip", name: "crewpip-55", nameSource: "derived", startedAt: 1788354767832 });
  writeEntry(dir, 999999, { sessionId: "tot", cwd: "/p/x", name: "x-1" });
  fs.writeFileSync(path.join(dir, "kaputt.json"), "{halb geschrieben");
  fs.writeFileSync(path.join(dir, "egal.key"), "geheim");
  fs.writeFileSync(path.join(dir, "ohne-id.json"), JSON.stringify({ pid: process.pid, cwd: "/p/ohne-id" }));
  fs.writeFileSync(path.join(dir, "0.json"), JSON.stringify({ pid: 0, sessionId: "gruppe", cwd: "/p/gefaehrlich" }));

  const got = readClaudeRegistry(dir);
  assert.deepEqual(got.map((g) => g.sessionId), ["live"], "ohne sessionId, mit pid 0 oder totem Prozess: nicht dabei");
  assert.deepEqual(got[0], {
    pid: process.pid,
    sessionId: "live",
    cwd: "/p/crewpip",
    name: "crewpip-55",
    nameSource: "derived",
    startedAt: new Date(1788354767832).toISOString(),
    status: null,
    statusAt: null,
  });
  assert.deepEqual(readClaudeRegistry(path.join(dir, "gibts-nicht")), [], "fehlendes Verzeichnis ist kein Fehler");
});

test("Namensvorrang: user schlägt registry schlägt auto, und nichts überschreibt einen /rename-Namen", () => {
  const inbox = newInbox();
  const auto = inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/demo-project" });
  assert.match(auto.name, /^Session /);

  const derived = inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/demo-project", name: "demo-project-20", nameSource: "registry" });
  assert.equal(derived.name, "demo-project-20", "registry schlägt auto");

  inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/demo-project", name: "demo-project-21", nameSource: "registry" });
  assert.equal(inbox.sessions()[0]!.name, "demo-project-21", "registry darf registry aktualisieren");

  inbox.renameSession("s1", "deploy-fix");
  inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/demo-project", name: "demo-project-22", nameSource: "registry" });
  assert.equal(inbox.sessions()[0]!.name, "deploy-fix", "registry überschreibt keinen gesetzten Namen");

  inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/demo-project", name: "vom-rename", nameSource: "user" });
  assert.equal(inbox.sessions()[0]!.name, "vom-rename", "/rename in Claude Code gewinnt");

  inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/demo-project" });
  assert.equal(inbox.sessions()[0]!.name, "vom-rename", "ein Hook ohne Namen ändert nichts");
});

test("Watcher übernimmt Sessions samt Socket und trägt verschwundene aus", () => {
  const dir = tmpDir();
  const inbox = newInbox();
  const logs: string[] = [];
  const watcher = new ClaudeRegistryWatcher(inbox.registrySync(), { dir, intervalMs: 10_000, log: (l) => logs.push(l) });

  writeEntry(dir, process.pid, { sessionId: "s-live", cwd: "/p/crewpip", name: "crewpip-55", nameSource: "derived", startedAt: Date.now() });
  watcher.sweep();

  const s = inbox.sessions()[0]!;
  assert.equal(s.label, "Claude · crewpip / crewpip-55");

  // Zugestellt wird über die Hooks; bis dahin wartet die Nachricht sichtbar.
  const m = inbox.post({ human: "Mensch" }, "project:crewpip", "hallo");
  assert.deepEqual(inbox.pendingFor("s-live").map((x) => x.id), [m.id]);

  fs.rmSync(path.join(dir, `${process.pid}.json`));
  watcher.sweep();
  assert.deepEqual(inbox.sessions(), [], "Session verschwindet, wenn ihr Eintrag weg ist");
  assert.equal(inbox.sessions({ includeEnded: true })[0]!.status, "ended");
  assert.match(logs.join(" "), /1 beendete Session/);
  watcher.stop();
});

test("endMissing rührt Sessions ohne pid nicht an", () => {
  const inbox = newInbox();
  inbox.upsertSession({ id: "hook-only", app: "codex", cwd: "/p/a" });
  inbox.upsertSession({ id: "mit-pid", app: "claude", cwd: "/p/b", pid: 4242 });
  assert.equal(inbox.registrySync().endMissing([]), 1);
  assert.deepEqual(inbox.sessions().map((s) => s.id), ["hook-only"]);
});

test("Worktrees zeigen ihr Repository, nicht den Worktree-Ordner", () => {
  const inbox = newInbox();
  const s = inbox.upsertSession({ id: "w1", app: "claude", cwd: "/Users/a/GitHub/example.org/.claude/worktrees/dazzling-gould", name: "dazzling-gould-cb", nameSource: "registry" });
  assert.equal(s.project, "example.org");
  assert.equal(s.worktree, "dazzling-gould");
  assert.equal(s.label, "Claude · example.org (dazzling-gould) / dazzling-gould-cb");

  const plain = inbox.upsertSession({ id: "p1", app: "claude", cwd: "/Users/a/GitHub/example.org", name: "example-org-94", nameSource: "registry" });
  assert.equal(plain.worktree, null);

  // Eine Nachricht an das Projekt erreicht auch die Worktree-Session
  const m = inbox.post({ human: "Mensch" }, "project:example.org", "an alle Fenster des Repos");
  assert.equal(m.pending.length, 2);
  assert.equal(inbox.message(m.id)!.pending.includes("Claude · example.org (dazzling-gould) / dazzling-gould-cb"), true);
});

test("Eine erstmals aus der Registry gelesene Session gilt seit ihrem Start als still", () => {
  const inbox = newInbox();
  const started = new Date(Date.now() - 3 * 3600_000).toISOString();
  inbox.registrySync().upsert({ pid: process.pid, sessionId: "alt", cwd: "/p/a", name: "a-01", nameSource: "derived", startedAt: started });
  const s = inbox.sessions()[0]!;
  assert.equal(s.startedAt, started);
  assert.equal(s.lastSeenAt, started, "kein vorgetäuschtes \"gerade eben\"");
});

test("Der Registry-Abgleich gilt nicht als Aktivität der Session", async () => {
  const inbox = newInbox();
  inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/a", pid: process.pid });
  const before = inbox.sessions()[0]!.lastSeenAt;
  await new Promise((r) => setTimeout(r, 12));
  inbox.registrySync().upsert({ pid: process.pid, sessionId: "s1", cwd: "/p/a", name: "a-01", nameSource: "derived", startedAt: null });
  assert.equal(inbox.sessions()[0]!.lastSeenAt, before, "Abgleich lässt lastSeenAt unberührt");
  assert.equal(inbox.sessions()[0]!.name, "a-01", "übernimmt aber den Namen");

  inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/a" });
  assert.notEqual(inbox.sessions()[0]!.lastSeenAt, before, "ein Hook zählt als Aktivität");
});

test("Ein Hook löst den MCP-Platzhalter desselben Verzeichnisses ab", () => {
  const inbox = newInbox();
  const placeholder = inbox.resolveByCwd("codex", "/p/codex-test");
  assert.equal(placeholder.name, "ohne Hook");

  inbox.upsertSession({ id: "echte-session", app: "codex", cwd: "/p/codex-test", name: "Thread 21:10" });
  assert.deepEqual(inbox.sessions().map((s) => s.id), ["echte-session"], "Platzhalter ist beendet");
  assert.equal(inbox.sessions({ includeEnded: true }).find((s) => s.id === placeholder.id)!.status, "ended");

  // Eine andere App im selben Verzeichnis bleibt unberührt
  const other = inbox.resolveByCwd("cursor", "/p/codex-test");
  inbox.upsertSession({ id: "noch-eine", app: "codex", cwd: "/p/codex-test" });
  assert.ok(inbox.sessions().some((s) => s.id === other.id));
});

test("Eine beendete Session, die sich zurückmeldet, gilt wieder als aktiv", () => {
  const inbox = newInbox();
  inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/a", name: "Director" });
  inbox.endSession("s1");
  assert.equal(inbox.sessions({ includeEnded: true })[0]!.status, "ended");

  // Der Registry-Abgleich erkennt den Prozess wieder.
  inbox.registrySync().upsert({ pid: process.pid, sessionId: "s1", cwd: "/p/a", name: "Director", nameSource: "user", startedAt: null });
  const back = inbox.sessions()[0]!;
  assert.equal(back.status, "idle", "der Status darf nicht auf beendet stehen bleiben");
  assert.equal(back.endedAt, null);
  assert.equal(back.role, "director");

  // Ein ausdrücklicher Status gewinnt weiterhin
  inbox.endSession("s1");
  assert.equal(inbox.upsertSession({ id: "s1", app: "claude", cwd: "/p/a", status: "working" }).status, "working");
});
