import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { parse as parseToml } from "smol-toml";
import { fileURLToPath } from "node:url";
import { legacyName, oldLabel } from "../migration.mjs";

const service = fileURLToPath(new URL("../service.mjs", import.meta.url));

function fixture(t, projectName = "project") {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-upgrade-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const old = path.join(home, "." + legacyName);
  const current = path.join(home, ".crewpip");
  fs.mkdirSync(path.join(old, "runs"), { recursive: true });
  fs.mkdirSync(path.join(old, "backups"));
  fs.writeFileSync(path.join(old, "runs/4.jsonl"), "example run\n");
  fs.writeFileSync(path.join(old, "token"), "local-test-secret\n", { mode: 0o600 });
  fs.writeFileSync(path.join(old, "backups", legacyName + "-2026.db"), "archived data");
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(
    path.join(home, "bin", "launchctl"),
    '#!/bin/sh\nif [ "$1" = print ]; then echo "Could not find service" >&2; exit 113; fi\nexit 91\n',
    { mode: 0o700 },
  );
  const project = path.join(home, projectName);
  fs.mkdirSync(project);
  function git(cwd, ...args) {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  git(project, "init", "-b", "main");
  git(
    project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.org",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const oldTree = path.join(project, "." + legacyName, "worktrees/task");
  const newTree = path.join(project, ".crewpip/worktrees/task");
  git(project, "worktree", "add", "-b", legacyName + "/task", oldTree);
  fs.writeFileSync(path.join(oldTree, "untracked"), "keep");
  const db = new DatabaseSync(path.join(old, legacyName + ".db"));
  db.exec(
    "CREATE TABLE runs (id INTEGER PRIMARY KEY,status TEXT,cwd TEXT,log_path TEXT); CREATE TABLE projects (id TEXT PRIMARY KEY,root TEXT); CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id TEXT,worktree_path TEXT,worktree_branch TEXT); CREATE TABLE sessions (id TEXT PRIMARY KEY,cwd TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY,text TEXT); CREATE TABLE deliveries (message_id INTEGER,session_id TEXT)",
  );
  db.prepare("INSERT INTO projects VALUES (?,?)").run("p", project);
  db.prepare("INSERT INTO tasks VALUES (1,'p',?,?)").run(oldTree, legacyName + "/task");
  db.prepare("INSERT INTO runs VALUES (4,'done',?,?)").run(oldTree, path.join(old, "runs/4.jsonl"));
  db.prepare("INSERT INTO sessions VALUES ('s',?)").run(oldTree);
  db.exec("INSERT INTO messages VALUES (8,'saved message'); INSERT INTO deliveries VALUES (8,'s')");
  db.close();
  const env = { HOME: home, PATH: path.join(home, "bin") + ":" + process.env.PATH };
  const command = (action = "migrate", ...args) =>
    spawnSync(process.execPath, [service, action, ...args], {
      env,
      encoding: "utf8",
    });
  return { home, old, current, project, git, oldTree, newTree, command, env };
}

test("Migration übernimmt Daten, Token, Run-Bezüge und den registrierten Git-Worktree genau einmal", (t) => {
  const { old, current, git, newTree, command } = fixture(t);
  const result = command();
  assert.ok(
    fs.existsSync(path.join(current, "crewpip.db")),
    "Die vorhandene Datenbank muss im neuen Datenordner erscheinen: " + result.stderr,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "local-test-secret\n");
  assert.equal(fs.readFileSync(path.join(current, "backups/crewpip-2026.db"), "utf8"), "archived data");
  const db = new DatabaseSync(path.join(current, "crewpip.db"), { readOnly: true });
  assert.equal(db.prepare("SELECT text FROM messages WHERE id=8").get().text, "saved message");
  assert.equal(db.prepare("SELECT session_id FROM deliveries WHERE message_id=8").get().session_id, "s");
  const run = db.prepare("SELECT cwd,log_path FROM runs WHERE id=4").get();
  assert.equal(run.cwd, newTree);
  assert.equal(fs.readFileSync(run.log_path, "utf8"), "example run\n");
  assert.equal(db.prepare("SELECT worktree_path FROM tasks").get().worktree_path, newTree);
  assert.equal(db.prepare("SELECT cwd FROM sessions").get().cwd, newTree);
  assert.equal(git(newTree, "branch", "--show-current"), "crewpip/task");
  assert.equal(fs.readFileSync(path.join(newTree, "untracked"), "utf8"), "keep");
  db.close();
  assert.equal(command().status, 0);
});

test("Aktive Läufe und widersprüchliche Zielbestände verhindern Änderungen", (t) => {
  const { old, current, command } = fixture(t);
  const db = new DatabaseSync(path.join(old, legacyName + ".db"));
  db.exec("UPDATE runs SET status='running'");
  assert.notEqual(command().status, 0);
  assert.equal(fs.existsSync(current), false);
  db.exec("UPDATE runs SET status='done'");
  db.close();
  fs.mkdirSync(current);
  fs.writeFileSync(path.join(current, "token"), "other installation");
  assert.notEqual(command().status, 0);
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "other installation");
  assert.ok(fs.existsSync(path.join(old, legacyName + ".db")));
});

function clientConfigs(home) {
  const server = {
    type: "http",
    url: "http://127.0.0.1:7357/mcp/claude?app=claude",
    headers: { ["x-" + legacyName + "-token"]: "local-test-secret" },
  };
  const prefix = '{\n  "unrelated"   :  { "counter": 9 },\n  "mcpServers": {\n    ';
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    prefix + JSON.stringify(legacyName) + ": " + JSON.stringify(server) + "\n  }\n}\n",
    { mode: 0o600 },
  );
  const target = "/previous/checkout/apps/hook/" + legacyName + "-hook.mjs";
  for (const [app, file] of [
    ["claude", ".claude/settings.json"],
    ["codex", ".codex/hooks.json"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    const command = "/path/to/node " + target + " " + app + " prompt";
    fs.writeFileSync(
      path.join(home, file),
      JSON.stringify(
        {
          retain: " x ",
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", command, timeout: 5 }] },
              { hooks: [{ type: "command", command: "true" }] },
            ],
          },
        },
        null,
        2,
      ),
    );
  }
  const unrelated = "# Keep this unrelated table (including whitespace).\n[feature]\nflag   = true # preferred\n";
  fs.writeFileSync(
    path.join(home, ".codex/config.toml"),
    unrelated +
      '\n[ mcp_servers."' +
      legacyName +
      '" ] # keep this comment\nurl = "http://127.0.0.1:7357/mcp/codex?app=codex"\n[ mcp_servers."' +
      legacyName +
      '".http_headers ]\n"x-' +
      legacyName +
      '-token" = "local-test-secret"  # private\n',
  );
  fs.writeFileSync(
    path.join(home, ".claude/settings.local.json"),
    '{"mcpServers":{' + JSON.stringify(legacyName) + ":{}}}",
  );
  return { prefix, unrelated };
}

