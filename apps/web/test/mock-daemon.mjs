/**
 * Mock-Daemon mit erfundenen Beispieldaten (test/fixture.mjs) für Browser-Prüfungen und Screenshots,
 * ohne echte Repos zu zeigen. Start: node apps/web/test/mock-daemon.mjs [Port], dann
 * CREWPIP_URL=http://127.0.0.1:<Port> pnpm --filter @crewpip/web dev.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { sessions, projects, flows } from "./fixture.mjs";

const { WebSocketServer } = createRequire(new URL("../../daemon/package.json", import.meta.url))("ws");
const port = Number(process.argv[2] ?? 7391);
const routes = { "/api/messages": [], "/api/sessions": sessions, "/api/tasks": [], "/api/projects": projects, "/api/runs": [], "/api/flows": flows };
const server = createServer((req, res) => {
  const data = routes[new URL(req.url, "http://x").pathname];
  res.writeHead(data ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(data ?? { error: "unbekannt" }));
});
new WebSocketServer({ server, path: "/ws" });
server.listen(port, "127.0.0.1", () => console.log(`Mock-Daemon auf http://127.0.0.1:${port}`));
