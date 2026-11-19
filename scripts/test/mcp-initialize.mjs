// MCP-Integrationsprobe im isolierten Test-Home. Liest die tatsächlich migrierte Clientkonfiguration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { openDb } from "../../apps/daemon/src/db.ts";
import { Board } from "../../apps/daemon/src/board.ts";
import { Runner } from "../../apps/daemon/src/runner/index.ts";
import { Inbox } from "../../apps/daemon/src/inbox.ts";
import { createDaemon } from "../../apps/daemon/src/http.ts";
import { loadOrCreateToken } from "../../apps/daemon/src/auth.ts";
const app = process.argv[2];
const home = fs.realpathSync(os.homedir());
if (
  !["claude", "codex"].includes(app) ||
  path.dirname(home) !== fs.realpathSync(os.tmpdir()) ||
  !path.basename(home).startsWith("crewpip-upgrade-")
)
  throw new Error("Die MCP-Probe benötigt ein temporäres Migrations-Testhome");
const server =
  app === "codex"
    ? parse(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).mcp_servers.crewpip
    : JSON.parse(fs.readFileSync(path.join(home, ".claude.json"))).mcpServers.crewpip;
const headers = new Headers(server.http_headers ?? server.headers);
for (const [name, key] of Object.entries(server.env_http_headers ?? {})) {
  if (process.env[key] !== undefined) headers.set(name, process.env[key]);
}
if (server.bearer_token_env_var && process.env[server.bearer_token_env_var])
  headers.set("Authorization", "Bearer " + process.env[server.bearer_token_env_var]);
const db = openDb(":memory:");
const board = new Board(db);
const runner = new Runner(db, board, { logDir: home, log() {} });
const daemon = createDaemon(new Inbox(db, board), board, runner, { token: loadOrCreateToken(), log() {} });
try {
  await new Promise((resolve, reject) => daemon.server.once("error", reject).listen(0, "127.0.0.1", resolve));
  headers.set("Accept", "application/json, text/event-stream");
  headers.set("Content-Type", "application/json");
  const response = await fetch("http://127.0.0.1:" + daemon.server.address().port + new URL(server.url).pathname, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } },
    }),
  });
  if (response.status !== 200 || !(await response.text()).includes("serverInfo"))
    throw new Error("MCP-Initialisierung: HTTP " + response.status);
} finally {
  await daemon.close();
  db.close();
}
