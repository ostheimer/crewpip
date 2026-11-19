import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { Board } from "../src/board.js";
import { Inbox } from "../src/inbox.js";
import { Runner } from "../src/runner/index.js";
import { RUNNER_APPS, codexApp, claudeApp } from "../src/runner/apps.js";
import type { RunItem, RunStatus } from "@crewpip/shared";

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-run-")));
  const run = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@e.com");
  run("config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  run("add", "README.md");
  run("commit", "-qm", "init");
  return dir;
}

/** Ersetzt das echte Programm durch ein Skript, das Codex-förmige Zeilen ausgibt. */
function stubApp(script: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-stub-")), "stub.sh");
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

function setup(binPath: string | null) {
  const db = openDb(":memory:");
  const board = new Board(db);
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-logs-"));
  const original = codexApp.bin;
  const originalAuth = codexApp.loggedIn;
  codexApp.bin = () => binPath;
  // Der Stub kennt kein "login status"; die Anmeldung gilt im Test als vorhanden.
  codexApp.loggedIn = () => true;
  const runner = new Runner(db, board, { logDir, timeoutMs: 5000, log: () => {} });
  return { board, runner, restore: () => { codexApp.bin = original; codexApp.loggedIn = originalAuth; } };
}

async function settled(runner: Runner, id: number, tries = 60): Promise<RunStatus> {
  for (let i = 0; i < tries; i++) {
    const r = runner.run(id)!;
    if (r.status !== "running") return r.status;
    await new Promise((res) => setTimeout(res, 50));
  }
  return "running";
}

test("Ein Lauf wird gestartet, die Ausgabe aufbereitet und der Abschluss verbucht", async () => {
  const root = repo();
  const stub = stubApp(`#!/bin/sh
echo '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"Ich sehe mir das an."}}'
echo 'kein JSON, wird übersprungen'
echo '{"type":"item.completed","item":{"id":"2","type":"command_execution","command":"npm test","status":"completed"}}'
echo '{"type":"item.completed","item":{"id":"3","type":"mcp_tool_call","server":"crewpip","tool":"read_inbox","status":"completed"}}'
echo '{"type":"item.completed","item":{"id":"4","type":"agent_message","text":"Fertig, Tests sind grün."}}'
exit 0`);
  const { board, runner, restore } = setup(stub);
  const p = board.resolveProject(root);
  const t = board.create({ projectId: p.id, title: "Tests prüfen", createdBy: "Mensch" });

  const items: RunItem[] = [];
  runner.on("item", (_id, i) => items.push(i));
  const run = runner.start({ taskId: t.id, prompt: "Prüfe die Tests", app: "codex", mode: "read-only" });
  assert.equal(run.status, "running");
  assert.equal(run.cwd, root, "ohne Worktree läuft es im Projekt");

  assert.equal(await settled(runner, run.id), "done");
  const done = runner.run(run.id)!;
  assert.equal(done.exitCode, 0);
  assert.equal(done.summary, "Fertig, Tests sind grün.", "die letzte Antwort wird als Zusammenfassung gemerkt");
  assert.deepEqual(items.map((i) => i.kind), ["message", "command", "tool", "message"]);
  assert.deepEqual(runner.items(run.id).map((i) => i.text), ["Ich sehe mir das an.", "npm test", "crewpip · read_inbox", "Fertig, Tests sind grün."]);
  restore();
});

test("Ein fehlgeschlagener Lauf wird als solcher verbucht und nennt die Ursache", async () => {
  const root = repo();
  const stub = stubApp(`#!/bin/sh
echo "etwas ist schiefgelaufen" >&2
exit 3`);
  const { board, runner, restore } = setup(stub);
  const p = board.resolveProject(root);
  const run = runner.start({ projectId: p.id, prompt: "x", app: "codex", mode: "read-only" });
  assert.equal(await settled(runner, run.id), "failed");
  const r = runner.run(run.id)!;
  assert.equal(r.exitCode, 3);
  assert.match(r.summary ?? "", /etwas ist schiefgelaufen/);
  restore();
});

test("Fehlende Anmeldung wird erkannt und mit einem Hinweis beantwortet", async () => {
  const root = repo();
  const stub = stubApp(`#!/bin/sh
echo "Not logged in. Please run codex login" >&2
exit 1`);
  const { board, runner, restore } = setup(stub);
  const p = board.resolveProject(root);
  const run = runner.start({ projectId: p.id, prompt: "x", app: "codex", mode: "read-only" });
  assert.equal(await settled(runner, run.id), "failed");
  assert.match(runner.run(run.id)!.summary ?? "", /codex login/);
  restore();
});

test("Ein laufender Agent lässt sich abbrechen", async () => {
  const root = repo();
  const stub = stubApp(`#!/bin/sh
echo '{"type":"item.completed","item":{"type":"agent_message","text":"arbeite"}}'
sleep 30`);
  const { board, runner, restore } = setup(stub);
  const p = board.resolveProject(root);
  const run = runner.start({ projectId: p.id, prompt: "lange Aufgabe", app: "codex", mode: "read-only" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(runner.run(run.id)!.status, "running");
  assert.equal(runner.stop(run.id).status, "stopped");
  assert.equal(runner.run(run.id)!.endedAt !== null, true);
  restore();
});

test("Zeitüberschreitung beendet den Lauf", async () => {
  const root = repo();
  const stub = stubApp(`#!/bin/sh
sleep 30`);
  const db = openDb(":memory:");
  const board = new Board(db);
  const original = codexApp.bin;
  const originalAuth = codexApp.loggedIn;
  codexApp.bin = () => stub;
  codexApp.loggedIn = () => true;
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "l-")), timeoutMs: 300, log: () => {} });
  const p = board.resolveProject(root);
  const run = runner.start({ projectId: p.id, prompt: "x", app: "codex", mode: "read-only" });
  assert.equal(await settled(runner, run.id), "timeout");
  codexApp.bin = original;
  codexApp.loggedIn = originalAuth;
});