test("Vier globale Dateien werden punktgenau gesichert und umgestellt, fremde Bereiche bleiben bytegleich", (t) => {
  const { home, project, old, current, command } = fixture(t);
  const { prefix, unrelated } = clientConfigs(home);
  const foreign = fs.readFileSync(path.join(home, ".claude/settings.local.json"), "utf8");
  fs.writeFileSync(path.join(project, ".mcp.json"), foreign);
  const files = [".claude.json", ".codex/config.toml", ".claude/settings.json", ".codex/hooks.json"];
  const originals = files.map((f) => fs.readFileSync(path.join(home, f), "utf8"));
  const check = command("migrate", "--check");
  assert.equal(check.status, 0, check.stderr);
  assert.ok(check.stdout.includes("4 Konfigurationsdateien"));
  assert.ok(fs.existsSync(old));
  assert.ok(!fs.existsSync(current));
  assert.deepEqual(
    files.map((f) => fs.readFileSync(path.join(home, f), "utf8")),
    originals,
  );
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("local-test-secret"));
  const mcp = fs.readFileSync(path.join(home, files[0]), "utf8");
  assert.ok(mcp.startsWith(prefix));
  assert.ok(JSON.parse(mcp).mcpServers.crewpip.headers["x-crewpip-token"]);
  const toml = fs.readFileSync(path.join(home, files[1]), "utf8");
  assert.ok(toml.startsWith(unrelated));
  assert.ok(toml.includes("# keep this comment"));
  assert.ok(toml.includes("  # private"));
  for (const file of files.slice(2)) {
    const hooks = JSON.parse(fs.readFileSync(path.join(home, file))).hooks.UserPromptSubmit;
    assert.equal(hooks.length, 2);
    assert.equal(hooks[1].hooks[0].command, "true");
    assert.ok(hooks[0].hooks[0].command.startsWith("/path/to/node "));
    assert.ok(hooks[0].hooks[0].command.includes("/apps/hook/crewpip-hook.mjs"));
  }
  assert.equal(fs.readFileSync(path.join(home, ".claude/settings.local.json"), "utf8"), foreign);
  assert.equal(fs.readFileSync(path.join(project, ".mcp.json"), "utf8"), foreign);
  const backupRoot = path.join(home, ".crewpip-migration-backups");
  const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
  const journal = JSON.parse(fs.readFileSync(path.join(backup, "migration.json")));
  for (const change of journal.changes)
    assert.equal(
      fs.readFileSync(change.saved, "utf8"),
      originals[files.indexOf(path.relative(home, change.file))],
    );
});

test("Konfigurationsbestand ohne Datenordner behält das vereinbarte lokale Token", (t) => {
  const { home, old, current, command } = fixture(t);
  fs.rmSync(old, { recursive: true });
  clientConfigs(home);
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "local-test-secret\n");
  assert.equal(command().status, 0);
});

for (const layout of ["Claude-JSON", "Codex-Inlinetabelle", "Codex-Headertabelle"]) {
  test(`Tokenheader mit gemischter Großschreibung (${layout}) liefert das ursprüngliche Token genau einmal`, (t) => {
    const { home, old, current, command } = fixture(t);
    fs.rmSync(old, { recursive: true });
    const claude = layout === "Claude-JSON";
    const file = path.join(home, claude ? ".claude.json" : ".codex/config.toml");
    const legacyHeader = "X-" + legacyName.toUpperCase() + "-Token";
    const token = "fixture-header-source";
    const headers = {
      [legacyHeader]: token,
      [legacyHeader.toLowerCase()]: token,
      "X-CrewPiP-TOKEN": token,
      Other: "comma, hash# keep",
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (claude) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          mcpServers: { [legacyName]: { url: "http://localhost:7357/mcp/claude", headers } },
          other: 17,
        }),
      );
    } else {
      const fields = Object.entries(headers).map(([key, value]) => `"${key}" = "${value}"`);
      const prefix = `[mcp_servers.${legacyName}]`;
      const setting =
        layout === "Codex-Inlinetabelle"
          ? "http_headers = { " + fields.join(", ") + " } # retained"
          : `[mcp_servers.${legacyName}.http_headers] # retained\n` + fields.join("\n");
      fs.writeFileSync(file, `${prefix}\nurl = "http://localhost:7357/mcp/codex"\n${setting}\n[other]\nn = 17\n`);
    }
    const result = command();
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(file, "utf8");
    const actual = claude
      ? JSON.parse(text).mcpServers.crewpip.headers
      : parseToml(text).mcp_servers.crewpip.http_headers;
    assert.deepEqual({ ...actual }, { Other: headers.Other, "x-crewpip-token": token });
    assert.equal(fs.readFileSync(path.join(current, "token"), "utf8").trim(), token);
    if (claude) assert.equal(JSON.parse(text).other, 17);
    else {
      assert.match(text, /# retained/);
      assert.ok(text.includes("[other]\nn = 17\n"));
    }
    assert.equal(command().status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  });
}

