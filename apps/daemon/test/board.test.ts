import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { Board } from "../src/board.js";
import { Inbox } from "../src/inbox.js";
import * as git from "../src/git.js";

/** Legt ein echtes Repository mit einem Commit an. */
function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-repo-")));
  const run = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "README.md"), "hallo\n");
  run("add", "README.md");
  run("commit", "-qm", "erster Commit");
  return dir;
}

function fresh() {
  const db = openDb(":memory:");
  const board = new Board(db);
  return { board, inbox: new Inbox(db, board) };
}

test("Projekt wird über die Repository-Wurzel erkannt, auch aus einem Worktree heraus", async () => {
  const root = repo();
  const { board } = fresh();
  const p = board.resolveProject(root);
  assert.equal(p.root, root);
  assert.equal(p.name, path.basename(root));

  const wt = path.join(root, ".crewpip", "worktrees", "probe");
  await git.addWorktree({ root, dir: wt, branch: "probe" });
  assert.equal(board.resolveProject(wt).id, p.id, "ein Worktree gehört zum Haupt-Repository");
  assert.equal(board.projects().length, 1);

  const kein = fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-nogit-"));
  assert.equal(board.resolveProject(kein).root, fs.realpathSync(kein), "ohne git dient das Verzeichnis selbst als Projekt");
  assert.equal(board.resolveProject(fs.realpathSync(kein)).id, board.resolveProject(kein).id, "Symlink-Pfad und aufgelöster Pfad meinen dasselbe Projekt");
});

test("Aufgaben: anlegen, Status wechseln, unmögliche Wechsel ablehnen", () => {
  const { board } = fresh();
  const p = board.resolveProject(os.tmpdir());
  const t = board.create({ projectId: p.id, title: "  Migration schreiben  ", body: "Details", createdBy: "Mensch" });
  assert.equal(t.title, "Migration schreiben");
  assert.equal(t.status, "open");
  assert.equal(board.tasks({ projectId: p.id }).length, 1);

  assert.equal(board.update(t.id, { status: "claimed" }).status, "claimed");
  assert.equal(board.update(t.id, { status: "review" }).status, "review");
  assert.equal(board.update(t.id, { status: "done" }).status, "done");
  assert.throws(() => board.update(t.id, { status: "review" }), /nicht vorgesehen/);
  assert.throws(() => board.create({ projectId: p.id, title: "   ", createdBy: "x" }), /Leerer Titel/);
  assert.throws(() => board.create({ projectId: "gibts-nicht", title: "x", createdBy: "x" }), /Unbekanntes Projekt/);
});

test("Übernehmen: eine Session bekommt den Task, eine zweite wird abgewiesen", () => {
  const { board, inbox } = fresh();
  const p = board.resolveProject(os.tmpdir());
  const a = inbox.upsertSession({ id: "a", app: "claude", cwd: os.tmpdir(), name: "eins" });
  inbox.upsertSession({ id: "b", app: "codex", cwd: os.tmpdir(), name: "zwei" });
  const t = board.create({ projectId: p.id, title: "Aufgabe", createdBy: "Mensch" });

  const claimed = board.claim(t.id, "a");
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.assignee?.id, "a");
  assert.equal(claimed.assignee?.label, a.label);
  assert.equal(board.claim(t.id, "a").assignee?.id, "a", "zweimal übernehmen ist harmlos");
  assert.throws(() => board.claim(t.id, "b"), /schon vergeben an/);

  // Zurückgeben macht ihn wieder frei
  assert.equal(board.update(t.id, { status: "open" }).assignee, null);
  assert.equal(board.claim(t.id, "b").assignee?.id, "b");
  assert.throws(() => board.update(t.id, { assignee: "gibts-nicht" }), /Unbekannte Session/);
});