test("Grenzen: schreibend nur im Worktree, nie außerhalb des Projekts, nicht ohne Auftrag", async () => {
  const root = repo();
  const { board, runner, restore } = setup(stubApp("#!/bin/sh\nexit 0"));
  const p = board.resolveProject(root);
  const t = board.create({ projectId: p.id, title: "Schreiben", createdBy: "Mensch" });

  assert.throws(() => runner.start({ taskId: t.id, prompt: "x", app: "codex", mode: "worktree-write" }), /brauchen einen Worktree/);
  assert.doesNotThrow(() => runner.start({ taskId: t.id, prompt: "x", app: "codex", mode: "worktree-write", allowProjectRoot: true }));
  assert.throws(() => runner.start({ projectId: p.id, cwd: os.tmpdir(), prompt: "x", app: "codex", mode: "read-only" }), /liegt außerhalb von/);
  assert.throws(() => runner.start({ projectId: p.id, prompt: "   ", app: "codex", mode: "read-only" }), /Leerer Auftrag/);
  assert.throws(() => runner.start({ projectId: p.id, prompt: "x", app: "cursor", mode: "read-only" }), /Unbekannte App|nicht gefunden/);
  assert.throws(() => runner.start({ prompt: "x", app: "codex", mode: "read-only" }), /Weder Task noch Projekt/);

  // Mit Worktree ist der schreibende Lauf erlaubt
  const withTree = await board.createWorktree(t.id);
  const ok = runner.start({ taskId: t.id, prompt: "x", app: "codex", mode: "worktree-write" });
  assert.equal(ok.cwd, withTree.worktree!.path);
  restore();
});