test("Tokenheader mit gemischter Großschreibung und abweichendem JSON- oder TOML-Wert stoppt vor der Migration", (t) => {
  const { home, old, current, command } = fixture(t);
  clientConfigs(home);
  const mixed = "X-" + legacyName.toUpperCase() + "-TOKEN";
  for (const file of [path.join(home, ".claude.json"), path.join(home, ".codex/config.toml")]) {
    const before = fs.readFileSync(file, "utf8");
    const conflict = before
      .replace("x-" + legacyName + "-token", mixed)
      .replace("local-test-secret", "conflicting-fixture");
    fs.writeFileSync(file, conflict);
    const result = command("migrate", "--check");
    assert.notEqual(result.status, 0, "Abweichendes Clienttoken wurde akzeptiert");
    assert.ok(!result.stderr.includes("conflicting-fixture"));
    assert.equal(fs.readFileSync(file, "utf8"), conflict);
    assert.ok(fs.existsSync(old));
    assert.ok(!fs.existsSync(current));
    fs.writeFileSync(file, before);
  }
});

test("Alleiniger alter Tokenheader im bereits umbenannten Server wird wiederhergestellt", (t) => {
  const { home, old, current, command } = fixture(t);
  fs.rmSync(old, { recursive: true });
  const header = "X-" + legacyName.toUpperCase() + "-TOKEN";
  const server = { url: "http://localhost:7357/mcp/claude", headers: { [header]: "fixture-only" } };
  const file = path.join(home, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { crewpip: server } }));
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).mcpServers.crewpip.headers, {
    "x-crewpip-token": "fixture-only",
  });
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8").trim(), "fixture-only");
});

test("Ein abweichender Tokenheader im bereits eingerichteten zweiten Client stoppt den Umzug", (t) => {
  const { old, current, home, command } = fixture(t);
  clientConfigs(home);
  fs.rmSync(old, { recursive: true });
  const file = path.join(home, ".claude.json");
  const currentServer = {
    url: "http://localhost:7357/mcp/claude",
    headers: { "X-CrewPip-Token": "different-fixture" },
  };
  const initial = JSON.stringify({ mcpServers: { crewpip: currentServer } });
  fs.writeFileSync(file, initial);
  const result = command("migrate", "--check");
  assert.notEqual(result.status, 0, "Token eines bereits umbenannten Clients wurde übergangen");
  assert.ok(!result.stderr.includes("different-fixture"));
  assert.equal(fs.readFileSync(file, "utf8"), initial);
  assert.ok(!fs.existsSync(current));
});

test("HTTP-Randleerzeichen im bestehenden Claude-Header ergeben dasselbe Token wie Codex und die Tokendatei", (t) => {
  const { home, current, command } = fixture(t);
  clientConfigs(home);
  const file = path.join(home, ".claude.json");
  const server = {
    url: "http://localhost:7357/mcp/claude",
    headers: { "X-CrewPip-Token": " \tlocal-test-secret\t " },
  };
  const original = JSON.stringify({ mcpServers: { crewpip: server } });
  fs.writeFileSync(file, original);

  const check = command("migrate", "--check");
  assert.equal(check.status, 0, check.stderr);
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "local-test-secret\n");
});

