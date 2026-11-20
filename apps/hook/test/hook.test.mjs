import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatOutput, callDaemon, sessionIdOf, cwdOf, renderMessages } from "../crewpip-hook.mjs";

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

test("Antigravity (#20): Gespräch über conversationId, Projekt über workspacePaths", () => {
  const p = { conversationId: "ag-conv-1", workspacePaths: ["/p/ag-projekt", "/p/zweit"], lastUserInput: "Fix den Test" };
  assert.equal(sessionIdOf("antigravity", p), "ag-conv-1");
  assert.equal(cwdOf("antigravity", p, {}), "/p/ag-projekt");
  // Antigravity 2.33 schickt zusätzlich cwd mit; das hat Vorrang.
  assert.equal(cwdOf("antigravity", { ...p, cwd: "/p/echt" }, {}), "/p/echt");
  assert.equal(cwdOf("antigravity", { conversationId: "x" }, {}), null, "ohne Projekt keine Anmeldung, nie ~/.gemini/config");
});

test("Antigravity (#20): Ausgabe als injectSteps bzw. Stop mit continue", () => {
  assert.equal(formatOutput("antigravity", "prompt", { messages: [] }), null);
  const start = formatOutput("antigravity", "session-start", { messages: msgs });
  assert.equal(start.injectSteps.length, 1);
  assert.match(JSON.stringify(start.injectSteps[0]), /antworten an: session:x1/);
  const pre = formatOutput("antigravity", "prompt", { messages: msgs, sessionKey: "k1" });
  assert.match(JSON.stringify(pre.injectSteps), /Sitzungsschlüssel: k1/);
  assert.equal(pre.terminationBehavior, undefined, "nie abbrechen");
  const stop = formatOutput("antigravity", "stop", { messages: msgs });
  assert.deepEqual(Object.keys(stop), ["decision", "reason"]);
  assert.equal(stop.decision, "continue");
  assert.equal(formatOutput("antigravity", "stop", { messages: [], sessionKey: "k" }), null, "leerer Stop setzt nicht fort");
});

test("Antigravity (#20): callDaemon schickt Turn-Merkmal aus lastUserInput, nicht den Text", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ session: null, messages: [], mayContinue: true }) }; };
  const payload = { conversationId: "c1", workspacePaths: ["/p/x"], lastUserInput: "geheimer Prompt", invocationNum: 2 };
  await callDaemon({ app: "antigravity", event: "prompt", payload, env: {}, fetchImpl });
  assert.equal(seen.url, "http://127.0.0.1:7357/hooks/antigravity/prompt");
  assert.equal(seen.body.sessionId, "c1");
  assert.equal(seen.body.cwd, "/p/x");
  assert.equal(typeof seen.body.turn, "string");
  assert.ok(!JSON.stringify(seen.body).includes("geheimer Prompt"), "Prompt-Text verlässt den Hook nicht");
  const t1 = seen.body.turn;
  await callDaemon({ app: "antigravity", event: "prompt", payload: { ...payload, invocationNum: 5 }, env: {}, fetchImpl });
  assert.equal(seen.body.turn, t1, "gleicher Prompt, gleicher Turn");
  await callDaemon({ app: "antigravity", event: "prompt", payload: { ...payload, lastUserInput: "neu" }, env: {}, fetchImpl });
  assert.notEqual(seen.body.turn, t1);
  await callDaemon({ app: "claude", event: "prompt", payload: { session_id: "s", cwd: "/p" }, env: {}, fetchImpl });
  assert.equal(seen.body.turn ?? null, null, "andere Apps ohne Turn-Merkmal");
});

test("Antigravity (#20): Skript akzeptiert die App und endet still ohne Daemon", () => {
  const r = spawnSync("node", [script, "antigravity", "prompt"], { input: JSON.stringify({ conversationId: "c", workspacePaths: ["/p"] }), env: { ...process.env, CREWPIP_URL: "http://127.0.0.1:1", CREWPIP_HOOK_TIMEOUT_MS: "500" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