test("Fehlt die Angabe und fehlt das Programm, wird die Angabe gemeldet", () => {
  const root = repo();
  // Kein Programm auf diesem Rechner — so sieht es ohne Codex im PATH wirklich aus.
  const { board, runner, restore } = setup(null);
  const p = board.resolveProject(root);

  try {
    // Eine fehlende Angabe ist ein Fehler des Aufrufers; die kann er abstellen, die Umgebung nicht.
    assert.throws(() => runner.start({ prompt: "x", app: "codex", mode: "read-only" }), /Weder Task noch Projekt/);
    assert.throws(() => runner.start({ projectId: p.id, prompt: "   ", app: "codex", mode: "read-only" }), /Leerer Auftrag/);
    // Stimmt der Auftrag, bleibt das fehlende Programm sehr wohl ein Grund, nicht zu starten.
    assert.throws(() => runner.start({ projectId: p.id, prompt: "x", app: "codex", mode: "read-only" }), /nicht gefunden worden/);
  } finally {
    // Ohne finally bliebe das Attrappen-Programm stehen und die folgenden Tests würden mitfallen.
    restore();
  }
});

test("Mehr als vier gleichzeitige Läufe werden abgelehnt", async () => {
  const root = repo();
  const { board, runner, restore } = setup(stubApp("#!/bin/sh\nsleep 20"));
  const p = board.resolveProject(root);
  for (let i = 0; i < 4; i++) runner.start({ projectId: p.id, prompt: `x${i}`, app: "codex", mode: "read-only" });
  assert.throws(() => runner.start({ projectId: p.id, prompt: "zuviel", app: "codex", mode: "read-only" }), /laufen bereits 4 Agents/);
  runner.stopAll();
  restore();
});

test("Claude-Code-Zeilen werden ebenfalls verstanden", () => {
  assert.deepEqual(claudeApp.parse('{"type":"assistant","message":{"content":[{"type":"text","text":"Hallo"}]}}')?.text, "Hallo");
  assert.equal(claudeApp.parse('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}')?.kind, "command");
  assert.equal(claudeApp.parse('{"type":"result","is_error":true,"result":"Not logged in"}')?.kind, "error");
  assert.equal(claudeApp.authProblem("Not logged in · Please run /login"), true);
  assert.equal(claudeApp.parse("kaputt"), null);
  assert.deepEqual(Object.keys(RUNNER_APPS).sort(), ["claude", "codex"]);
});

test("Der Aufruf trägt den Sandbox-Modus und das Verzeichnis", () => {
  const ro = codexApp.args({ cwd: "/p", prompt: "tu was", mode: "read-only" });
  assert.deepEqual(ro.slice(0, 8), ["exec", "-C", "/p", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "tu was"]);
  assert.ok(codexApp.args({ cwd: "/p", prompt: "x", mode: "worktree-write" }).includes("workspace-write"));
  assert.ok(!ro.includes("--dangerously-bypass-hook-trust"), "Hook-Freigabe wird nicht umgangen");
  assert.ok(claudeApp.args({ cwd: "/p", prompt: "x", mode: "read-only" }).includes("plan"));
  assert.ok(claudeApp.args({ cwd: "/p", prompt: "x", mode: "worktree-write" }).includes("acceptEdits"));
});

test("Meldet das Werkzeug die fehlende Anmeldung über die Standardausgabe, steht trotzdem der Hinweis da", async () => {
  const root = repo();
  const stub = stubApp(`#!/bin/sh
echo '{"type":"item.completed","item":{"type":"error","message":"Not logged in. Please run codex login"}}'
exit 1`);
  const { board, runner, restore } = setup(stub);
  const p = board.resolveProject(root);
  const run = runner.start({ projectId: p.id, prompt: "x", app: "codex", mode: "read-only" });
  assert.equal(await settled(runner, run.id), "failed");
  const summary = runner.run(run.id)!.summary ?? "";
  assert.match(summary, /Anmeldung fehlt/);
  assert.match(summary, /codex login/);
  restore();
});

test("Ein Fehler ohne Anmeldungsproblem behält die Rohmeldung als Zusammenfassung", async () => {
  const root = repo();
  const stub = stubApp(`#!/bin/sh
echo '{"type":"item.completed","item":{"type":"error","message":"Repository ist kaputt"}}'
exit 2`);
  const { board, runner, restore } = setup(stub);
  const p = board.resolveProject(root);
  const run = runner.start({ projectId: p.id, prompt: "x", app: "codex", mode: "read-only" });
  assert.equal(await settled(runner, run.id), "failed");
  assert.match(runner.run(run.id)!.summary ?? "", /Repository ist kaputt/);
  restore();
});