test("Konfigurierter Tokenheader aus der Umgebung behält den Variablennamen und überprüft seinen Wert", (t) => {
  const { env, home, old, current, command } = fixture(t);
  fs.rmSync(old, { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"));
  const file = path.join(home, ".codex/config.toml");
  const header = "X-" + legacyName.toUpperCase() + "-TOKEN";
  const text = `[mcp_servers.${legacyName}]\nurl = "http://localhost:7357/mcp/codex"\nenv_http_headers = { "${header}" = "CREWPIP_TEST_TOKEN" }\n`;
  fs.writeFileSync(file, text);
  const missing = command("migrate", "--check");
  assert.notEqual(missing.status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  env.CREWPIP_TEST_TOKEN = " \tfixture-from-env\t ";
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    parseToml(fs.readFileSync(file, "utf8")).mcp_servers.crewpip.env_http_headers["x-crewpip-token"],
    "CREWPIP_TEST_TOKEN",
  );
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "fixture-from-env\n");
});

function builtServiceFixture(home) {
  const repo = path.join(home, "service-fixture");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps/daemon/dist"), { recursive: true });
  fs.writeFileSync(path.join(repo, "apps/daemon/dist/index.js"), "");
  for (const name of [
    "service.mjs",
    "service-runtime.mjs",
    "migration.mjs",
    "migrate-config.mjs",
    "swap-config.py",
  ]) {
    fs.copyFileSync(path.join(path.dirname(service), name), path.join(repo, "scripts", name));
  }
  fs.symlinkSync(path.resolve(path.dirname(service), "../node_modules"), path.join(repo, "node_modules"));
  return repo;
}

// Der Testprozess erbt ausschließlich die angegebene Fixture-Umgebung. Im
// selben Prozess laufen der echte MCP-Endpunkt und die Anfrage aus dem Client-Eintrag.
function checkMcp(home, app, childEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./mcp-initialize.mjs", import.meta.url)), app],
    {
      cwd: path.resolve(path.dirname(service), "../apps/daemon"),
      env: { ...childEnv, HOME: home, TMPDIR: path.dirname(home), PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function configuredLaunchAgent(home, env, environment) {
  const repo = builtServiceFixture(home);
  const command = (action = "migrate", ...args) =>
    spawnSync(process.execPath, [path.join(repo, "scripts/service.mjs"), action, ...args], {
      env,
      encoding: "utf8",
    });
  const agents = path.join(home, "Library/LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(
    path.join(home, "bin/launchctl"),
    '#!/bin/sh\nif [ "$1" = getenv ]; then exit 1; fi\necho "Could not find service" >&2; exit 113\n',
    { mode: 0o700 },
  );
  const oldPlist = path.join(agents, oldLabel + ".plist");
  fs.writeFileSync(
    oldPlist,
    JSON.stringify({
      Label: oldLabel,
      ProgramArguments: [process.execPath, path.join(repo, "apps/daemon/dist/index.js")],
      EnvironmentVariables: environment,
    }),
  );
  return { oldPlist, newPlist: path.join(agents, "crewpip.plist"), command };
}

for (const style of ["Header", "Bearer-Variable", "Authorization-Variable"]) {
  test(`LaunchAgent-Tokenquelle bleibt nach dem Umzug für den Codex-Runner erreichbar (${style})`, async (t) => {
    const { home, old, current, env } = fixture(t);
    const previous = legacyName.toUpperCase() + (style === "Header" ? "_TOKEN" : "_CLIENT_KEY");
    const key = style === "Header" ? "CREWPIP_TOKEN" : "CREWPIP_CLIENT_KEY";
    const value = style === "Authorization-Variable" ? "Bearer local-test-secret" : "local-test-secret";
    const { oldPlist, newPlist, command } = configuredLaunchAgent(home, env, {
      [previous]: value,
      [legacyName.toUpperCase() + "_META"]: "fixture-metadata",
    });
    const file = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(file));
    const section = "[mcp_servers." + legacyName + "]";
    const own =
      style === "Header"
        ? "env_http_headers = { 'X-" +
          legacyName +
          "-Token' = '" +
          previous +
          "', 'X-Unrelated' = 'PRIVATE_OTHER', 'X.Meta' = '" +
          legacyName.toUpperCase() +
          "_META' }"
        : style === "Bearer-Variable"
          ? "bearer_token_env_var = '" + previous + "'"
          : section.replace("]", ".env_http_headers]") + "\nAuthorization = '" + previous + "'";
    const privateSource = style === "Header" ? "PRIVATE_OTHER_KEY" : legacyName.toUpperCase() + "_EXTERNAL";
    const foreign = "[mcp_servers.other.env_http_headers]\nAuthorization = '" + privateSource + "' # unrelated\n";
    fs.writeFileSync(file, section + '\nurl="http://localhost:7357/mcp/codex"\n' + own + " # keep\n" + foreign);
    // Eine Migration aus der Shell kann die Quelle kennen. Der gestartete Runner
    // erhält danach ausschließlich die endgültige Plist.
    if (style === "Header") env[previous] = value;
    await t.test("Konflikt vor der ersten Änderung", () => {
      const before = fs.readFileSync(file, "utf8");
      env[key] = "conflicting-fixture";
      const conflict = command("migrate", "--check");
      assert.notEqual(conflict.status, 0, "Abweichende künftige Clientquelle wurde akzeptiert");
      assert.equal(fs.readFileSync(file, "utf8"), before);
      assert.ok(fs.existsSync(oldPlist) && fs.existsSync(old) && !fs.existsSync(current));
    });
    delete env[key];
    const result = command();
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.endsWith(foreign));
    const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", newPlist]));
    checkMcp(home, "codex", plist.EnvironmentVariables);
    const server = parseToml(text).mcp_servers.crewpip;
    assert.equal(
      style === "Bearer-Variable"
        ? server.bearer_token_env_var
        : server.env_http_headers[style === "Header" ? "x-crewpip-token" : "Authorization"],
      key,
    );
    if (style === "Header") {
      assert.equal(server.env_http_headers["X-Unrelated"], "PRIVATE_OTHER");
      assert.equal(server.env_http_headers["X.Meta"], "CREWPIP_META");
    }
    assert.equal(command().status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  });
}

for (const field of ["env_http_headers", "bearer_token_env_var"]) {
  test(`Fremder Codex-MCP behält seine geerbte LaunchAgent-Variable (${field})`, async (t) => {
    const { home, old, current, env } = fixture(t);
    const source = legacyName.toUpperCase() + "_AUXILIARY";
    const value = "fixture-private-credential";
    const privateSource = "PRIVATE_AUXILIARY";
    const { oldPlist, newPlist, command } = configuredLaunchAgent(home, env, {
      [source]: value,
      [privateSource]: value,
    });
    const originalPlist = fs.readFileSync(oldPlist);
    const api = http.createServer((req, res) => {
      const valid = req.headers.authorization === "Bearer " + value || req.headers["x-test"] === value;
      res.writeHead(valid ? 200 : 401).end();
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    t.after(() => api.close());
    const url = "http://127.0.0.1:" + api.address().port + "/mcp/private-fixture-route";
    const toml = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(toml));
    const escaped = "\\u" + source.charCodeAt(0).toString(16).padStart(4, "0") + source.slice(1);
    const ref = field === "env_http_headers" ? `{ "X-Test" = "${source}" }` : `"${escaped}"`;
    const config = `[mcp_servers.companion]\nurl = "${url}"\n${field} = ${ref}\n`;
    fs.writeFileSync(toml, config);
    async function accessStatus() {
      const plist = fs.existsSync(oldPlist) ? oldPlist : newPlist;
      const childEnv = JSON.parse(
        execFileSync("plutil", ["-convert", "json", "-o", "-", plist]),
      ).EnvironmentVariables;
      const foreign = parseToml(fs.readFileSync(toml, "utf8")).mcp_servers.companion;
      const bearer = childEnv[foreign.bearer_token_env_var];
      const token = childEnv[foreign.env_http_headers?.["X-Test"]];
      const headers = new Headers();
      if (bearer) headers.set("Authorization", "Bearer " + bearer);
      if (token) headers.set("X-Test", token);
      return (await fetch(foreign.url, { headers })).status;
    }
    assert.equal(await accessStatus(), 200);
    for (const flags of [["--check"], []]) {
      await t.test(flags.length ? "Vorprüfung" : "Umzug", async () => {
        const result = command("migrate", ...flags);
        assert.equal(await accessStatus(), 200, "Der fremde Dienst verweigert nach der Migration den Zugriff");
        assert.notEqual(result.status, 0, "Die fremde Abhängigkeit wurde freigegeben");
        assert.match(result.stderr, /config\.toml:1/);
        assert.ok(result.stderr.includes(field));
        for (const secret of [url, value]) assert.ok(!(result.stdout + result.stderr).includes(secret));
        assert.equal(fs.readFileSync(toml, "utf8"), config);
        assert.deepEqual(fs.readFileSync(oldPlist), originalPlist);
        assert.ok(fs.existsSync(old) && !fs.existsSync(current) && !fs.existsSync(newPlist));
        assert.ok(!fs.existsSync(path.join(home, ".crewpip-migration-backups")));
      });
    }
    // Simuliert die Klärung durch den Eigentümer des anderen MCP.
    const independent = config.replace(
      ref,
      field === "env_http_headers" ? `{ "X-Test" = "${privateSource}" }` : `"${privateSource}"`,
    );
    fs.writeFileSync(toml, independent);
    assert.equal(await accessStatus(), 200);
    const resumed = command();
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(fs.readFileSync(toml, "utf8"), independent);
    assert.ok(fs.existsSync(newPlist) && !fs.existsSync(oldPlist));
    assert.equal(await accessStatus(), 200);
  });
}

for (const app of ["claude", "codex"]) {
  test(`Statischer Bearer-Zugang ohne Datenordner übersteht den ersten Dienststart (${app})`, (t) => {
    const { home, old, current, command } = fixture(t);
    fs.rmSync(old, { recursive: true });
    const url = "http://localhost:7357/mcp/" + app;
    const auth = " bEaReR  fixture-from-bearer  ";
    if (app === "claude") {
      fs.writeFileSync(
        path.join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { [legacyName]: { url, headers: { aUtHoRiZaTiOn: auth, Other: "retain" } } },
        }),
      );
    } else {
      fs.mkdirSync(path.join(home, ".codex"));
      fs.writeFileSync(
        path.join(home, ".codex/config.toml"),
        `[mcp_servers.${legacyName}]\nurl = "${url}"\nhttp_headers = { AUTHORIZATION = "${auth}", Other = "retain" }\n`,
      );
    }
    const result = command();
    assert.equal(result.status, 0, result.stderr);
    checkMcp(home, app);
    assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "fixture-from-bearer\n");
    assert.equal(command().status, 0);
  });
}

test("Der Produkttoken hat vor weiteren Authorization-Quellen desselben Clients Vorrang", (t) => {
  const { home, old, current, command } = fixture(t);
  fs.rmSync(old, { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"));
  const file = path.join(home, ".codex/config.toml");
  const foreign =
    "[mcp_servers.other]\nurl = 'https://example.invalid/mcp/codex'\nbearer_token_env_var = 'FOREIGN_SECRET'\n";
  fs.writeFileSync(
    file,
    `[mcp_servers.${legacyName}]\nurl = 'http://localhost:7357/mcp/codex'\nhttp_headers = { 'x-${legacyName}-token' = 'fixture-primary', Authorization = 'Basic unused' }\nbearer_token_env_var = 'PRIVATE_UNUSED'\n` +
      foreign,
  );
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "fixture-primary\n");
  assert.ok(fs.readFileSync(file, "utf8").endsWith(foreign));
  checkMcp(home, "codex", { PRIVATE_UNUSED: "ignored-fixture" });
});

test("Externe Bearer-Variable behält ihren Namen und muss zum lokalen Token passen", (t) => {
  const { home, old, current, env, command } = fixture(t);
  fs.mkdirSync(path.join(home, ".codex"));
  const file = path.join(home, ".codex/config.toml");
  const text = `[mcp_servers.${legacyName}]\nurl='http://localhost:7357/mcp/codex'\nbearer_token_env_var = 'PRIVATE_BOARD_ACCESS' # keep\n`;
  fs.writeFileSync(file, text);
  env.PRIVATE_BOARD_ACCESS = "different-fixture";
  const conflict = command("migrate", "--check");
  assert.notEqual(conflict.status, 0);
  assert.ok(!conflict.stderr.includes(env.PRIVATE_BOARD_ACCESS));
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.ok(fs.existsSync(old) && !fs.existsSync(current));
  env.PRIVATE_BOARD_ACCESS = "local-test-secret";
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), text.replace(legacyName, "crewpip"));
  checkMcp(home, "codex", { PRIVATE_BOARD_ACCESS: env.PRIVATE_BOARD_ACCESS });
});

