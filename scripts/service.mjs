#!/usr/bin/env node
/**
 * launchd-Dienst für den CrewPip-Daemon (macOS, pro Benutzer).
 *
 *   node scripts/service.mjs install    schreibt ~/Library/LaunchAgents/crewpip.plist und startet
 *   node scripts/service.mjs uninstall  stoppt und entfernt den Dienst
 *   node scripts/service.mjs restart    startet neu (z. B. nach pnpm build)
 *   node scripts/service.mjs status     zeigt launchd-Zustand und Health-Endpunkt
 *
 * KeepAlive sorgt dafür, dass launchd den Daemon nach einem Absturz neu startet; RunAtLoad
 * startet ihn nach dem Login. Logs liegen unter ~/.crewpip/daemon.log.
 */
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { daemonEntry, serviceRuntime } from "./service-runtime.mjs";

const LABEL = "crewpip";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = daemonEntry(repoRoot);
const home = os.homedir();
const plistPath = path.join(home, "Library/LaunchAgents", `${LABEL}.plist`);
const dataDir = path.join(home, ".crewpip");
const logPath = path.join(dataDir, "daemon.log");
function installedConfiguration() {
  if (!fs.existsSync(plistPath) || process.argv[2] === "migrate") return null;
  const configuration = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (configuration.Label !== LABEL) throw new Error("Fremde LaunchAgent-Konfiguration");
  return configuration;
}
const installed = installedConfiguration();
const serviceEnv = installed ? (installed.EnvironmentVariables ?? {}) : process.env;
const port = serviceEnv.CREWPIP_PORT ?? "7357";
const domain = `gui/${process.getuid()}`;

function plist() {
  const runtime = serviceRuntime(repoRoot);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(runtime.args[0])}</string>
    <string>${esc(runtime.args[1])}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(runtime.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CREWPIP_PORT</key><string>${esc(port)}</string>
    <key>CREWPIP_DB</key><string>${esc(path.join(dataDir, "crewpip.db"))}</string>
    <key>PATH</key><string>${esc(runtime.searchPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

async function bootout() {
  const r = launchctl("bootout", `${domain}/${LABEL}`);
  // Exit 3 / "No such process": war nicht geladen, das ist in Ordnung.
  if (r.status !== 0 && !/No such process|Could not find/i.test(r.stderr + r.stdout)) {
    console.error(r.stderr.trim() || r.stdout.trim());
  }
  // Warten, bis der alte Prozess den Port freigegeben hat, sonst scheitert der Neustart am belegten Port.
  for (let i = 0; i < 20 && (await health()); i++) await new Promise((res) => setTimeout(res, 250));
}

function bootstrap() {
  const r = launchctl("bootstrap", domain, plistPath);
  if (r.status !== 0) {
    console.error(r.stderr.trim() || r.stdout.trim());
    process.exit(1);
  }
}

function token() {
  if (serviceEnv.CREWPIP_TOKEN) return serviceEnv.CREWPIP_TOKEN.trim();
  try {
    return fs.readFileSync(serviceEnv.CREWPIP_TOKEN_FILE ?? path.join(dataDir, "token"), "utf8").trim();
  } catch {
    return "";
  }
}

async function health() {
  try {
    const t = token();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: t ? { "x-crewpip-token": t } : {},
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitHealthy(tries = 20) {
  for (let i = 0; i < tries; i++) {
    const h = await health();
    if (h) return h;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function refreshRuntime(configuration) {
  const runtime = serviceRuntime(repoRoot, configuration);
  const changes = [
    ["ProgramArguments", configuration.ProgramArguments, runtime.args],
    ["WorkingDirectory", configuration.WorkingDirectory, runtime.workingDirectory],
    ["EnvironmentVariables.PATH", configuration.EnvironmentVariables?.PATH, runtime.searchPath],
  ].filter(([, previous, next]) => !isDeepStrictEqual(previous, next));
  if (!changes.length) return;
  const temporary = fs.mkdtempSync(path.join(path.dirname(plistPath), ".crewpip-"));
  const staged = path.join(temporary, "service.plist");
  try {
    // Die Startfelder gemeinsam austauschen, damit Interpreter, Build,
    // Arbeitsverzeichnis und Suchpfad stets zu demselben Start gehören.
    execFileSync("/bin/cp", ["-p", plistPath, staged], { stdio: "ignore" });
    for (const [key, previous, value] of changes) {
      const operation = previous === undefined ? "-insert" : "-replace";
      // ProgramArguments als Array ersetzen. Ein numerischer letzter Schlüssel
      // würde mit plutil ein Element einfügen.
      const result = spawnSync("plutil", [operation, key, "-json", JSON.stringify(value), "--", staged], {
        stdio: "ignore",
      });
      if (result.status !== 0) throw new Error("Dienst-Plist konnte nicht aktualisiert werden: " + key);
    }
    fs.renameSync(staged, plistPath);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "check-install": {
      const { requireMigratedInstallation } = await import("./migration.mjs");
      requireMigratedInstallation(repoRoot);
      break;
    }
    case "migrate": {
      const options = process.argv.slice(3).filter((arg) => arg !== "--");
      if (options.length > 1 || options.some((arg) => !["--check", "--recover"].includes(arg)))
        throw new Error("Erlaubt sind --check oder --recover");
      const { migrateInstallation } = await import("./migration.mjs");
      await migrateInstallation({
        repo: repoRoot,
        check: options.includes("--check"),
        recover: options.includes("--recover"),
      });
      break;
    }
    case "install":
    case "restart": {
      const { requireMigratedInstallation } = await import("./migration.mjs");
      requireMigratedInstallation(repoRoot);
      if (!fs.existsSync(entry)) {
        console.error(`Fehlt: ${entry}. Zuerst \`pnpm build\` ausführen.`);
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      if (!installed) {
        fs.writeFileSync(plistPath, plist(), { flag: "wx", mode: 0o600 });
      } else {
        refreshRuntime(installed);
      }
      await bootout();
      bootstrap();
      const h = await waitHealthy();
      if (!h) {
        console.error(`Dienst geladen, aber http://127.0.0.1:${port}/api/health antwortet nicht. Log: ${logPath}`);
        process.exit(1);
      }
      console.log(
        `${cmd === "install" ? "Installiert" : "Neu gestartet"}: ${LABEL} auf http://127.0.0.1:${port} (Log: ${logPath})`,
      );
      break;
    }
    case "uninstall": {
      await bootout();
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      console.log(`Entfernt: ${LABEL}. Datenbank bleibt unter ${dataDir}.`);
      break;
    }
    case "status": {
      const r = launchctl("print", `${domain}/${LABEL}`);
      const loaded = r.status === 0;
      const state = loaded ? (r.stdout.match(/state = (\w+)/)?.[1] ?? "unbekannt") : "nicht geladen";
      const pid = loaded ? (r.stdout.match(/pid = (\d+)/)?.[1] ?? "-") : "-";
      const h = await health();
      console.log(
        `launchd: ${state}${pid !== "-" ? ` (pid ${pid})` : ""}  plist: ${fs.existsSync(plistPath) ? plistPath : "fehlt"}`,
      );
      console.log(`health:  ${h ? `ok, Version ${h.version}` : "keine Antwort"} auf http://127.0.0.1:${port}`);
      process.exit(loaded && h ? 0 : 1);
    }
    default:
      console.log("Verwendung: node scripts/service.mjs install|uninstall|restart|status|migrate");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
