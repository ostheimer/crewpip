import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { snippets } from "../src/setup.js";

test("Codex setup references a helper instead of printing the access token", () => {
  const server = parse(snippets.codexMcp.content).mcp_servers as {
    crewpip: { http_headers_helper?: string; http_headers?: object };
  };
  assert.equal(Object.hasOwn(server.crewpip, "http_headers"), false);
  assert.equal(typeof server.crewpip.http_headers_helper, "string");

  const dir = mkdtempSync(join(tmpdir(), "crewpip-codex-headers-"));
  try {
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "synthetic-setup-token\n", { mode: 0o600 });
    const output = execSync(server.crewpip.http_headers_helper!, {
      encoding: "utf8",
      env: { ...process.env, CREWPIP_TOKEN: "", CREWPIP_TOKEN_FILE: tokenFile },
    });
    assert.deepEqual(JSON.parse(output), { "x-crewpip-token": "synthetic-setup-token" });
    assert.throws(
      () => execSync(server.crewpip.http_headers_helper!, {
        env: { ...process.env, CREWPIP_TOKEN: "", CREWPIP_TOKEN_FILE: join(dir, "missing") },
        stdio: "pipe",
      }),
      { status: 1 },
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