test("Übernimmt bestätigte Transaktionen aus offenem WAL und prüft die unabhängige Sicherung", (t) => {
  const { home, old, current, command } = fixture(t);
  const file = path.join(old, legacyName + ".db");
  const interrupted = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]); db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO messages VALUES(19,'wal-only')");
    process.kill(process.pid,'SIGKILL');
  `,
    file,
  ]);
  assert.equal(interrupted.signal, "SIGKILL");
  assert.ok(fs.statSync(file + "-wal").size > 0);
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  const backupRoot = path.join(home, ".crewpip-migration-backups");
  const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0], "data", legacyName + ".db");
  for (const f of [path.join(current, "crewpip.db"), backup]) {
    const db = new DatabaseSync(f, { readOnly: true });
    assert.equal(db.prepare("SELECT text FROM messages WHERE id=19").get().text, "wal-only");
    db.close();
  }
});

test("Ein Konflikt zwischen MCP-Einträgen verändert weder Konfiguration noch Datenbank", (t) => {
  const { home, old, current, command } = fixture(t);
  clientConfigs(home);
  const p = path.join(home, ".claude.json");
  const doc = JSON.parse(fs.readFileSync(p));
  doc.mcpServers.crewpip = { url: "http://127.0.0.1:9000/mcp/claude" };
  const text = JSON.stringify(doc);
  fs.writeFileSync(p, text);
  const result = command();
  assert.notEqual(result.status, 0);
  assert.ok(!result.stderr.includes("local-test-secret"));
  assert.ok(fs.existsSync(old));
  assert.ok(!fs.existsSync(current));
  assert.equal(fs.readFileSync(p, "utf8"), text);
});

test("Ein fehlgeschlagener neuer Login-Dienst stellt Dateien und echte Worktrees ohne Start des falschen Builds wieder her", (t) => {
  const { home, git, project, old, current } = fixture(t);
  clientConfigs(home);
  const agents = path.join(home, "Library/LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const previous = oldLabel;
  const repo = builtServiceFixture(home);
  const plist = path.join(agents, previous + ".plist");
  const xml = execFileSync("plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
    input: JSON.stringify({
      Label: previous,
      ProgramArguments: [process.execPath, path.join(repo, "apps/daemon/dist/index.js")],
      WorkingDirectory: repo,
      RunAtLoad: true,
      KeepAlive: true,
      EnvironmentVariables: { [legacyName.toUpperCase() + "_DB"]: path.join(old, legacyName + ".db") },
    }),
  });
  fs.writeFileSync(plist, xml);
  fs.writeFileSync(path.join(home, "bin/ps"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  fs.writeFileSync(path.join(home, "loaded"), "1");
  fs.writeFileSync(
    path.join(home, "bin/launchctl"),
    `#!/bin/sh
