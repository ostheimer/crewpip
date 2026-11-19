// Historischer Name für das Erkennen bestehender Installationen.
export const legacyName = "mngboard";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { checkForeignEnvReferences, configChanges, installationToken, restoreConfig } from "./migrate-config.mjs";
import { daemonEntry, serviceRuntime } from "./service-runtime.mjs";

export const oldLabel = "at.ostheimer." + legacyName;
const label = "crewpip";
const oldDb = legacyName + ".db";
const newDb = "crewpip.db";
const domain = "gui/" + process.getuid();
const exists = fs.existsSync;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const mkdir = (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const read = (file) => fs.readFileSync(file, "utf8");
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ref = (cwd, name) =>
  spawnSync("git", ["-C", cwd, "show-ref", "--verify", "--quiet", "refs/heads/" + name]).status === 0;

function atomic(file, bytes, mode = 0o600) {
  mkdir(path.dirname(file));
  const temp = file + ".crewpip-" + randomUUID();
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx", mode, flush: true });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

const swapHelper = fileURLToPath(new URL("./swap-config.py", import.meta.url));
function configSwap(action, file, backup, expected, content) {
  const args = [swapHelper, action, file, backup];
  if (action === "swap") args.push(expected);
  const result = spawnSync("/usr/bin/python3", args, { input: content, encoding: "utf8" });
  if (result.status === 75) throw new Error("Konfigurationsdatei parallel geändert: " + file);
  if (result.status === 76)
    throw new Error("Gleichzeitige Änderungen vollständig aufbewahrt. Bestände abgleichen: " + backup);
  if (result.status !== 0)
    throw new Error("Dateirechte, lokalen Datenträger und Python 3 für atomaren macOS-Tausch prüfen: " + file);
}

function launch(...args) {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error("launchctl " + args[0] + " fehlgeschlagen (Status " + r.status + ")");
}

function launchState(name) {
  const r = spawnSync("launchctl", ["print", domain + "/" + name], { encoding: "utf8" });
  if (r.status === 0) return r.stdout;
  if (/Could not find service|No such process/i.test(r.stderr ?? "")) return null;
  throw new Error("Zustand des macOS-Dienstes konnte nicht ermittelt werden");
}

const loaded = (name) => launchState(name) !== null;
const sqliteSuffixes = ["", "-wal", "-shm", "-journal"];
function verifyOwners(dbfile, managedPid) {
  const files = sqliteSuffixes.map((s) => dbfile + s).filter(exists);
  if (!files.length) return;
  const r = spawnSync("lsof", ["-nP", "-Fp", "--", ...files], { encoding: "utf8", timeout: 10000 });
  if (r.error || ![0, 1].includes(r.status) || r.stderr?.trim())
    throw new Error("Offene SQLite-Dateien konnten nicht sicher geprüft werden");
  const pids = [...r.stdout.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
  if (pids.some((pid) => pid !== managedPid))
    throw new Error("Ein anderer Prozess hat Datenbank oder WAL geöffnet. Vor dem Umzug schließen.");
}

async function waitForExit(pid) {
  if (!pid) return;
  for (let i = 0; i < 40; i++) {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
    if ((r.status === 1 && !r.stderr?.trim()) || (r.status === 0 && r.stdout.trim().startsWith("Z"))) return;
    if (r.status !== 0) throw new Error("Prozessende konnte nicht sicher geprüft werden");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Der vorherige Dienstprozess läuft noch. Vor der Fortsetzung sein Ende prüfen.");
}

function getPlist(file) {
  return JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function buildPlist(file, repo, old, current) {
  const doc = getPlist(file);
  if (doc.Label !== oldLabel) throw new Error("Die bisherige Dienst-Plist enthält eine fremde Kennung");
  const runtime = serviceRuntime(repo, doc, { allowNodeOptions: false });
  doc.Label = label;
  doc.ProgramArguments = runtime.args;
  doc.WorkingDirectory = runtime.workingDirectory;
  for (const k of ["StandardOutPath", "StandardErrorPath"])
    if (doc[k]?.startsWith(old + "/")) doc[k] = current + doc[k].slice(old.length);
  const env = doc.EnvironmentVariables ?? {};
  if (runtime.searchPath !== undefined) env.PATH = runtime.searchPath;
  const renamedEnv = new Map();
  const prefix = legacyName.toUpperCase() + "_";
  if (env[prefix + "DB"] && env[prefix + "DB"] !== path.join(old, oldDb))
    throw new Error("Externen Datenbankpfad vor dem Umzug prüfen");
  if (env[prefix + "AUTH"] === "off" || (env[prefix + "HOST"] && env[prefix + "HOST"] !== "127.0.0.1"))
    throw new Error("Der Umzug setzt einen geschützten lokalen Dienst voraus");
  for (const key of Object.keys(env)) {
    if (!key.startsWith(prefix)) continue;
    const target = "CREWPIP_" + key.slice(prefix.length);
    let value = env[key];
    if (key === prefix + "DB") value = path.join(current, newDb);
    else if (value.startsWith(old + "/")) value = current + value.slice(old.length);
    if (Object.hasOwn(env, target) && env[target] !== value)
      throw new Error("Widersprüchliche Dienstvariable " + target);
    renamedEnv.set(key, target);
    env[target] = value;
    delete env[key];
  }
  // Die GUI-Domäne kann Umgebungsvariablen zusätzlich zur Plist vererben.
  // Unklare externe Vorgaben vor einem Eingriff sichtbar machen.
  for (const suffix of [
    "AUTH",
    "HOST",
    "DB",
    "PORT",
    "ALLOWED_HOSTS",
    "TOKEN",
    "TOKEN_FILE",
    "CODEX_BYPASS_HOOK_TRUST",
  ]) {
    for (const key of [prefix + suffix, "CREWPIP_" + suffix]) {
      const r = spawnSync("launchctl", ["getenv", key], { encoding: "utf8" });
      if (r.error || ![0, 1].includes(r.status)) throw new Error("launchd-Umgebung nicht prüfbar");
      if (r.stdout.trim()) throw new Error("Externe launchd-Vorgabe prüfen: " + key);
    }
  }
  const port = Number(env.CREWPIP_PORT ?? 7357);
  if (
    (env.CREWPIP_AUTH && env.CREWPIP_AUTH !== "on") ||
    (env.CREWPIP_HOST && env.CREWPIP_HOST !== "127.0.0.1") ||
    env.CREWPIP_ALLOWED_HOSTS ||
    (env.CREWPIP_DB && env.CREWPIP_DB !== path.join(current, newDb)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    env.CREWPIP_CODEX_BYPASS_HOOK_TRUST === "1"
  ) {
    throw new Error("Effektive Dienstkonfiguration nicht sicher lokal oder widersprüchlich");
  }
  let configuredToken = env.CREWPIP_TOKEN?.trim();
  if (!configuredToken && env.CREWPIP_TOKEN_FILE) {
    const source = env.CREWPIP_TOKEN_FILE.startsWith(current + "/")
      ? old + env.CREWPIP_TOKEN_FILE.slice(current.length)
      : env.CREWPIP_TOKEN_FILE;
    if (!path.isAbsolute(source) || !fs.lstatSync(source).isFile())
      throw new Error("Abweichende Tokendatei prüfen");
    configuredToken = read(source).trim();
    if (!configuredToken) throw new Error("Konfigurierte Tokendatei ist leer");
  }
  // Runner-Kindprozesse erben die ausdrücklich vereinbarte Tokenquelle.
  // Dateibasierte Zugänge verwenden die zusammen mit den Daten gesicherte Datei.
  if (env.CREWPIP_TOKEN_FILE) env.CREWPIP_TOKEN_FILE = path.join(current, "token");
  doc.EnvironmentVariables = env;
  return {
    tokenFile: path.join(current, "token"),
    configuredToken,
    renamedEnv,
    environment: env,
    bytes: execFileSync("plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
      input: JSON.stringify(doc),
      stdio: ["pipe", "pipe", "pipe"],
    }),
    port: Number(env.CREWPIP_PORT ?? 7357),
  };
}

function withDb(file, readOnly, callback) {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}
function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

const unresolvedPath = (error) =>
  ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "ESTALE", "ENAMETOOLONG"].includes(error.code);

function realDirectory(file) {
  try {
    return fs.realpathSync.native(file);
  } catch (error) {
    if (unresolvedPath(error)) return null;
    throw error;
  }
}

// Der gespeicherte Weg kann über einen Alias in den Worktree und über einen
// weiteren Link wieder hinaus führen. Schon beim Eintritt wird sein noch
// unaufgelöster Rest übernommen, auch bei inzwischen gelöschten Unterordnern.
function worktreeCwds(trees) {
  const identity = (stat) => stat.dev + ":" + stat.ino;
  const targets = new Map(trees.map((tree) => [identity(fs.statSync(tree.old, { bigint: true })), tree.current]));
  return (cwd) => {
    if (!targets.size) return cwd;
    if (!path.isAbsolute(cwd)) return null;
    const pending = cwd.split(path.sep).reverse();
    const resolving = new Set();
    let directory = path.parse(cwd).root;
    while (pending.length) {
      const component = pending.pop();
      if (typeof component !== "string") {
        resolving.delete(component.link);
        continue;
      }
      if (!component || component === ".") continue;
      if (component === "..") {
        directory = path.dirname(directory);
        continue;
      }
      const file = path.join(directory, component);
      let stat, link;
      try {
        stat = fs.lstatSync(file, { bigint: true });
        if (stat.isSymbolicLink()) link = fs.readlinkSync(file);
      } catch (error) {
        if (unresolvedPath(error)) return null;
        throw error;
      }
      if (link !== undefined) {
        if (resolving.has(file)) return null;
        resolving.add(file);
        // Markierung beendet nur diese Linkauflösung. Ein späterer, nicht
        // zyklischer zweiter Besuch desselben Links bleibt damit zulässig.
        pending.push({ link: file }, ...link.split(path.sep).reverse());
        if (path.isAbsolute(link)) directory = path.sep;
        continue;
      }
      const target = targets.get(identity(stat));
      if (target) {
        const suffix = pending
          .reverse()
          .filter((part) => typeof part === "string" && part !== "")
          .join(path.sep);
        return suffix ? target + path.sep + suffix : target;
      }
      directory = file;
    }
    return cwd;
  };
}

function inventory(dbfile) {
  if (!exists(dbfile)) return { projects: [], trees: [] };
  return withDb(dbfile, true, (db) => {
    if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
      throw new Error("SQLite-Integritätsprüfung fehlgeschlagen");
    if (hasTable(db, "runs") && db.prepare("SELECT 1 FROM runs WHERE status='running' LIMIT 1").get())
      throw new Error("Es gibt aktive Läufe. Nach ihrem Abschluss erneut starten.");
    const projects = hasTable(db, "projects")
      ? db
          .prepare("SELECT root FROM projects")
          .all()
          .map((p) => p.root)
      : [];
    const trees = [];
    if (hasTable(db, "tasks") && hasTable(db, "projects")) {
      const rows = db
        .prepare(
          "SELECT worktree_path,worktree_branch,root FROM tasks JOIN projects ON projects.id=tasks.project_id WHERE worktree_path IS NOT NULL",
        )
        .all();
      for (const row of rows) {
        const base = path.join(row.root, "." + legacyName, "worktrees");
        if (path.dirname(row.worktree_path) !== base) continue; // Fremd verwaltete Worktrees bleiben am Ort.
        const old = row.worktree_path,
          root = row.root;
        const current = path.join(root, ".crewpip", "worktrees", path.basename(old));
        const branch = row.worktree_branch;
        if (
          !branch?.startsWith(legacyName + "/") ||
          !exists(old) ||
          exists(current) ||
          git(old, "rev-parse", "--show-toplevel") !== old ||
          git(old, "branch", "--show-current") !== branch ||
          git(old, "rev-parse", "--path-format=absolute", "--git-common-dir") !==
            git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
        ) {
          throw new Error("Verwalteter Worktree fehlt oder sein Ziel/Branch ist belegt: " + old);
        }
        const nextBranch = "crewpip/" + branch.slice(legacyName.length + 1);
        if (ref(root, nextBranch)) throw new Error("Zielbranch existiert: " + nextBranch);
        trees.push({ root, old, current, branch, nextBranch });
      }
    }
    if (
      trees.length &&
      hasTable(db, "sessions") &&
      db
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .some((c) => c.name === "ended_at")
    ) {
      const relocate = worktreeCwds(trees);
      const open = db.prepare("SELECT DISTINCT cwd FROM sessions WHERE ended_at IS NULL").all();
      for (const { cwd } of open) {
        const mapped = relocate(cwd);
        if (mapped === null) throw new Error("CWD eines geöffneten Chats vor dem Umzug klären: " + cwd);
        if (mapped !== cwd) throw new Error("Ein geöffneter Chat verwendet den umzuziehenden Worktree: " + cwd);
      }
    }
    return { projects, trees };
  });
}

// Solange die ursprünglichen Worktrees noch existieren, sowohl den logischen
// Zugang als auch das physische Ziel erfassen. Absolute Benutzerlinks dürfen
// nach dem Umzug ins Leere zeigen, ohne dass die Historie ihr Ziel verliert.
function historicalCwds(dbfile, trees) {
  const locations = new Map();
  if (!trees.length) return locations;
  const relocate = worktreeCwds(trees);
  withDb(dbfile, true, (db) => {
    for (const table of ["sessions", "runs"]) {
      if (!hasTable(db, table)) continue;
      for (const { cwd } of db.prepare(`SELECT DISTINCT cwd FROM ${table}`).all()) {
        if (locations.has(cwd)) continue;
        const logical = relocate(cwd);
        if (!logical || logical === cwd) continue;
        const real = realDirectory(cwd);
        locations.set(cwd, { logical, physical: real && relocate(real) });
      }
    }
  });
  return locations;
}

function updateData(dir, old, current, trees, locations) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = path.join(dir, oldDb + suffix);
    if (exists(path.join(dir, newDb + suffix)))
      throw new Error("Zieldatei im bisherigen Datenordner bereits vorhanden");
    if (exists(file)) fs.renameSync(file, path.join(dir, newDb + suffix));
  }
  const backups = path.join(dir, "backups");
  if (exists(backups))
    for (const name of fs.readdirSync(backups)) {
      if (!name.startsWith(legacyName + "-") || !name.endsWith(".db")) continue;
      const target = path.join(backups, "crewpip" + name.slice(legacyName.length));
      if (exists(target)) throw new Error("Namenskonflikt bei einer Datenbanksicherung");
      fs.renameSync(path.join(backups, name), target);
    }
  const dbfile = path.join(dir, newDb);
  if (!exists(dbfile)) return;
  withDb(dbfile, false, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (hasTable(db, "runs")) {
        db.prepare(
          "UPDATE runs SET log_path=? || substr(log_path,length(?)+1) WHERE log_path=? OR substr(log_path,1,length(?)+1)=? || '/'",
        ).run(current, old, old, old, old);
      }
      for (const table of ["sessions", "runs"]) {
        if (!locations.size || !hasTable(db, table)) continue;
        const update = db.prepare(`UPDATE ${table} SET cwd=? WHERE cwd=?`);
        for (const [cwd, { logical, physical }] of locations) {
          let target = logical;
          if (physical && logical !== physical) {
            const expected = realDirectory(physical);
            if (!expected) throw new Error("Ziel eines historischen CWD nach dem Umzug nicht erreichbar: " + cwd);
            if (realDirectory(logical) !== expected) target = physical;
          }
          update.run(target, cwd);
        }
      }
      for (const tree of trees) {
        db.prepare("UPDATE tasks SET worktree_path=?,worktree_branch=? WHERE worktree_path=?").run(
          tree.current,
          tree.nextBranch,
          tree.old,
        );
      }
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw new Error("Neue Datenbank ist nicht konsistent");
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  });
}

function moveTree(tree, back = false) {
  const from = back ? tree.current : tree.old,
    to = back ? tree.old : tree.current;
  const branch = back ? tree.branch : tree.nextBranch;
  if (!exists(to)) {
    if (!exists(from)) throw new Error("Verwalteter Worktree fehlt: " + from);
    mkdir(path.dirname(to));
    git(tree.root, "worktree", "move", from, to);
  } else if (exists(from)) throw new Error("Beide Worktree-Pfade sind belegt");
  const head = git(to, "branch", "--show-current");
  if (head !== branch) {
    if (head !== (back ? tree.nextBranch : tree.branch))
      throw new Error("Worktree-Branch wurde parallel geändert");
    git(to, "branch", "-m", branch);
  }
}

async function healthy({ port, tokenFile }) {
  const token = read(tokenFile).trim();
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/api/health", {
        headers: { "x-crewpip-token": token },
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      if (r.ok && (await r.json()).ok && loaded(label)) return;
    } catch {
      /* Nach dem Laden braucht der Daemon einen kurzen Moment. */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Der neue Login-Dienst meldet sich nicht gesund");
}

function restore(j) {
  if (j.plist && loaded(label)) launch("bootout", domain + "/" + label);
  if (j.stagingInode && exists(j.current) && fs.statSync(j.current).ino === j.stagingInode) {
    if (exists(path.join(j.backup, "post-upgrade-data")))
      throw new Error("Bitte Sicherungsstand prüfen: " + j.backup);
    fs.renameSync(j.current, path.join(j.backup, "post-upgrade-data"));
  }
  const archived = path.join(j.backup, "original-data");
  if (!exists(j.old) && exists(archived)) fs.renameSync(archived, j.old);
  for (const tree of [...j.trees].reverse()) moveTree(tree, true);
  for (const change of j.changes) {
    const content = read(change.file);
    if (!change.attempted || hash(content) === change.beforeHash) continue;
    const restored = restoreConfig(change.file, read(change.saved), read(change.proposed), content, legacyName);
    if (restored !== content)
      configSwap("swap", change.file, path.join(j.backup, "restored-" + randomUUID()), hash(content), restored);
  }
  if (j.plist) {
    if (exists(j.newPlist)) fs.unlinkSync(j.newPlist);
    if (!exists(j.oldPlist))
      fs.copyFileSync(path.join(j.backup, "login.plist"), j.oldPlist, fs.constants.COPYFILE_EXCL);
    if (j.wasLoaded && !loaded(oldLabel)) {
      // Beim Update im bisherigen Checkout kann dieser Pfad bereits das neue
      // Programm enthalten. Den alten Dienst erst mit seinem gesicherten Build starten.
      return false;
    }
  }
  return true;
}

async function recoverWithLock(lock, owner) {
  // POSIX gibt den exklusiven Lock auch beim Tod beider Prozesse frei.
  const holder = spawn("/usr/bin/python3", [swapHelper, "recovery-lock", lock], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.once("exit", () => reject(new Error("Ein anderer Wiederanlauf verwendet diesen Umzug")));
      holder.stdout.once("data", resolve);
    });
    if (!exists(lock) || read(lock) !== owner) throw new Error("Der Umzug wurde inzwischen fortgesetzt");
    const journal = path.join(JSON.parse(owner).backup, "migration.json");
    if (exists(journal)) {
      const j = JSON.parse(read(journal));
      if (!j.complete && !restore(j))
        console.log(
          "Altdienst gestoppt. Ursprünglichen Checkout und Build wiederherstellen, danach dessen pnpm service:install ausführen.",
        );
    }
    fs.unlinkSync(lock);
    console.log("Wiederanlauf abgeschlossen");
  } finally {
    holder.stdin.end();
  }
}

