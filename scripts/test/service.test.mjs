import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../..", import.meta.url));

for (const [action, managed] of [
  ["install", true],
  ["install", false],
  ["restart", true],
  ["restart", false],
]) {
  test(
    action +
      " nach Node-Upgrade erhält " +
      (managed ? "den verwalteten Suchpfad des Runners" : "einen individuellen PATH"),
    async (t) => {
      const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-node-upgrade-")));
      t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
      const checkout = path.join(sandbox, "checkout");
      fs.mkdirSync(checkout);
      fs.cpSync(path.join(repo, "scripts"), path.join(checkout, "scripts"), { recursive: true });
      fs.symlinkSync(path.join(repo, "node_modules"), path.join(checkout, "node_modules"));
      const entry = path.join(checkout, "apps/daemon/dist/index.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, "");
      const bin = path.join(sandbox, "bin");
      fs.mkdirSync(bin);
      const marker = path.join(sandbox, "loaded");
      fs.writeFileSync(
        path.join(bin, "launchctl"),
        `#!/bin/sh
case "$1" in
  print) echo 'Could not find service' >&2; exit 113 ;;
  bootout) rm -f "$HOME/loaded"; exit 0 ;;
  bootstrap) touch "$HOME/loaded"; exit 0 ;;
esac
exit 1
`,
        { mode: 0o700 },
      );
      const server = http.createServer((req, res) => {
        const ok = fs.existsSync(marker) && req.headers["x-crewpip-token"] === "fixture-only";
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok }));
      });
      t.after(() => server.close());
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const env = {
        CREWPIP_PORT: String(server.address().port),
        CREWPIP_TOKEN: "fixture-only",
        APP_SETTING: "retain",
      };
      const previous = path.join(sandbox, "Cellar/node/old/bin/node");
      const next = path.join(sandbox, "Cellar/node/new/bin/node");
      fs.mkdirSync(path.dirname(next), { recursive: true });
      fs.copyFileSync(process.execPath, next, fs.constants.COPYFILE_FICLONE);
      const nextBin = path.dirname(next),
        priorBin = path.dirname(previous);
      const testCli = path.join(nextBin, "claude");
      fs.writeFileSync(testCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const command = path.join(checkout, "scripts/service.mjs");
      const serviceEnv = {
        HOME: sandbox,
        PATH: bin + ":" + process.env.PATH,
        CREWPIP_PORT: env.CREWPIP_PORT,
        CREWPIP_TOKEN: "fixture-only",
      };
      const custom = path.join(sandbox, "company tools");
      const plist = path.join(sandbox, "Library/LaunchAgents/crewpip.plist");
      let searchPath;
      if (managed) {
        fs.mkdirSync(priorBin, { recursive: true });
        fs.copyFileSync(process.execPath, previous, fs.constants.COPYFILE_FICLONE);
        await run(previous, [command, "install"], { env: serviceEnv, timeout: 15000 });
        const initial = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist]));
        assert.equal(initial.ProgramArguments[0], previous);
        searchPath = initial.EnvironmentVariables.PATH.split(":");
        assert.equal(searchPath[0], priorBin);
        searchPath.splice(1, 0, custom);
        // Eine vorhandene Referenz desselben Zielpfads darf keine Dublette erzeugen.
        if (action === "install") searchPath.push(nextBin);
        fs.rmSync(previous);
      } else {
        searchPath = [custom, priorBin, "/usr/bin"];
      }
      env.PATH = searchPath.join(":");
      const installed = {
        Label: "crewpip",
        ProgramArguments: [previous, entry, "extra argument"],
        WorkingDirectory: checkout,
        EnvironmentVariables: env,
        KeepAlive: true,
        RunAtLoad: true,
        ThrottleInterval: 12,
      };
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(
        plist,
        execFileSync("plutil", ["-convert", "binary1", "-o", "-", "--", "-"], {
          input: JSON.stringify(installed),
        }),
        { mode: 0o600 },
      );
      await run(next, [command, action], {
        env: serviceEnv,
        timeout: 15000,
      });
      const actual = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist]));
      assert.equal(actual.ProgramArguments[0], next);
      if (managed) {
        const runner = pathToFileURL(path.join(repo, "apps/daemon/src/runner/apps.ts")).href;
        const found = execFileSync(
          next,
          [
            "--input-type=module",
            "-e",
            `import {claudeApp} from ${JSON.stringify(runner)}; console.log(claudeApp.bin());`,
          ],
          { env: { HOME: sandbox, PATH: actual.EnvironmentVariables.PATH }, encoding: "utf8" },
        ).trim();
        assert.equal(found, testCli);
      }
      const expectedPath = managed
        ? [nextBin, ...searchPath.slice(1).filter((dir) => dir !== nextBin)]
        : searchPath;
      assert.deepEqual(actual, {
        ...installed,
        ProgramArguments: [next, entry, "extra argument"],
        EnvironmentVariables: { ...env, PATH: expectedPath.join(":") },
      });
      assert.equal(fs.statSync(plist).mode & 0o777, 0o600);
    },
  );
}

