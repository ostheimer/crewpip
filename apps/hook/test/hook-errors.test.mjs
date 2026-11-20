import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

/**
 * #21, Kriterium 3: Fehlgeschlagene Hook-Aufrufe werden protokolliert, ohne Inhalte und ohne
 * Token, damit „Ohne Hook“ erklärbar ist. Der Hook endet trotzdem still mit Exit 0.
 */

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../crewpip-hook.mjs");
const TOKEN = "geheimes-token-123";
const PROMPT = "streng vertraulicher Prompttext";

/** Asynchron starten: ein Testserver im selben Prozess muss antworten können. */
async function run(env, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-hookerr-"));
  const log = path.join(dir, "hook-errors.log");
  const child = spawn("node", [script, "claude", "prompt"], {
    env: { ...process.env, CREWPIP_TOKEN: TOKEN, CREWPIP_HOOK_TIMEOUT_MS: "2000", CREWPIP_HOOK_ERROR_LOG: log, ...env },
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stdin.end(JSON.stringify(input ?? { session_id: "s-123", cwd: "/p/a", prompt: PROMPT }));
  const status = await new Promise((ok) => child.on("close", ok));
  return { r: { status, stdout }, text: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
}

test("Daemon nicht erreichbar: eine Zeile mit App, Ereignis, Session und Grund, ohne Token und Inhalt", async () => {
  const { r, text } = await run({ CREWPIP_URL: "http://127.0.0.1:1" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.app, "claude");
  assert.equal(e.event, "prompt");
  assert.equal(e.sessionId, "s-123");
  assert.match(e.error, /ECONNREFUSED|fetch failed/);
  assert.ok(!text.includes(TOKEN), "kein Token im Protokoll");
  assert.ok(!text.includes(PROMPT), "kein Inhalt im Protokoll");
});

test("Daemon lehnt ab (401): wird mit Statuscode protokolliert", async () => {
  const server = http.createServer((_req, res) => { res.statusCode = 401; res.end("{}"); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const { port } = server.address();
    const { r, text } = await run({ CREWPIP_URL: `http://127.0.0.1:${port}` });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(text.trim()).error, /401/);
  } finally {
    server.close();
  }
});

test("Erfolgreicher Aufruf schreibt nichts ins Fehlerprotokoll", async () => {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ session: null, messages: [], mayContinue: true })); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const { port } = server.address();
    const { r, text } = await run({ CREWPIP_URL: `http://127.0.0.1:${port}` });
    assert.equal(r.status, 0);
    assert.equal(text, "");
  } finally {
    server.close();
  }
});

test("Aufruf ohne Sitzungs-ID wird als Fehler protokolliert", async () => {
  const { r, text } = await run({ CREWPIP_URL: "http://127.0.0.1:1" }, { cwd: "/p/a" });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(text.trim()).error, /Sitzungs-ID/);
});