export async function migrateInstallation({ repo, check = false, recover = false }) {
  requireNode();
  const home = os.homedir(),
    old = path.join(home, "." + legacyName),
    current = path.join(home, ".crewpip");
  const agents = path.join(home, "Library/LaunchAgents");
  const oldPlist = path.join(agents, oldLabel + ".plist"),
    newPlist = path.join(agents, label + ".plist");
  const lock = path.join(home, ".crewpip-upgrade.lock");
  if (exists(lock)) {
    const raw = read(lock);
    const owner = JSON.parse(raw);
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
      else throw e;
    }
    if (alive) throw new Error("Ein anderer Umzug läuft bereits");
    if (!recover) throw new Error("Unterbrochener Umzug. Nach Prüfung: pnpm service:migrate --recover");
    await recoverWithLock(lock, raw);
    return;
  }
  if (recover) throw new Error("Kein unterbrochener Umzug vorhanden");
  const previousState = launchState(oldLabel);
  const wasLoaded = previousState !== null;
  const managedPid = Number(previousState?.match(/^\s*pid = (\d+)$/m)?.[1]) || null;
  if (wasLoaded && !managedPid) throw new Error("PID des bisherigen Login-Dienstes konnte nicht bestimmt werden");
  const hasData = exists(old);
  const configOnly = !hasData && !exists(oldPlist) && !wasLoaded;
  if (!configOnly && (exists(current) || exists(newPlist) || loaded(label)))
    throw new Error("Alte und neue Installation sind gleichzeitig vorhanden. Bestände vor dem Umzug abgleichen.");
  if (!configOnly && (!hasData || !fs.lstatSync(old).isDirectory()))
    throw new Error("Der ursprüngliche Datenordner fehlt oder ist verknüpft");
  const dbfile = path.join(old, oldDb);
  if (hasData) {
    for (const name of [oldDb, oldDb + "-wal", oldDb + "-shm", oldDb + "-journal", "token", "backups", "runs"]) {
      const file = path.join(old, name);
      if (exists(file) && fs.lstatSync(file).isSymbolicLink())
        throw new Error("Externes Datenziel vor dem Umzug prüfen: " + file);
    }
  }
  verifyOwners(dbfile, managedPid);
  if (sqliteSuffixes.some((suffix) => fs.lstatSync(path.join(old, newDb + suffix), { throwIfNoEntry: false })))
    throw new Error("Zieldatenbank oder Sidecardatei im bisherigen Datenordner bereits belegt");
  const before = inventory(dbfile);
  const plist = exists(oldPlist) ? buildPlist(oldPlist, repo, old, current) : null;
  checkForeignEnvReferences(home, legacyName, plist?.renamedEnv);
  const changes = configChanges(home, repo, legacyName, plist?.renamedEnv);
  if (configOnly && !changes.length) {
    console.log("Kein Bestandsumzug erforderlich.");
    return;
  }
  for (const c of changes) configSwap("check", c.file, home);
  const savedToken = installationToken(home, changes, hasData ? old : current, plist);
  if (hasData && !savedToken)
    throw new Error("Das Zugangstoken der bisherigen Installation ist nicht eindeutig verfügbar");
  const createsToken = configOnly && !exists(current) && !!savedToken;
  if (configOnly && exists(current) && savedToken && !exists(path.join(current, "token"))) {
    throw new Error("Vorhandener Zieldatenordner ohne passendes lokales Token");
  }
  if (wasLoaded && !plist) throw new Error("Geladener Dienst ohne ursprüngliche Plist");
  if (plist && !exists(daemonEntry(repo))) throw new Error("Vor dem Umzug pnpm build ausführen");
  if (check) {
    console.log(
      `Umzug möglich: ${changes.length} Konfigurationsdateien, ${before.trees.length} Worktrees, Login-Dienst ${wasLoaded ? "aktiv" : "inaktiv"}.`,
    );
    return;
  }
  const backup = path.join(
    home,
    ".crewpip-migration-backups",
    new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID(),
  );
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, backup }), { flag: "wx", mode: 0o600 });
  const staging = path.join(backup, "new-data"),
    snapshot = path.join(backup, "data");
  const journal = path.join(backup, "migration.json");
  let ready = false;
  try {
    mkdir(backup);
    if (hasData)
      fs.cpSync(old, snapshot, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (file) => !["", "-wal", "-shm", "-journal"].some((s) => file === dbfile + s),
      });
    // Konsistente SQLite-Sicherung einschließlich aller bereits bestätigten WAL-Transaktionen.
    if (exists(dbfile)) withDb(dbfile, true, (db) => db.prepare("VACUUM INTO ?").run(path.join(snapshot, oldDb)));
    if (plist) fs.copyFileSync(oldPlist, path.join(backup, "login.plist"));
    const files = changes.map((change, i) => {
      const saved = path.join(backup, "config-" + i);
      fs.writeFileSync(saved, change.before, { mode: 0o600 });
      return {
        file: change.file,
        saved,
        mode: change.mode,
        beforeHash: hash(change.before),
        afterHash: hash(change.after),
      };
    });
    const j = {
      backup,
      current,
      old,
      oldPlist,
      newPlist,
      newEntry: daemonEntry(repo),
      plist: !!plist,
      wasLoaded,
      trees: before.trees,
      changes: files,
      complete: false,
    };
    atomic(journal, JSON.stringify(j));
    ready = true;
    if (wasLoaded) {
      if (!exists(dbfile)) throw new Error("Geladener Dienst ohne identifizierte Datenbank");
      // Ein Lauf trägt sich vor dem Start seines Kindprozesses in runs ein. Die
      // Schreibsperre schließt die Lücke zwischen letzter Prüfung und Dienststopp.
      withDb(dbfile, false, (db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (hasTable(db, "runs") && db.prepare("SELECT 1 FROM runs WHERE status='running' LIMIT 1").get()) {
            throw new Error("Inzwischen ist ein Lauf gestartet. Nach dem Abschluss erneut versuchen.");
          }
          launch("bootout", domain + "/" + oldLabel);
        } finally {
          db.exec("ROLLBACK");
        }
      });
    }
    await waitForExit(managedPid);
    verifyOwners(dbfile, null);
    if (loaded(oldLabel)) throw new Error("Der bisherige Dienst ist weiterhin geladen");
    // Den letzten Stand nach dem Stoppen verwenden, einschließlich noch vorhandener WAL-Dateien.
    if (JSON.stringify(inventory(dbfile)) !== JSON.stringify(before))
      throw new Error("Bestand während der Vorbereitung geändert");
    if (hasData) {
      fs.cpSync(old, staging, { recursive: true, verbatimSymlinks: true });
      fs.chmodSync(staging, 0o700);
      if (!exists(path.join(staging, "token")))
        fs.writeFileSync(path.join(staging, "token"), savedToken + "\n", { mode: 0o600 });
    } else if (createsToken) {
      mkdir(staging);
      fs.writeFileSync(path.join(staging, "token"), savedToken + "\n", { mode: 0o600 });
    }
    if (hasData || createsToken) {
      j.stagingInode = fs.statSync(staging).ino;
      atomic(journal, JSON.stringify(j));
    }
    const locations = historicalCwds(dbfile, before.trees);
    for (const tree of before.trees) moveTree(tree);
    if (hasData) updateData(staging, old, current, before.trees, locations);
    for (const [i, initial] of changes.entries()) {
      let change = initial;
      if (read(change.file) !== change.before) {
        const latest = configChanges(home, repo, legacyName, plist?.renamedEnv).find(
          (c) => c.file === change.file,
        );
        if (!latest) throw new Error("MCP-/Hook-Eintrag wurde parallel geändert: " + change.file);
        installationToken(home, [latest], hasData ? old : current, plist, savedToken);
        change = latest;
        const saved = path.join(backup, "config-" + i + "-latest");
        fs.writeFileSync(saved, change.before, { mode: 0o600 });
        Object.assign(j.changes[i], { saved, beforeHash: hash(change.before), afterHash: hash(change.after) });
        atomic(journal, JSON.stringify(j));
      }
      if (read(change.file) !== change.before)
        throw new Error("Konfiguration wurde parallel geändert: " + change.file);
      j.changes[i].proposed = path.join(backup, "proposed-" + i);
      fs.writeFileSync(j.changes[i].proposed, change.after, { mode: 0o600 });
      j.changes[i].attempted = true;
      atomic(journal, JSON.stringify(j));
      configSwap("swap", change.file, path.join(backup, "displaced-" + i), hash(change.before), change.after);
    }
    if (hasData || createsToken) {
      if (exists(current)) throw new Error("Datenziel während des Umzugs belegt");
      fs.renameSync(staging, current);
    }
    if (plist) {
      // Auch ein parallel ergänzter Fremdbezug in einer sonst unveränderten Config zählt.
      checkForeignEnvReferences(home, legacyName, plist.renamedEnv);
      atomic(newPlist, plist.bytes);
      fs.unlinkSync(oldPlist);
      if (wasLoaded) {
        launch("bootstrap", domain, newPlist);
        await healthy(plist);
      }
    }
    verifyOwners(dbfile, null);
    if (hasData) fs.renameSync(old, path.join(backup, "original-data"));
    j.complete = true;
    atomic(journal, JSON.stringify(j));
    fs.unlinkSync(lock);
    console.log("CrewPip übernommen. Private Sicherung: " + backup);
    for (const c of changes) console.log("Aktualisiert: " + c.file);
  } catch (error) {
    let resumed = true;
    try {
      if (ready) resumed = restore(JSON.parse(read(journal)));
      fs.unlinkSync(lock);
    } catch {
      throw new Error(
        "Umzug unterbrochen; Sicherung prüfen und pnpm service:migrate --recover ausführen: " + backup,
      );
    }
    if (!resumed)
      throw new Error(
        error.message +
          ". Altdienst kontrolliert gestoppt. Ursprünglichen Checkout und Build wiederherstellen, danach dessen pnpm service:install ausführen. Sicherung: " +
          backup,
      );
    throw error;
  }
}

function requireNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!(major >= 24 || (major === 22 && minor >= 18)))
    throw new Error("CrewPip benötigt Node.js 22.18 oder neuer aus der 22er-Reihe oder Node.js ab 24");
}

export function requireMigratedInstallation(repo) {
  requireNode();
  const home = os.homedir();
  if (
    exists(path.join(home, "." + legacyName)) ||
    exists(path.join(home, ".crewpip-upgrade.lock")) ||
    exists(path.join(home, "Library/LaunchAgents", oldLabel + ".plist")) ||
    loaded(oldLabel) ||
    configChanges(home, repo, legacyName).length
  ) {
    throw new Error(
      "Vor der Dienstinstallation den Bestand mit pnpm service:migrate --check prüfen und pnpm service:migrate ausführen",
    );
  }
}