const standardBins = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

test("Standardverzeichnisse bleiben nach einem Node-Wechsel einmal in ihrer ursprünglichen Rangfolge", async () => {
  const { serviceRuntime, daemonEntry } = await import("../service-runtime.mjs");
  const nextBin = path.dirname(process.execPath);
  const custom = "/company tools";
  for (const previousBin of standardBins) {
    const previousPath = [...new Set([previousBin, custom, ...standardBins, "/other tools"])];
    const configuration = {
      ProgramArguments: [path.join(previousBin, "node"), daemonEntry(repo)],
      EnvironmentVariables: { PATH: previousPath.join(":") },
    };
    const expected = [...new Set([nextBin, custom, ...standardBins, "/other tools"])];
    assert.deepEqual(serviceRuntime(repo, configuration).searchPath.split(":"), expected, previousBin);
    configuration.EnvironmentVariables.PATH = [custom, previousBin, "/other tools"].join(":");
    assert.equal(serviceRuntime(repo, configuration).searchPath, configuration.EnvironmentVariables.PATH);
  }
});

const runtimeCases = [
  { action: "restart", upgrade: true, managed: true, systemNode: true },
  { action: "migrate", upgrade: true, managed: true },
  { action: "migrate", upgrade: true, managed: false },
  { action: "migrate", upgrade: false, managed: true },
  {
    action: "restart",
    upgrade: false,
    managed: true,
    sameCheckout: true,
    nodeFlags: ["--enable-source-maps"],
  },
  { action: "restart", upgrade: false, managed: true, sameCheckout: true, nodeFlags: ["--trace-gc"] },
  {
    action: "install",
    upgrade: true,
    managed: true,
    nodeFlags: ["--require", "node:util", "--conditions=fixture", "--enable-source-maps"],
  },
  ...["install", "restart"].flatMap((action) =>
    [false, true].map((upgrade) => ({ action, upgrade, managed: true })),
  ),
];