test("Ein nicht angemeldetes Werkzeug wird gar nicht erst gestartet", () => {
  const root = repo();
  const db = openDb(":memory:");
  const board = new Board(db);
  const original = codexApp.bin;
  const originalAuth = codexApp.loggedIn;
  codexApp.bin = () => "/bin/echo";
  codexApp.loggedIn = () => false;
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "l-")), log: () => {} });
  const p = board.resolveProject(root);
  assert.throws(() => runner.start({ projectId: p.id, prompt: "x", app: "codex", mode: "read-only" }), /nicht angemeldet/);
  assert.equal(runner.available().find((a) => a.app === "codex")?.loggedIn, false);
  codexApp.bin = original;
  codexApp.loggedIn = originalAuth;
});

test("Anmeldestatus wird gepuffert und lässt sich verwerfen", () => {
  const db = openDb(":memory:");
  const original = codexApp.bin;
  const originalAuth = codexApp.loggedIn;
  let calls = 0;
  codexApp.bin = () => "/bin/echo";
  codexApp.loggedIn = () => { calls++; return true; };
  const runner = new Runner(db, new Board(db), { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "l-")), log: () => {} });
  runner.available();
  runner.available();
  assert.equal(calls, 1, "zweiter Aufruf kommt aus dem Puffer");
  runner.forgetAuth();
  runner.available();
  assert.equal(calls, 2);
  codexApp.bin = original;
  codexApp.loggedIn = originalAuth;
});

test("Der Anmeldestatus wird aus beiden Ausgabekanälen gelesen", () => {
  // Codex meldet über stderr, Claude Code als JSON über stdout.
  const stderrOnly = stubApp('#!/bin/sh\necho "Logged in using ChatGPT" >&2\nexit 0');
  const stdoutJson = stubApp('#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claudeai"}\'\nexit 0');
  const nothing = stubApp("#!/bin/sh\nexit 0");
  assert.equal(codexApp.loggedIn(stderrOnly), true);
  assert.equal(claudeApp.loggedIn(stdoutJson), true);
  assert.equal(codexApp.loggedIn(nothing), null, "keine Ausgabe heißt: nicht feststellbar");
  assert.equal(claudeApp.loggedIn(stubApp('#!/bin/sh\necho \'{"loggedIn":false}\'')), false);
  assert.equal(codexApp.loggedIn("/nicht/vorhanden"), null);
});

test("Herkunft: wer den Lauf anstieß, steht dran, und ein Lauf darf keine Läufe starten", () => {
  const root = repo();
  const db = openDb(":memory:");
  const board = new Board(db);
  const inbox = new Inbox(db, board);
  const original = codexApp.bin;
  const originalAuth = codexApp.loggedIn;
  codexApp.bin = () => stubApp("#!/bin/sh\nsleep 5");
  codexApp.loggedIn = () => true;
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "l-")), log: () => {} });
  const p = board.resolveProject(root);

  const chef = inbox.upsertSession({ id: "chef", app: "claude", cwd: root, name: "Director" });
  const run = runner.start({ projectId: p.id, prompt: "sieh nach", app: "codex", mode: "read-only", startedBySessionId: chef.id });
  assert.equal(run.startedBy?.id, "chef");
  assert.equal(run.startedBy?.label, chef.label, "der Anstoßende steht mit vollem Namen dran");

  // Die Session, die aus dem Lauf hervorgeht, darf nicht weiterstarten.
  inbox.upsertSession({ id: "kind", app: "codex", cwd: root, name: `Lauf #${run.id}`, runId: run.id });
  assert.equal(inbox.sessions().find((s) => s.id === "kind")!.spawnedByRun, run.id);
  assert.equal(inbox.sessionOfRun(run.id), "kind");
  assert.throws(
    () => runner.start({ projectId: p.id, prompt: "noch einer", app: "codex", mode: "read-only", startedBySessionId: "kind" }),
    /stammt selbst aus Lauf #\d+ und darf keine Läufe starten/,
  );
  assert.throws(() => runner.start({ projectId: p.id, prompt: "x", app: "codex", mode: "read-only", startedBySessionId: "gibts-nicht" }), /Unbekannte Session/);

  // Nur wer anstößt, darf abbrechen.
  assert.equal(runner.ownedBy(run.id, "chef"), true);
  assert.equal(runner.ownedBy(run.id, "kind"), false);
  runner.stopAll();
  codexApp.bin = original;
  codexApp.loggedIn = originalAuth;
});

