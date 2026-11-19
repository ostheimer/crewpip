import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatOutput, callDaemon, sessionIdOf, renderMessages } from "../crewpip-hook.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../crewpip-hook.mjs");
const msgs = [{ id: 7, from: { kind: "session", label: "Codex · example-project / Thread 14:02" }, toLabel: "Claude · example-project / api-worker", replyTo: "session:x1", text: "hi", createdAt: "2026-09-01T10:00:00Z" }];

test("renderMessages nennt Absender, Empfänger und Antwortadresse", () => {
  const t = renderMessages(msgs);
  assert.match(t, /von: Codex · example-project \/ Thread 14:02/);
  assert.match(t, /antworten an: session:x1/);
});

test("formatOutput: Claude Code / Codex / Cursor", () => {
  assert.equal(formatOutput("claude", "prompt", { messages: [] }), null);
  assert.equal(formatOutput("claude", "prompt", { messages: msgs }).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(formatOutput("claude", "stop", { messages: msgs }).hookSpecificOutput.decision, "block");
  assert.deepEqual(Object.keys(formatOutput("codex", "stop", { messages: msgs })), ["decision", "reason"]);
  assert.equal(formatOutput("codex", "session-start", { messages: msgs }).hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok("followup_message" in formatOutput("cursor", "stop", { messages: msgs }));
  assert.ok("additional_context" in formatOutput("cursor", "session-start", { messages: msgs }));
  assert.equal(formatOutput("cursor", "prompt", { messages: msgs }), null, "Cursor kann beim Prompt keinen Kontext einspeisen");
});

test("sessionIdOf: Cursor nutzt conversation_id", () => {
  assert.equal(sessionIdOf("cursor", { conversation_id: "c1" }), "c1");
  assert.equal(sessionIdOf("claude", { session_id: "s1" }), "s1");
});

test("callDaemon schickt Kontext und Token, aber keine Socket-Daten mehr", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ session: null, messages: [], mayContinue: true }) }; };
  await callDaemon({ app: "claude", event: "stop", payload: { session_id: "s1", cwd: "/p" }, env: { CREWPIP_SESSION_NAME: "planer", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t" }, fetchImpl });
  assert.equal(seen.url, "http://127.0.0.1:7357/hooks/claude/stop");
  assert.equal(seen.body.name, "planer");
  assert.equal(seen.body.cwd, "/p");
  // Der Push-Weg ist entfallen; CrewPip bekommt keine Socket-Daten mehr zu sehen.
  assert.equal("socketPath" in seen.body, false);
  assert.equal("socketToken" in seen.body, false);
});

test("Skript endet still mit Exit 0, wenn der Daemon nicht erreichbar ist", () => {
  const r = spawnSync("node", [script, "claude", "stop"], { input: JSON.stringify({ session_id: "s" }), env: { ...process.env, CREWPIP_URL: "http://127.0.0.1:1", CREWPIP_HOOK_TIMEOUT_MS: "500" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("Skript endet still bei falschen Argumenten oder kaputtem stdin", () => {
  assert.equal(spawnSync("node", [script, "foo", "bar"], { input: "{", encoding: "utf8" }).status, 0);
  const r = spawnSync("node", [script, "claude", "stop"], { input: "not json", env: { ...process.env, CREWPIP_URL: "http://127.0.0.1:1", CREWPIP_HOOK_TIMEOUT_MS: "500" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("Sitzungsschlüssel bei stop nur mit Nachrichten, nie allein (Aufgabe #46)", () => {
  // Ein Stop wird blockiert, damit der Chat weiterläuft. Das ist nur zu rechtfertigen, wenn
  // ohnehin Post zuzustellen ist — ein Stop allein für den Schlüssel wäre eine Schleife.
  assert.equal(formatOutput("codex", "stop", { messages: [], sessionKey: "k-allein" }), null, "leerer Stop bleibt unblockiert");
  assert.equal(formatOutput("claude", "stop", { messages: [], sessionKey: "k-allein" }), null);
  const mit = formatOutput("codex", "stop", { messages: msgs, sessionKey: "k-mit" });
  assert.equal(mit.decision, "block");
  assert.match(mit.reason, /Sitzungsschlüssel: k-mit/);
  assert.match(mit.reason, /hi/, "die Nachricht selbst bleibt erhalten");
  // Beim Ende des Chats nützt der Schlüssel nichts mehr.
  assert.equal(formatOutput("codex", "session-end", { messages: [], sessionKey: "k-ende" }), null);
});