for (const { action, upgrade, managed, systemNode, sameCheckout, nodeFlags = [] } of runtimeCases) {
  const setup = systemNode
    ? "System-CLI nach Node-Wechsel"
    : sameCheckout
      ? "bestehender Checkout"
      : "Ersatzcheckout";
  test(`${nodeFlags.length ? "Node-Optionen " + nodeFlags[0] + ", " : ""}${setup} bei ${action}, ${upgrade ? "neuer" : "gleicher"} Node und ${managed ? "verwaltetem" : "individuellem"} PATH`, async (t) => {
    const { legacyName, oldLabel } = await import("../migration.mjs");
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-checkout-")));
    const pidFile = path.join(home, "fixture.pid");
    t.after(() => {
      try {
        if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
    const checkout = path.join(home, "replacement");
    const priorCheckout = sameCheckout ? checkout : path.join(home, "previous");
    const daemon = "apps/daemon/dist/index.js";
    const args = action === "migrate" && upgrade ? [] : ["--example", "extra value"];
    const newBin = path.join(home, systemNode ? ".nvm/versions/node/v22.18.0/bin" : "v2/bin");
    const oldBin = systemNode ? "/usr/bin" : upgrade ? path.join(home, "v1/bin") : newBin;
    const custom = path.join(home, "company/bin");
    for (const bin of [newBin, custom]) {
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    const node = path.join(newBin, "node");
    fs.copyFileSync(process.execPath, node, fs.constants.COPYFILE_FICLONE);
    const runner = pathToFileURL(path.join(repo, "apps/daemon/src/runner/apps.ts")).href;
    for (const root of new Set([priorCheckout, checkout])) {
      const entry = path.join(root, daemon);
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(
        entry,
        `
const http = require("node:http");
import(${JSON.stringify(runner)}).then(({ claudeApp }) => {
  const report = { entry: __filename, cwd: process.cwd(), args: process.argv.slice(2), nodeFlags: process.execArgv, node: process.execPath, cli: claudeApp.bin(), setting: process.env.APP_SETTING, path: process.env.PATH };
  http.createServer((req, res) => {
    res.writeHead(req.headers["x-crewpip-token"] === "fixture-only" ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(report));
  }).listen(Number(process.env.CREWPIP_PORT), "127.0.0.1");
});
`,
      );
    }
    fs.cpSync(path.join(repo, "scripts"), path.join(checkout, "scripts"), { recursive: true });
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(checkout, "node_modules"));
    const shimDir = path.join(home, "test-bin");
    fs.mkdirSync(shimDir);
    // launchd ist ersetzt. Der übernommene Interpreter startet den ausgewählten
    // Build tatsächlich im konfigurierten Arbeitsverzeichnis mit der Plist-Umgebung.
    const launchctl = path.join(shimDir, "launchctl");
    fs.writeFileSync(
      launchctl,
      `#!/usr/bin/python3
import os, pathlib, plistlib, subprocess, sys
pid = pathlib.Path.home() / "fixture.pid"
action = sys.argv[1]
if action == "print":
    print("Could not find service", file=sys.stderr)
    sys.exit(113)
if action == "getenv":
    sys.exit(1)
if action == "bootout":
    sys.exit(0)
if action != "bootstrap":
    sys.exit(2)
with open(sys.argv[3], "rb") as f:
    doc = plistlib.load(f)
with open(os.devnull, "r+b") as devnull:
    child = subprocess.Popen(doc["ProgramArguments"], cwd=doc["WorkingDirectory"],
        env={"HOME": str(pathlib.Path.home()), **doc["EnvironmentVariables"]},
        stdin=devnull, stdout=devnull, stderr=devnull, start_new_session=True)
pid.write_text(str(child.pid))
`,
      { mode: 0o700 },
    );

    const reservation = http.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const migration = action === "migrate";
    const label = migration ? oldLabel : "crewpip";
    const data = path.join(home, migration ? "." + legacyName : ".crewpip");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "token"), "fixture-only\n");
    const agents = path.join(home, "Library/LaunchAgents");
    const env = { HOME: home, PATH: shimDir + ":" + process.env.PATH };
    const fallbackBins = systemNode ? standardBins : ["/usr/bin"];
    const searchPath = managed
      ? [...new Set([oldBin, custom, ...fallbackBins])]
      : [custom, oldBin, ...fallbackBins];
    const expectedPath = managed ? [newBin, custom, ...fallbackBins] : searchPath;
    const systemCli = (search) =>
      execFileSync("getconf", ["ARG_MAX"], {
        env: { HOME: home, PATH: search },
        encoding: "utf8",
      }).trim();
    if (systemNode) assert.match(systemCli(searchPath.join(":")), /^\d+$/);
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(
      path.join(agents, label + ".plist"),
      execFileSync("plutil", ["-convert", "binary1", "-o", "-", "--", "-"], {
        input: JSON.stringify({
          Label: label,
          ProgramArguments: [path.join(oldBin, "node"), ...nodeFlags, path.join(priorCheckout, daemon), ...args],
          WorkingDirectory: priorCheckout,
          EnvironmentVariables: {
            [(migration ? legacyName.toUpperCase() : "CREWPIP") + "_PORT"]: String(port),
            APP_SETTING: "retain",
            PATH: searchPath.join(":"),
          },
        }),
      }),
    );
    const currentPlist = path.join(agents, "crewpip.plist");
    const previousInode = sameCheckout ? fs.statSync(currentPlist).ino : null;
    await run(node, [path.join(checkout, "scripts/service.mjs"), action], { env, timeout: 20000 });
    if (sameCheckout) assert.equal(fs.statSync(currentPlist).ino, previousInode, "Passende Plist wurde ersetzt");
    if (migration) {
      // Den übernommenen, zuvor gestoppten Dienst direkt laden. Ein zusätzliches
      // install oder restart würde einen Migrationsfehler in der Plist verdecken.
      await run(launchctl, ["bootstrap", "gui/test", path.join(agents, "crewpip.plist")], { env });
    }
    const endpoint = "http://127.0.0.1:" + port + "/api/health";
    let health;
    for (let attempt = 0; attempt < 30 && !health; attempt++) {
      health = await fetch(endpoint, { headers: { "x-crewpip-token": "fixture-only" } }).catch(() => null);
      if (!health) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health?.status, 200, "Der gestartete Test-Build muss erreichbar sein");
    const report = await health.json();
    if (systemNode) assert.match(systemCli(report.path), /^\d+$/);
    assert.equal(report.entry, path.join(checkout, daemon), "Health antwortet aus dem falschen Checkout");
    assert.equal(report.cwd, checkout);
    assert.equal(
      report.cli,
      path.join(managed ? newBin : custom, "claude"),
      "Der Runner findet die zugesagte CLI nicht",
    );
    assert.deepEqual(report, {
      entry: path.join(checkout, daemon),
      cwd: checkout,
      args,
      nodeFlags,
      node,
      cli: report.cli,
      setting: "retain",
      path: expectedPath.join(":"),
    });
  });
}

test("Node-Optionen dürfen einen fremden Einstieg oder den Optionswert eines Preloads nicht zum Daemon machen", async () => {
  const { serviceRuntime, daemonEntry } = await import("../service-runtime.mjs");
  const entry = daemonEntry("/previous");
  const standalone = { ProgramArguments: [process.execPath, "--", entry, "trailing"] };
  assert.deepEqual(serviceRuntime(repo, standalone).args, [process.execPath, "--", daemonEntry(repo), "trailing"]);
  for (const args of [
    [process.execPath, "/foreign.js", entry],
    [process.execPath, "--require", entry, "/foreign.js"],
    [process.execPath, "--require", entry],
    [process.execPath, "--check", entry],
    [process.execPath, "--unknown-option", entry],
    ["/bin/sh", "--", entry],
  ]) {
    assert.throws(() => serviceRuntime(repo, { ProgramArguments: args }), /Startkonfiguration|Startskript/);
  }
  assert.throws(() => serviceRuntime(repo, standalone, { allowNodeOptions: false }), /Startskript/);
});
