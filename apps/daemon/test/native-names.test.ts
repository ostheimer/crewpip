import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Board } from "../src/board.js";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";

test("Bestehende Chats im gleichen Arbeitsordner behalten getrennte native Titel, Postfächer und Rollen", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-namen-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDb(":memory:");
  t.after(() => db.close());
  const titles = new Map<string, string>();
  const projects = new Map<string, string>();
  const board = new Board(db, { titles, projects });
  const inbox = new Inbox(db, board);
  const a = inbox.upsertSession({ id: "a", app: "codex", cwd: root });
  inbox.upsertSession({ id: "b", app: "claude", cwd: root });
  inbox.endSession("b");
  titles.set("codex:a", "Wartung");
  titles.set("claude:b", "Director");
  const project = () => board.projects().find(p => p.id === a.projectId)!;
  assert.equal(inbox.sessions()[0]!.name, "Wartung");
  assert.deepEqual(project().standaloneChats?.map(c => [c.id, c.name]).sort(), [["a", "Wartung"], ["b", "Director"]]);
  assert.equal(inbox.sessions({ includeEnded: true }).find(s => s.id === "b")?.role, null);
  assert.equal(inbox.sessions().length, 1);
  titles.set("codex:a", "Betrieb");
  assert.equal(inbox.sessions()[0]!.name, "Betrieb");
  inbox.post({ human: "Test" }, "session:a", "Prüfung");
  assert.equal(inbox.take("a", "mcp-read")[0]?.text, "Prüfung");
  projects.set(root, "Werkstatt");
  assert.equal(project().displayName, "Werkstatt");
  assert.equal(project().standaloneChats, undefined);
  assert.equal(project().name, path.basename(root), "Routingname bleibt stabil");
});

test("Lokale App-Metadaten übernehmen Titel und Projektalias beim nächsten Abgleich", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { NativeNames } = await import("../src/registry/native-names.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-quellen-")));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const nested = path.join(tmp, "claude/account/profile");
  fs.mkdirSync(nested, { recursive: true });
  const codex = path.join(tmp, "codex");
  fs.mkdirSync(codex);
  const state = new DatabaseSync(path.join(codex, "state_5.sqlite"));
  t.after(() => state.close());
  state.exec("CREATE TABLE projects (id TEXT, name TEXT, position INTEGER); CREATE TABLE project_roots(project_id TEXT, path TEXT, position INTEGER); CREATE TABLE threads (id TEXT, name TEXT, title TEXT)");
  state.prepare("INSERT INTO projects VALUES ('p', 'Werkstatt', 0)").run();
  state.prepare("INSERT INTO project_roots VALUES ('p', ?, 0)").run(tmp);
  state.prepare("INSERT INTO threads VALUES ('codex-desktop', 'Codex-Titel', 'Alter Chatinhalt')").run();
  fs.writeFileSync(path.join(codex, "session_index.jsonl"), '{"id":"index","thread_name":"Alt"}\n{"id":"index","thread_name":"Neu"}\n{"id":');
  const file = path.join(nested, "local_test.json");
  fs.writeFileSync(file, JSON.stringify({ cliSessionId: "cli", title: "Claude-Titel", sessionId: "nicht-cli" }));
  const names = new NativeNames(codex, path.join(tmp, "claude"));
  const known = [{ id: "index", app: "codex" }, { id: "codex-desktop", app: "codex" }, { id: "cli", app: "claude" }] as const;
  assert.equal(await names.refresh(known), true);
  assert.equal(names.projects.get(tmp), "Werkstatt");
  assert.equal(names.titles.get("codex:codex-desktop"), "Codex-Titel");
  assert.equal(names.titles.get("codex:index"), "Neu");
  assert.equal(names.titles.get("claude:cli"), "Claude-Titel");
  assert.equal(names.titles.has("claude:nicht-cli"), false);
  assert.equal(await names.refresh(known), false);
  fs.writeFileSync(file, '{"cliSessionId":');
  assert.equal(await names.refresh(known), false, "Unfertige Datei verliert den letzten gültigen Titel nicht");
  fs.writeFileSync(file, JSON.stringify({ cliSessionId: "cli", title: "Später umbenannt" }));
  state.prepare("UPDATE projects SET name = 'Lager'").run();
  assert.equal(await names.refresh(known), true);
  assert.equal(names.projects.get(tmp), "Lager");
  assert.equal(names.titles.get("claude:cli"), "Später umbenannt");
});