test("Worktree: anlegen, Session zuordnen, mit Änderungen nicht entfernen, mit force schon", async () => {
  const root = repo();
  const { board, inbox } = fresh();
  const p = board.resolveProject(root);
  const t = board.create({ projectId: p.id, title: "Neue Route bauen", createdBy: "Mensch" });

  const withTree = await board.createWorktree(t.id);
  assert.ok(withTree.worktree, "Worktree ist vermerkt");
  assert.equal(withTree.worktree!.branch, `crewpip/${t.id}-neue-route-bauen`);
  assert.ok(fs.existsSync(path.join(withTree.worktree!.path, "README.md")), "Dateien sind ausgecheckt");
  assert.equal(git.currentBranch(withTree.worktree!.path), withTree.worktree!.branch);
  await assert.rejects(() => board.createWorktree(t.id), /hat schon einen Worktree/);

  // Eine Session in diesem Verzeichnis arbeitet erkennbar an dem Task
  const s = inbox.upsertSession({ id: "w", app: "claude", cwd: withTree.worktree!.path, name: "arbeiter" });
  assert.equal(s.projectId, p.id, "Worktree-Session gehört zum Projekt");
  assert.equal(inbox.sessions().find((x) => x.id === "w")!.task?.id, t.id);

  // Ungesicherte Arbeit blockiert das Entfernen
  fs.writeFileSync(path.join(withTree.worktree!.path, "neu.txt"), "ungesichert\n");
  await assert.rejects(() => board.removeWorktree(t.id), /nicht committete/);
  const nach = await board.removeWorktree(t.id, { force: true });
  assert.equal(nach.worktree, null);
  assert.ok(!fs.existsSync(withTree.worktree!.path));
  assert.ok(!git.branchExists(root, withTree.worktree!.branch), "ein Branch ohne eigene Commits wird mit entfernt");
  assert.deepEqual(board.worktreesOf(p.id).filter((w) => w.managed), []);
});

test("Worktree entfernen wird auch von eigenen Commits blockiert", async () => {
  const root = repo();
  const { board } = fresh();
  const p = board.resolveProject(root);
  const t = board.create({ projectId: p.id, title: "Commit-Test", createdBy: "Mensch" });
  const wt = (await board.createWorktree(t.id)).worktree!.path;
  fs.writeFileSync(path.join(wt, "a.txt"), "x\n");
  const run = (...args: string[]) => execFileSync("git", ["-C", wt, ...args], { stdio: "ignore" });
  run("config", "user.email", "t@e.com");
  run("config", "user.name", "T");
  run("add", "a.txt");
  run("commit", "-qm", "arbeit");
  await assert.rejects(() => board.removeWorktree(t.id), /1 Commit\(s\) nicht in main/);
  const branch = board.task(t.id)!.worktree!.branch;
  await board.removeWorktree(t.id, { force: true });
  assert.ok(git.branchExists(root, branch), "ein Branch mit eigenen Commits bleibt erhalten");
});

test("worktreesOf zeigt fremde Worktrees mit, aber nicht als verwaltet", async () => {
  const root = repo();
  const { board } = fresh();
  const p = board.resolveProject(root);
  await git.addWorktree({ root, dir: path.join(root, ".claude", "worktrees", "fremd"), branch: "claude/fremd" });
  const t = board.create({ projectId: p.id, title: "eigener", createdBy: "Mensch" });
  await board.createWorktree(t.id);
  const all = board.worktreesOf(p.id);
  assert.equal(all.length, 3, "Haupt-Checkout, fremder und eigener Worktree");
  assert.equal(all.filter((w) => w.managed).length, 1);
});

test("slug macht aus Titeln brauchbare Verzeichnisnamen", () => {
  assert.equal(git.slug("Größere Änderung: Umlaute & Co!"), "groessere-aenderung-umlaute-co");
  assert.equal(git.slug("   "), "task");
  assert.equal(git.slug("a".repeat(80)).length, 40);
});