case "$1" in
  print) if [ "$2" = "gui/$(id -u)/${previous}" ] && [ -f "$HOME/loaded" ]; then echo "pid = 2012345678"; exit 0; fi; echo 'Could not find service' >&2; exit 113;;
  getenv) exit 1;;
  bootout) rm "$HOME/loaded"; exit 0;;
  bootstrap) echo "$3" >> "$HOME/starts"; exit 1;;
esac
exit 92
`,
    { mode: 0o700 },
  );
  const config = fs.readFileSync(path.join(home, ".claude.json"));
  const result = spawnSync(process.execPath, [path.join(repo, "scripts/service.mjs"), "migrate"], {
    env: { HOME: home, PATH: path.join(home, "bin") + ":" + process.env.PATH },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Altdienst kontrolliert gestoppt/);
  assert.deepEqual(fs.readFileSync(plist), xml);
  assert.deepEqual(fs.readFileSync(path.join(home, ".claude.json")), config);
  assert.ok(fs.existsSync(old));
  assert.ok(!fs.existsSync(current));
  assert.equal(
    git(path.join(project, "." + legacyName, "worktrees/task"), "branch", "--show-current"),
    legacyName + "/task",
  );
  assert.equal(fs.readFileSync(path.join(home, "starts"), "utf8").trim(), path.join(agents, "crewpip.plist"));
});

test("Blockiert offene SQLite-Besitzer und jede vorbestehende Ziel-Sidecardatei beim Vorabcheck", (t) => {
  const { old, current, command } = fixture(t);
  const db = new DatabaseSync(path.join(old, legacyName + ".db"));
  try {
    const held = command("migrate", "--check");
    assert.notEqual(held.status, 0);
    assert.match(held.stderr, /anderer Prozess/);
  } finally {
    db.close();
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const target = path.join(old, "crewpip.db" + suffix);
    fs.writeFileSync(target, "pre-existing");
    const preflight = command("migrate", "--check");
    assert.notEqual(preflight.status, 0);
    assert.match(preflight.stderr, /Sidecardatei/);
    assert.equal(fs.readFileSync(target, "utf8"), "pre-existing");
    fs.unlinkSync(target);
  }
  assert.ok(!fs.existsSync(current));
});

test("Erhält ACL-Regelwirkung, Moderator-Matcher und Inline-TOML mitsamt Codex-Tool-Overrides", (t) => {
  const { home, command } = fixture(t);
  clientConfigs(home);
  const file = path.join(home, ".claude/settings.json");
  const doc = JSON.parse(fs.readFileSync(file));
  const original = doc.hooks.UserPromptSubmit[0].hooks[0];
  const target = path.resolve(path.dirname(service), "../apps/hook/crewpip-hook.mjs");
  doc.hooks.UserPromptSubmit[0] = {
    matcher: "only-this-matcher",
    hooks: [
      original,
      { ...original, command: "/path/to/node " + target + " claude prompt" },
      { command: "unrelated" },
    ],
  };
  const old = "mcp__" + legacyName;
  doc.permissions = {
    allow: [old + "__list_sessions", "Read"],
    deny: [old + "__post_message"],
    ask: [old + "__read_inbox"],
  };
  fs.writeFileSync(file, JSON.stringify(doc));
  const tomlFile = path.join(home, ".codex/config.toml");
  fs.writeFileSync(
    tomlFile,
    "[mcp_servers." +
      legacyName +
      ']\nurl="http://localhost:7357/mcp/codex"\nhttp_headers = { "x-' +
      legacyName +
      '-token" = "local-test-secret" } # inline\n[mcp_servers.' +
      legacyName +
      '.tools.post_message]\napproval_mode = "prompt"\n',
  );
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  const after = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(after.permissions, {
    allow: ["mcp__crewpip__list_sessions", "Read"],
    deny: ["mcp__crewpip__post_message"],
    ask: ["mcp__crewpip__read_inbox"],
  });
  assert.equal(after.hooks.UserPromptSubmit[0].matcher, "only-this-matcher");
  assert.deepEqual(
    after.hooks.UserPromptSubmit[0].hooks.map((h) => h.command),
    ["/path/to/node " + target + " claude prompt", "unrelated"],
  );
  const text = fs.readFileSync(tomlFile, "utf8");
  assert.ok(text.includes('http_headers = { "x-crewpip-token"'));
  assert.ok(text.includes("} # inline"));
  assert.ok(text.includes('[mcp_servers.crewpip.tools.post_message]\napproval_mode = "prompt"'));
});

test("Bei konkurrierenden alten und neuen Freigaberegeln wird vor jeder Änderung abgebrochen", (t) => {
  const { home, old, command } = fixture(t);
  clientConfigs(home);
  const file = path.join(home, ".claude/settings.json");
  const doc = JSON.parse(fs.readFileSync(file));
  doc.permissions = { allow: ["mcp__" + legacyName + "__post_message"], deny: ["mcp__crewpip__post_message"] };
  fs.writeFileSync(file, JSON.stringify(doc));
  const result = command("migrate", "--check");
  assert.notEqual(result.status, 0);
  assert.ok(fs.existsSync(old));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), doc);
});

test("Ungeeignete effektive Dienstvariablen werden vor dem Start abgewiesen", (t) => {
  const { home, old, command } = fixture(t);
  const agents = path.join(home, "Library/LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const name = oldLabel;
  const plist = path.join(agents, name + ".plist");
  fs.writeFileSync(
    path.join(home, "bin/launchctl"),
    '#!/bin/sh\nif [ "$1" = getenv ]; then exit 1; fi\necho "Could not find service" >&2; exit 113\n',
    { mode: 0o700 },
  );
  for (const env of [
    { CREWPIP_AUTH: "off" },
    { CREWPIP_HOST: "0.0.0.0" },
    { CREWPIP_DB: "/foreign/board.db" },
    { CREWPIP_PORT: "no-port" },
  ]) {
    fs.writeFileSync(
      plist,
      JSON.stringify({
        Label: name,
        ProgramArguments: [process.execPath, path.join(home, "apps/daemon/dist/index.js")],
        EnvironmentVariables: env,
      }),
    );
    const c = command("migrate", "--check");
    assert.notEqual(c.status, 0);
    assert.match(c.stderr, /Effektive Dienstkonfiguration/);
    assert.ok(fs.existsSync(old));
  }
});

test("Das globale lokale Token darf bei fehlender Datei keinem neuen zufälligen Token weichen", (t) => {
  const { home, old, current, command } = fixture(t);
  clientConfigs(home);
  fs.unlinkSync(path.join(old, "token"));
  const c = command();
  assert.equal(c.status, 0, c.stderr);
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "local-test-secret\n");
});

test("Die persönliche Browser-Absenderwahl übernimmt nur der erste Besuch", async () => {
  const vm = await import("node:vm");
  const source = fs.readFileSync(
    path.resolve(path.dirname(service), "../apps/web/public/migrate-storage.js"),
    "utf8",
  );
  const values = new Map([[legacyName + ".humanName", "local name"]]);
  const localStorage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  vm.runInNewContext(source, { localStorage });
  assert.equal(values.get("crewpip.humanName"), "local name");
  values.set("crewpip.humanName", "new choice");
  vm.runInNewContext(source, { localStorage });
  assert.equal(values.get("crewpip.humanName"), "new choice");
});

test("Identische CrewPip-Hooks in getrennten Gruppen desselben Matchers laufen einmal", (t) => {
  const { home, command } = fixture(t);
  const file = path.join(home, ".codex/hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const newHook = {
    type: "command",
    command: "node " + path.resolve(path.dirname(service), "../apps/hook/crewpip-hook.mjs") + " codex stop",
    timeout: 5,
  };
  const previous = { ...newHook, command: "node /previous/repo/apps/hook/" + legacyName + "-hook.mjs codex stop" };
  const foreignA = { type: "command", command: "foreign-a" };
  const foreignB = { type: "command", command: "foreign-b" };
  fs.writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        Stop: [
          { matcher: "A", hooks: [previous, foreignA] },
          { matcher: "A", hooks: [newHook] },
          { matcher: "B", hooks: [newHook] },
          { matcher: "A", hooks: [foreignA, foreignB] },
        ],
      },
    }),
  );
  const migrated = command();
  assert.equal(migrated.status, 0, migrated.stderr);
  const actual = JSON.parse(fs.readFileSync(file)).hooks.Stop;
  assert.equal(
    actual
      .filter((g) => g.matcher === "A")
      .flatMap((g) => g.hooks)
      .filter((h) => h.command === newHook.command).length,
    1,
  );
  assert.deepEqual(actual, [
    { matcher: "A", hooks: [newHook, foreignA] },
    { matcher: "B", hooks: [newHook] },
    { matcher: "A", hooks: [foreignA, foreignB] },
  ]);
});

for (const form of ["Symlink", "Nicht-BMP"]) {
  test("Offener Worktree bleibt am Ort bei " + form + " im Sitzungs-CWD", (t) => {
    const projectName = form === "Nicht-BMP" ? "project-📂" : "project";
    const { home, old, current, git, oldTree, newTree, command } = fixture(t, projectName);
    const nested = path.join(oldTree, "nested");
    fs.mkdirSync(nested);
    let cwd = nested;
    if (form === "Symlink") {
      const alias = path.join(home, "alias");
      fs.symlinkSync(oldTree, alias, "dir");
      cwd = path.join(alias, "nested");
    }
    const db = new DatabaseSync(path.join(old, legacyName + ".db"));
    db.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
    db.prepare("UPDATE sessions SET cwd=? WHERE id='s'").run(cwd);
    db.close();
    for (const args of [["migrate", "--check"], ["migrate"]]) {
      const result = command(...args);
      assert.notEqual(result.status, 0, "Offener Worktree wurde zum Umzug freigegeben");
      assert.match(result.stderr, /geöffneter Chat verwendet/);
      assert.equal(git(cwd, "branch", "--show-current"), legacyName + "/task");
      assert.equal(fs.existsSync(newTree), false);
      assert.equal(fs.existsSync(current), false);
    }
  });
}

test("Historische Sitzungs- und Laufpfade unter einem Symlink werden passend zum verschobenen Worktree übernommen", (t) => {
  const { home, old, current, oldTree, newTree, command } = fixture(t, "project-📂");
  const alias = path.join(home, "alias");
  fs.symlinkSync(oldTree, alias, "dir");
  fs.mkdirSync(path.join(oldTree, "nested"));
  const oldDb = new DatabaseSync(path.join(old, legacyName + ".db"));
  oldDb.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
  oldDb.prepare("UPDATE sessions SET cwd=?,ended_at='2026-01-01' WHERE id='s'").run(path.join(alias, "nested"));
  oldDb.prepare("UPDATE runs SET cwd=? WHERE id=4").run(path.join(alias, "nested", "removed-dir"));
  const adjacent = oldTree + "-separate";
  fs.mkdirSync(adjacent);
  oldDb.prepare("INSERT INTO sessions(id,cwd) VALUES ('other',?)").run(adjacent);
  oldDb.close();
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  const db = new DatabaseSync(path.join(current, "crewpip.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT cwd FROM sessions WHERE id='s'").get().cwd, path.join(newTree, "nested"));
    assert.equal(
      db.prepare("SELECT cwd FROM runs WHERE id=4").get().cwd,
      path.join(newTree, "nested", "removed-dir"),
    );
    assert.equal(db.prepare("SELECT cwd FROM sessions WHERE id='other'").get().cwd, adjacent);
  } finally {
    db.close();
  }
});

test("Projektalias und ausgehender Symlink sperren den belegten Worktree und erhalten später den gespeicherten Unterpfad", (t) => {
  const { home, old, current, project, oldTree, newTree, command } = fixture(t);
  const projectAlias = path.join(home, "project-alias");
  const outside = path.join(home, "outside");
  fs.mkdirSync(path.join(outside, "nested"), { recursive: true });
  fs.writeFileSync(path.join(outside, "nested", "record"), "preserved");
  fs.symlinkSync(project, projectAlias, "dir");
  fs.symlinkSync(outside, path.join(oldTree, "linked"), "dir");
  const cwd = path.join(projectAlias, path.relative(project, oldTree), "linked", "nested");
  const throughLink = path.join(home, "through-worktree");
  fs.symlinkSync(cwd, throughLink, "dir");
  const dbFile = path.join(old, legacyName + ".db");
  const db = new DatabaseSync(dbFile);
  db.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
  db.prepare("UPDATE sessions SET cwd=?").run(cwd);
  db.prepare("UPDATE runs SET cwd=?").run(throughLink);
  db.close();
  assert.equal(fs.realpathSync(cwd), path.join(outside, "nested"));
  for (const args of [["migrate", "--check"], ["migrate"]]) {
    const result = command(...args);
    assert.notEqual(result.status, 0, "Belegter Worktree unter Projektalias wurde freigegeben");
    assert.match(result.stderr, /geöffneter Chat verwendet/);
    assert.equal(fs.readFileSync(path.join(cwd, "record"), "utf8"), "preserved");
    assert.ok(!fs.existsSync(current));
  }
  const ended = new DatabaseSync(dbFile);
  ended.exec("UPDATE sessions SET ended_at='2026-01-01'");
  ended.close();
  const migrated = command();
  assert.equal(migrated.status, 0, migrated.stderr);
  const newDb = new DatabaseSync(path.join(current, "crewpip.db"), { readOnly: true });
  try {
    for (const table of ["sessions", "runs"]) {
      const stored = newDb.prepare(`SELECT cwd FROM ${table}`).get().cwd;
      assert.equal(stored, path.join(newTree, "linked", "nested"));
      assert.equal(fs.readFileSync(path.join(stored, "record"), "utf8"), "preserved");
    }
  } finally {
    newDb.close();
  }
});

for (const differentTree of [false, true]) {
  test(`Historischer absoluter Symlink führt nach dem Umzug zum Ziel im ${differentTree ? "zweiten" : "selben"} Worktree`, (t) => {
    const { home, old, current, project, git, oldTree, newTree, command } = fixture(t);
    const oldTarget = differentTree ? path.join(path.dirname(oldTree), "other") : oldTree;
    const newTarget = differentTree ? path.join(path.dirname(newTree), "other") : newTree;
    const db = new DatabaseSync(path.join(old, legacyName + ".db"));
    if (differentTree) {
      const branch = legacyName + "/other";
      git(project, "worktree", "add", "-b", branch, oldTarget);
      db.prepare("INSERT INTO tasks VALUES (2,'p',?,?)").run(oldTarget, branch);
    }
    const linked = path.join(oldTarget, "nested");
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, "marker"), "same directory");
    fs.symlinkSync(linked, path.join(oldTree, "linked"), "dir");
    const alias = path.join(home, "project-alias");
    fs.symlinkSync(project, alias, "dir");
    const cwd = path.join(alias, path.relative(project, oldTree), "linked");
    assert.equal(fs.readFileSync(path.join(cwd, "marker"), "utf8"), "same directory");
    db.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
    db.prepare("UPDATE sessions SET cwd=?,ended_at='2026-01-01'").run(cwd);
    db.prepare("UPDATE runs SET cwd=?").run(cwd);
    db.close();

    const result = command();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readlinkSync(path.join(newTree, "linked")), linked);
    const after = new DatabaseSync(path.join(current, "crewpip.db"), { readOnly: true });
    try {
      for (const table of ["sessions", "runs"]) {
        const stored = after.prepare(`SELECT cwd FROM ${table}`).get().cwd;
        assert.equal(fs.readFileSync(path.join(stored, "marker"), "utf8"), "same directory");
        assert.equal(stored, path.join(newTarget, "nested"));
      }
    } finally {
      after.close();
    }
  });
}

test("Fremder zyklischer CWD sperrt offene Sitzungen und bleibt als historischer Pfad erhalten", (t) => {
  const { home, old, current, command } = fixture(t);
  const cycle = path.join(home, "cycle");
  fs.symlinkSync("cycle", cycle);
  const dbFile = path.join(old, legacyName + ".db");
  const db = new DatabaseSync(dbFile);
  db.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
  db.prepare("UPDATE sessions SET cwd=?").run(cycle);
  db.prepare("UPDATE runs SET cwd=?").run(cycle);
  db.close();
  const active = command("migrate", "--check");
  assert.notEqual(active.status, 0, "Unsicherer CWD eines offenen Chats wurde freigegeben");
  assert.ok(!fs.existsSync(current));
  const ended = new DatabaseSync(dbFile);
  ended.exec("UPDATE sessions SET ended_at='2026-01-01'");
  ended.close();
  const migrated = command();
  assert.equal(migrated.status, 0, migrated.stderr);
  const newDb = new DatabaseSync(path.join(current, "crewpip.db"), { readOnly: true });
  try {
    for (const table of ["sessions", "runs"])
      assert.equal(newDb.prepare(`SELECT cwd FROM ${table}`).get().cwd, cycle);
  } finally {
    newDb.close();
  }
});