test("Ein periodischer Namensabgleich lässt gesetzten Alias und neu vergebenen Director in Ruhe", (t) => {
  const db = openDb(":memory:");
  t.after(() => db.close());
  const board = new Board(db, { titles: new Map(), projects: new Map() });
  const inbox = new Inbox(db, board);
  const entry = { pid: process.pid, sessionId: "cli", cwd: "/scratch/ordner", name: "Director", nameSource: "user", startedAt: null };
  inbox.registrySync().upsert(entry);
  assert.equal(inbox.sessions().find(s => s.id === "cli")?.role, "director");
  inbox.upsertSession({ id: "next", app: "codex", cwd: entry.cwd, role: "director" });
  inbox.registrySync().upsert(entry);
  assert.equal(inbox.sessions().find(s => s.id === "next")?.role, "director");
  inbox.renameSession("cli", "Lokaler Alias");
  inbox.registrySync().upsert({ ...entry, name: "PM Team" });
  const cli = inbox.sessions().find(s => s.id === "cli");
  assert.equal(cli?.name, "Lokaler Alias");
  assert.equal(cli?.role, null);
});

test("PM-Ziele gleichnamiger Projektordner treffen nur die gewählte Identität, vorhandene eindeutige Namen funktionieren weiter", (t) => {
  const db = openDb(":memory:");
  t.after(() => db.close());
  const board = new Board(db);
  const inbox = new Inbox(db, board);
  const first = inbox.upsertSession({ app: "codex", id: "a", cwd: "/first/repo", role: "pm" });
  const second = inbox.upsertSession({ app: "claude", id: "b", cwd: "/second/repo", role: "pm" });
  assert.notEqual(first.projectId, second.projectId);
  for (const [target, other] of [[first, second], [second, first]]) {
    const msg = inbox.post({ human: "Test" }, `pm:${target.projectId}`, "Nur ein PM");
    assert.deepEqual(msg.pending, [target.label]);
    assert.deepEqual(inbox.pendingFor(other.id), []);
    assert.deepEqual(inbox.recentFor(other.id, 1).filter(m => m.id === msg.id), []);
    assert.deepEqual(inbox.take(target.id, "mcp-read").map(m => m.id), [msg.id]);
  }
  const unique = inbox.upsertSession({ app: "codex", id: "c", cwd: "/third/Mein Repo", role: "pm" });
  const old = inbox.post({ human: "Test" }, "pm:Mein Repo", "Kompatibel");
  assert.deepEqual(old.pending, [unique.label]);
  assert.deepEqual(inbox.take(unique.id, "mcp-read").map(m => m.id), [old.id]);
});

test("Chatansicht liest wartende Rollenpost und ältere Direktnachrichten ohne Zustellung", (t) => {
  const db = openDb(":memory:");
  t.after(() => db.close());
  const board = new Board(db);
  const inbox = new Inbox(db, board);
  const chat = inbox.upsertSession({ app: "codex", id: "cx", cwd: "/scratch/Rechner", role: "pm" });
  const direct = inbox.post({ human: "Test" }, "session:cx", "Direkt");
  const role = inbox.post({ human: "Test" }, `pm:${chat.projectId}`, "Für den PM");
  for (let i = 0; i < 205; i++) inbox.post({ human: "Test" }, "human:Max", "Andere Post");
  assert.ok(inbox.recent(200).every(m => m.id > role.id));
  assert.deepEqual(inbox.recentFor("cx", 200).map(m => m.id), [direct.id, role.id]);
  assert.deepEqual(inbox.recentFor("cx", 1)[0]?.deliveries, []);
  inbox.endSession("cx");
  assert.deepEqual(inbox.recentFor("cx", 200).map(m => m.id), [direct.id]);
});