test("Obergrenze je Stunde bremst eine Session, die Läufe am Fließband startet", () => {
  const root = repo();
  const db = openDb(":memory:");
  const board = new Board(db);
  const inbox = new Inbox(db, board);
  const original = codexApp.bin;
  const originalAuth = codexApp.loggedIn;
  codexApp.bin = () => stubApp("#!/bin/sh\nexit 0");
  codexApp.loggedIn = () => true;
  const runner = new Runner(db, board, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "l-")), maxParallel: 99, log: () => {} });
  const p = board.resolveProject(root);
  inbox.upsertSession({ id: "vielstarter", app: "claude", cwd: root, name: "Director" });

  process.env.CREWPIP_RUNS_PER_HOUR = "3";
  try {
    for (let i = 0; i < 3; i++) runner.start({ projectId: p.id, prompt: `x${i}`, app: "codex", mode: "read-only", startedBySessionId: "vielstarter" });
    assert.throws(
      () => runner.start({ projectId: p.id, prompt: "zuviel", app: "codex", mode: "read-only", startedBySessionId: "vielstarter" }),
      /schon 3 Läufe gestartet \(Obergrenze 3\)/,
    );
    // Aus der Oberfläche gilt die Grenze nicht.
    assert.doesNotThrow(() => runner.start({ projectId: p.id, prompt: "von Hand", app: "codex", mode: "read-only" }));
  } finally {
    delete process.env.CREWPIP_RUNS_PER_HOUR;
    runner.stopAll();
    codexApp.bin = original;
    codexApp.loggedIn = originalAuth;
  }
});

// ---- Option A: fester Grundstock, Push durch CrewPip ---------------------------------

import { WRITE_DENY } from "../src/runner/apps.js";
import * as gitMod from "../src/git.js";

/** Repository mit lokalem Remote und Hook-Verzeichnis, wie in demo-project über core.hooksPath. */
function repoWithRemote(prePush: "gruen" | "rot"): { root: string; remote: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-push-")));
  const remote = path.join(base, "remote.git");
  const root = path.join(base, "haupt");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const run = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  run("config", "user.email", "t@e.com");
  run("config", "user.name", "T");
  fs.writeFileSync(path.join(root, "README.md"), "start\n");
  run("add", "README.md");
  run("commit", "-qm", "init");
  run("remote", "add", "origin", remote);
  run("push", "-q", "origin", "main");
  const hooks = path.join(root, ".husky");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-push"), prePush === "gruen" ? "#!/bin/sh\necho pre-push-gruen\nexit 0\n" : "#!/bin/sh\necho pre-push-rot: Tests fehlgeschlagen >&2\nexit 1\n", { mode: 0o755 });
  run("config", "core.hooksPath", hooks);
  return { root, remote };
}

/** Agent-Stellvertreter, der im Worktree eine Datei anlegt und committet. */
const committingAgent = () => stubApp(`#!/bin/sh
echo arbeit > ergebnis.txt
git add ergebnis.txt
git -c user.email=a@e.com -c user.name=Agent commit -qm "Arbeit des Agents"
echo '{"type":"item.completed","item":{"type":"agent_message","text":"committet"}}'
exit 0`);

