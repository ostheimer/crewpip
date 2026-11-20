#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, baseUrl } from "./config.js";
import { openDb, schemaVersion } from "./db.js";
import { Inbox } from "./inbox.js";
import { Board } from "./board.js";
import { Runner } from "./runner/index.js";
import { createDaemon } from "./http.js";
import { NativeNames } from "./registry/native-names.js";
import type { AppKind } from "@crewpip/shared";
import { ClaudeRegistryWatcher, registryDir } from "./registry/claude.js";
import { loadOrCreateToken, tokenPath } from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");

const db = openDb(config.dbPath, { log: (l) => console.log(l) });
const names = new NativeNames();
const board = new Board(db, names);
const inbox = new Inbox(db, board);
const runner = new Runner(db, board, {
  logDir: path.join(path.dirname(config.dbPath), "runs"),
  log: (l) => console.log(l),
});
const authDisabled = process.env.CREWPIP_AUTH === "off";
const token = authDisabled ? "" : loadOrCreateToken();
const daemon = createDaemon(inbox, board, runner, {
  webDist,
  schemaVersion: schemaVersion(db),
  token,
  authDisabled,
  allowedHosts: (process.env.CREWPIP_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
});

// Übernimmt Namen (auch nach /rename), Inbox-Sockets und beendete Sessions aus der
// Session-Registry von Claude Code, auch für Fenster ohne eingerichtete Hooks.
const registry = new ClaudeRegistryWatcher(inbox.registrySync(), { log: (l) => console.log(l) });
registry.start();

let refreshing = false;
async function refreshNames() {
  if (refreshing) return;
  refreshing = true;
  try {
    const known = db.prepare("SELECT id, app FROM sessions WHERE app IN ('codex', 'claude')").all() as unknown as { id: string; app: AppKind }[];
    if (await names.refresh(known)) {
      board.emit("projects");
      inbox.emit("sessions");
    }
  } finally { refreshing = false; }
}
void refreshNames();
const nameTimer = setInterval(() => void refreshNames(), 30_000);
nameTimer.unref();

daemon.server.listen(config.port, config.host, () => {
  console.log(`crewpip-daemon läuft auf ${baseUrl()}  (DB: ${config.dbPath})`);
  console.log(`  MCP:   ${baseUrl()}/mcp/<app>`);
  console.log(`  Hooks: ${baseUrl()}/hooks/<app>/<event>`);
  console.log(`  Claude-Registry: ${registryDir()}`);
  console.log(`  Schema: ${schemaVersion(db)}`);
  console.log(authDisabled ? "  Zugangsschutz: AUS (CREWPIP_AUTH=off)" : `  Token: ${tokenPath()}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(nameTimer);
    registry.stop();
    runner.stopAll();
    daemon.close().then(() => process.exit(0));
  });
}
