/**
 * Gibt die Konfigurationsschnipsel für Claude Code, Cursor und Codex aus.
 * `pnpm snippets` druckt sie, `pnpm snippets --write` legt sie unter config/generated/ ab.
 * Globale Konfigurationsdateien werden nie automatisch verändert.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl } from "./config.js";
import { readToken } from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const hook = path.join(repoRoot, "apps/hook/crewpip-hook.mjs");
const url = baseUrl();
const token = readToken() ?? "<Token aus ~/.crewpip/token>";

const hookCmd = (app: string, event: string) => `node ${hook} ${app} ${event}`;

export const snippets = {
  claudeMcp: {
    file: "~/.claude.json (user scope) oder <projekt>/.mcp.json, alternativ: claude mcp add --transport http --header \"x-crewpip-token: <Token>\" crewpip " + `${url}/mcp/claude?app=claude`,
    content: JSON.stringify(
      { mcpServers: { crewpip: { type: "http", url: `${url}/mcp/claude?app=claude`, headers: { "x-crewpip-token": token } } } },
      null,
      2,
    ),
  },
  claudeHooks: {
    file: "~/.claude/settings.json (in den bestehenden hooks-Block einfügen)",
    content: JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: hookCmd("claude", "session-start"), timeout: 5 }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCmd("claude", "prompt"), timeout: 5 }] }],
          Stop: [{ hooks: [{ type: "command", command: hookCmd("claude", "stop"), timeout: 5 }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: hookCmd("claude", "session-end"), timeout: 5 }] }],
        },
      },
      null,
      2,
    ),
  },
  cursorMcp: {
    file: "~/.cursor/mcp.json",
    content: JSON.stringify(
      { mcpServers: { crewpip: { url: `${url}/mcp/cursor?app=cursor`, headers: { "x-crewpip-token": token } } } },
      null,
      2,
    ),
  },
  cursorHooks: {
    file: "~/.cursor/hooks.json",
    content: JSON.stringify(
      {
        version: 1,
        hooks: {
          sessionStart: [{ command: hookCmd("cursor", "session-start"), timeout: 5 }],
          stop: [{ command: hookCmd("cursor", "stop"), timeout: 5, loop_limit: 10 }],
          sessionEnd: [{ command: hookCmd("cursor", "session-end"), timeout: 5 }],
        },
      },
      null,
      2,
    ),
  },
  codexMcp: {
    file: "~/.codex/config.toml (anhängen), alternativ: codex mcp add crewpip --url " + `${url}/mcp/codex?app=codex`,
    content: [
      "[mcp_servers.crewpip]",
      `url = "${url}/mcp/codex?app=codex"`,
      "startup_timeout_sec = 10",
      "tool_timeout_sec = 60",
      "",
      "[mcp_servers.crewpip.http_headers]",
      `x-crewpip-token = "${token}"`,
      "",
    ].join("\n"),
  },
  codexHooks: {
    // SessionEnd lässt Codex höchstens 3 s zu und kürzt größere Werte mit einer Warnung.
    // Jede Änderung hier ändert die Prüfsumme; danach ist in Codex erneut /hooks nötig.
    file: "~/.codex/hooks.json (in den bestehenden hooks-Block einfügen), danach in Codex /hooks ausführen und freigeben",
    content: JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: hookCmd("codex", "session-start"), timeout: 5 }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCmd("codex", "prompt"), timeout: 5 }] }],
          Stop: [{ hooks: [{ type: "command", command: hookCmd("codex", "stop"), timeout: 5 }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: hookCmd("codex", "session-end"), timeout: 3 }] }],
        },
      },
      null,
      2,
    ),
  },
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const write = process.argv.includes("--write");
  const outDir = path.join(repoRoot, "config/generated");
  if (write) fs.mkdirSync(outDir, { recursive: true });
  for (const [key, s] of Object.entries(snippets)) {
    console.log(`\n### ${key}\n# Ziel: ${s.file}\n${s.content}`);
    if (write) {
      const ext = s.content.trimStart().startsWith("[") ? "toml" : "json";
      fs.writeFileSync(path.join(outDir, `${key}.${ext}`), s.content + "\n");
    }
  }
  if (write) console.log(`\nDateien liegen unter ${outDir}`);
}