async function waitDone(runner: Runner, id: number) {
  for (let i = 0; i < 200; i++) {
    const r = runner.run(id)!;
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  return runner.run(id)!;
}

test("Grundstock: committen und prüfen erlaubt, jeder Push des Agents verboten", () => {
  const args = claudeApp.args({ cwd: "/p", prompt: "x", mode: "worktree-write" });
  const allow = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  const deny = args.slice(args.indexOf("--disallowedTools") + 1);
  assert.ok(allow.includes("Bash(git commit *)"));
  assert.ok(allow.includes("Bash(pnpm test)") && allow.includes("Bash(pnpm typecheck)") && allow.includes("Bash(pnpm install *)"));
  assert.ok(!allow.some((a) => /git push/.test(a)), "der Agent darf nicht pushen");
  assert.ok(!allow.some((a) => /pnpm (run|exec|dlx)/.test(a)), "keine beliebigen Skripte");
  assert.deepEqual(deny, ["Bash(git push)", "Bash(git push *)"]);
  assert.deepEqual(WRITE_DENY, deny);
  for (const command of ["check-ignore", "log", "diff", "show", "blame", "rev-parse", "ls-files"]) {
    assert.ok(allow.includes(`Bash(git ${command})`), `${command} without args`);
    assert.ok(allow.includes(`Bash(git ${command} *)`), `${command} with args`);
  }
  assert.equal(args.includes("x"), false, "der Auftrag steht nicht in den Argumenten, er käme sonst als Muster an");
  assert.equal(claudeApp.promptVia, "stdin");

  const ro = claudeApp.args({ cwd: "/p", prompt: "x", mode: "read-only" });
  assert.equal(ro.includes("--allowedTools"), false, "nur lesende Läufe bekommen keinen Grundstock");
});

test("Codex bekommt nur die Git-Pfade für den Commit frei, nicht config und hooks", async () => {
  const { root } = repoWithRemote("gruen");
  const { board, restore } = setup(stubApp("#!/bin/sh\nexit 0"));
  const p = board.resolveProject(root);
  const t = board.create({ projectId: p.id, title: "Codex Pfade", createdBy: "Mensch" });
  const wt = (await board.createWorktree(t.id)).worktree!;
  const paths = gitMod.worktreeCommitPaths(wt.path, wt.branch)!;
  const common = path.join(root, ".git");
  assert.deepEqual(paths.map((x) => path.relative(common, x)).sort(), [
    "logs/refs/heads/crewpip", "objects", "refs/heads/crewpip", path.join("worktrees", path.basename(wt.path)),
  ].sort());
  assert.ok(!paths.some((x) => /[/\\](config|hooks)$/.test(x)));

  const args = codexApp.args({ cwd: wt.path, prompt: "x", mode: "worktree-write", gitWritable: paths });
  const i = args.indexOf("-c");
  assert.ok(i > 0 && args[i + 1]!.startsWith("sandbox_workspace_write.writable_roots="));
  assert.equal(codexApp.args({ cwd: wt.path, prompt: "x", mode: "read-only", gitWritable: paths }).includes("-c"), false);
  restore();
});

test("Nach einem erfolgreichen Lauf pusht CrewPip genau den Branch, main bleibt unberührt", async () => {
  const { root, remote } = repoWithRemote("gruen");
  const { board, runner, restore } = setup(committingAgent());
  const p = board.resolveProject(root);
  const t = board.create({ projectId: p.id, title: "Push Probe", createdBy: "Mensch" });
  const wt = (await board.createWorktree(t.id)).worktree!;
  const mainVorher = execFileSync("git", ["-C", remote, "rev-parse", "main"], { encoding: "utf8" }).trim();

  const run = runner.start({ taskId: t.id, prompt: "arbeite", app: "codex", mode: "worktree-write" });
  const done = await waitDone(runner, run.id);
  assert.equal(done.status, "done", done.summary ?? "");
  assert.match(done.pushLog ?? "", /^gepusht: origin\/crewpip\//);
  assert.match(done.pushLog ?? "", /pre-push-gruen/, "der pre-push-Hook lief beim Push mit");

  assert.match(done.pushLog ?? "", /pre-push: Start .+ \| Ende .+ \| Exit [01] \| Dauer [\d.]+ s/);
  const heads = execFileSync("git", ["-C", remote, "branch", "--format=%(refname:short)"], { encoding: "utf8" });
  assert.ok(heads.includes(wt.branch), "der Branch liegt im Remote");
  assert.equal(execFileSync("git", ["-C", remote, "rev-parse", "main"], { encoding: "utf8" }).trim(), mainVorher, "main ist unverändert");
  restore();
});

test("Ein roter pre-push-Hook macht den Lauf zum Fehlschlag, der Commit bleibt lokal", async () => {
  const { root, remote } = repoWithRemote("rot");
  const { board, runner, restore } = setup(committingAgent());
  const p = board.resolveProject(root);
  const t = board.create({ projectId: p.id, title: "Roter Hook", createdBy: "Mensch" });
  const wt = (await board.createWorktree(t.id)).worktree!;

  const run = runner.start({ taskId: t.id, prompt: "arbeite", app: "codex", mode: "worktree-write" });
  const done = await waitDone(runner, run.id);
  assert.equal(done.status, "failed");
  assert.match(done.summary ?? "", /committet, der Push aber gescheitert/);
  assert.match(done.pushLog ?? "", /^PUSH FEHLGESCHLAGEN/);
  assert.match(done.pushLog ?? "", /Tests fehlgeschlagen/, "der Grund aus dem Hook steht im Protokoll");
  assert.match(done.pushLog ?? "", /pre-push: Start .+ \| Ende .+ \| Exit [01] \| Dauer [\d.]+ s/);
  const heads = execFileSync("git", ["-C", remote, "branch", "--format=%(refname:short)"], { encoding: "utf8" });
  assert.ok(!heads.includes(wt.branch), "nichts im Remote");
  assert.equal(gitMod.commitsAhead(wt.path, "main"), 1, "die Arbeit ist nicht verloren");
  restore();
});

test("Ohne Commit wird nichts gepusht, und fremde Branches pusht CrewPip nie", async () => {
  const { root } = repoWithRemote("gruen");
  const { board, runner, restore } = setup(stubApp('#!/bin/sh\necho \'{"type":"item.completed","item":{"type":"agent_message","text":"nichts zu tun"}}\'\nexit 0'));
  const p = board.resolveProject(root);
  const t = board.create({ projectId: p.id, title: "Nichts zu tun", createdBy: "Mensch" });
  await board.createWorktree(t.id);
  const done = await waitDone(runner, runner.start({ taskId: t.id, prompt: "x", app: "codex", mode: "worktree-write" }).id);
  assert.equal(done.status, "done");
  assert.match(done.pushLog ?? "", /nichts gepusht/);

  assert.match((await gitMod.pushBranch(root, "main")).output, /nur CrewPip-Branches/);
  assert.match((await gitMod.pushBranch(root, "crewpip/x:main")).output, /nur CrewPip-Branches/);
  restore();
});


test("Hook evidence distinguishes absent, interrupted and nested subprocesses", () => {
  const events = [
    { event: "child_start", child_class: "hook", hook_name: "pre-push", sid: "root", child_id: 1, time: "start" },
    { event: "child_exit", sid: "root/nested", child_id: 1, code: 99, t_rel: 10, time: "wrong" },
    { event: "child_exit", sid: "root", child_id: 1, code: 0, t_rel: 1.25, time: "end" },
  ];
  assert.match(gitMod.prePushEvidence(events.map(e => JSON.stringify(e)).join("\n")), /Ende end \| Exit 0 \| Dauer 1.250 s/);
  assert.match(gitMod.prePushEvidence(JSON.stringify(events[0])), /Ende nicht belegt \| Exit unbekannt/);
  assert.match(gitMod.prePushEvidence("broken\n{}"), /keine Ausführung/);
});

test("A push without a pre-push hook does not claim that the hook ran", async () => {
  const { root } = repoWithRemote("gruen");
  fs.unlinkSync(path.join(root, ".husky", "pre-push"));
  execFileSync("git", ["-C", root, "branch", "crewpip/no-hook"]);
  const result = await gitMod.pushBranch(root, "crewpip/no-hook");
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /keine Ausführung/);
});