test("Erledigt behält die Zuweisung, zurück in den Topf löscht sie", () => {
  const { board, inbox } = fresh();
  const p = board.resolveProject(os.tmpdir());
  const s = inbox.upsertSession({ id: "w", app: "claude", cwd: os.tmpdir(), name: "Worker x" });
  const t = board.create({ projectId: p.id, title: "Aufgabe", createdBy: "Mensch" });
  board.claim(t.id, s.id);

  const done = board.update(t.id, { status: "done" });
  assert.equal(done.assignee?.id, "w", "wer sie erledigt hat, bleibt sichtbar");

  const wieder = board.update(t.id, { status: "open" });
  assert.equal(wieder.assignee, null, "zurück in den Topf heißt: frei");

  // Auch verworfen behält die Zuweisung
  board.claim(t.id, s.id);
  assert.equal(board.update(t.id, { status: "cancelled" }).assignee?.id, "w");

  // Ein Patch ohne assignee-Feld rührt die Zuweisung nicht an
  board.update(t.id, { status: "open" });
  board.claim(t.id, s.id);
  assert.equal(board.update(t.id, { title: "Neuer Titel" }).assignee?.id, "w");
});

test("Bootstrap läuft im frischen Worktree und sein Ergebnis steht am Task", async () => {
  const root = repo();
  const { board } = fresh();
  const p = board.resolveProject(root);
  assert.equal(p.bootstrap, null, "ohne Angabe wird nichts ausgeführt");

  board.setBootstrap(p.id, "echo hallo-aus-dem-bootstrap > beweis.txt && echo fertig");
  const t = board.create({ projectId: p.id, title: "Mit Bootstrap", createdBy: "Mensch" });
  const withTree = await board.createWorktree(t.id);

  assert.ok(fs.existsSync(path.join(withTree.worktree!.path, "beweis.txt")), "der Befehl lief im Worktree, nicht im Hauptcheckout");
  assert.ok(!fs.existsSync(path.join(root, "beweis.txt")));
  assert.match(withTree.bootstrapLog ?? "", /^erfolgreich/);
  assert.match(withTree.bootstrapLog ?? "", /fertig/);
});

test("Ein fehlgeschlagener Bootstrap lässt den Worktree stehen und nennt den Grund", async () => {
  const root = repo();
  const { board } = fresh();
  const p = board.resolveProject(root);
  board.setBootstrap(p.id, "echo vorher; gibtesnicht-befehl; echo nachher");
  const t = board.create({ projectId: p.id, title: "Kaputter Bootstrap", createdBy: "Mensch" });
  const withTree = await board.createWorktree(t.id);

  assert.ok(withTree.worktree, "der Worktree bleibt bestehen");
  assert.ok(fs.existsSync(withTree.worktree!.path));
  assert.match(withTree.bootstrapLog ?? "", /^FEHLGESCHLAGEN/);
  assert.match(withTree.bootstrapLog ?? "", /gibtesnicht-befehl|not found/i);
  // Nur die Ausgabe prüfen: die erste Zeile wiederholt den Befehl und enthält das Wort ebenfalls.
  const ausgabe = (withTree.bootstrapLog ?? "").split("\n\n").slice(1).join("\n\n");
  assert.ok(ausgabe.includes("vorher"), "was vor dem Fehler lief, steht da");
  assert.ok(!ausgabe.includes("nachher"), "nach dem Fehler läuft nichts weiter");

  // Beim Entfernen verschwindet auch das Protokoll
  await board.removeWorktree(t.id, { force: true });
  assert.equal(board.task(t.id)!.bootstrapLog, null);
});

test("Der Bootstrap-Befehl wird am Projekt gepflegt, nicht aus dem Repository gelesen", () => {
  const root = repo();
  const { board } = fresh();
  const p = board.resolveProject(root);
  // Eine Datei im Repository darf keine Wirkung haben.
  fs.mkdirSync(path.join(root, ".crewpip"), { recursive: true });
  fs.writeFileSync(path.join(root, ".crewpip", "bootstrap"), "echo aus-dem-repo > uebernommen.txt");
  assert.equal(board.project(p.id)!.bootstrap, null, "CrewPip führt nichts aus, was das Repository mitbringt");

  assert.equal(board.setBootstrap(p.id, "  echo x  ").bootstrap, "echo x");
  assert.equal(board.setBootstrap(p.id, "   ").bootstrap, null, "leer heißt: keiner");
  assert.throws(() => board.setBootstrap("gibtsnicht", "x"), /Unbekanntes Projekt/);
});
