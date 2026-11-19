#!/usr/bin/env node
/**
 * CrewPip-Hook für Claude Code, Cursor und Codex.
 *
 *   node crewpip-hook.mjs <claude|cursor|codex> <session-start|prompt|stop|session-end>
 *
 * Liest das Hook-Payload der App von stdin, meldet es dem Daemon und übersetzt die
 * Antwort in das Ausgabeformat der jeweiligen App. Läuft der Daemon nicht oder geht
 * irgendetwas schief, endet das Skript still mit Exit 0, damit der Chat nie hängt.
 *
 * Umgebungsvariablen: CREWPIP_URL (Standard http://127.0.0.1:7357),
 * CREWPIP_SESSION_NAME (optionaler Anzeigename der Session), CREWPIP_RUN (Nummer des Laufs,
 * wenn CrewPip die Session gestartet hat), CREWPIP_HOOK_TIMEOUT_MS (Standard 2500),
 * CREWPIP_HOOK_DEBUG (Dateipfad: schreibt Eingabe, Anfrage und Antwort dorthin),
 * CREWPIP_TOKEN oder CREWPIP_TOKEN_FILE (Standard ~/.crewpip/token).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [app, event] = process.argv.slice(2);
const APPS = new Set(["claude", "cursor", "codex"]);
const EVENTS = new Set(["session-start", "prompt", "stop", "session-end"]);

/** Das Token liegt neben der Datenbank und ist nur für den Eigentümer lesbar. */
export function readToken(env = process.env) {
  if (env.CREWPIP_TOKEN) return env.CREWPIP_TOKEN.trim();
  try {
    return readFileSync(env.CREWPIP_TOKEN_FILE ?? join(homedir(), ".crewpip", "token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function sessionIdOf(app, payload) {
  if (app === "cursor") return payload.conversation_id ?? payload.session_id ?? null;
  return payload.session_id ?? null;
}

export function cwdOf(app, payload, env) {
  if (app === "cursor") return payload.workspace_roots?.[0] ?? env.CURSOR_PROJECT_DIR ?? process.cwd();
  return payload.cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export function renderMessages(messages) {
  const lines = messages.map(
    (m) => `#${m.id} (${m.createdAt})\nvon: ${m.from.label}\nan: ${m.toLabel}\nantworten an: ${m.replyTo}\n\n${m.text}`,
  );
  return (
    `[CrewPip] ${messages.length === 1 ? "Neue Nachricht" : `${messages.length} neue Nachrichten`} ` +
    `für deine Session. Antworten über das MCP-Tool crewpip post_message mit dem Ziel aus "antworten an".\n\n` +
    lines.join("\n\n---\n\n")
  );
}

/**
 * Zeile mit dem Sitzungsschlüssel. Sie geht nur in den Kontext genau dieses Chats und nur,
 * wenn der Daemon den Schlüssel mitschickt — also wenn mehrere Chats derselben App im
 * gleichen Verzeichnis arbeiten und der Aufruf sie sonst nicht unterscheiden kann.
 */
export function renderSessionKey(key) {
  return (
    `[CrewPip] Sitzungsschlüssel: ${key}\n` +
    "Im gleichen Verzeichnis arbeitet noch ein Chat derselben App. Gib diesen Schlüssel " +
    "deshalb bei CrewPip-Werkzeugen als session_key mit, sonst kann CrewPip dich nicht " +
    "von ihm unterscheiden und lehnt ab. Der Schlüssel gehört nur dir: nicht weitergeben " +
    "und keinen fremden verwenden."
  );
}

/** Übersetzt die Daemon-Antwort in das Hook-Ausgabeformat der App. Gibt null zurück, wenn nichts auszugeben ist. */
export function formatOutput(app, event, response) {
  const msgs = response?.messages ?? [];
  // Der Schlüssel geht nur über Ereignisse, die Kontext einspeisen. Bei "stop" wird der Turn
  // blockiert; das darf nie allein wegen des Schlüssels geschehen, sonst entsteht eine
  // Schleife. Deshalb hier eine eigene Sperre, unabhängig davon, was der Daemon schickt.
  const schluesselErlaubt = event === "session-start" || event === "prompt" || (event === "stop" && msgs.length > 0);
  const key = schluesselErlaubt && response?.sessionKey ? response.sessionKey : null;
  if (!msgs.length && !key) return null;
  const text = [key ? renderSessionKey(key) : null, msgs.length ? renderMessages(msgs) : null].filter(Boolean).join("\n\n---\n\n");
  if (app === "cursor") {
    if (event === "session-start") return { additional_context: text };
    if (event === "stop") return { followup_message: text };
    return null;
  }
  // Claude Code und Codex teilen das Format.
  if (event === "session-start") return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
  if (event === "prompt") return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
  if (event === "stop") {
    if (app === "claude") {
      return { hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason: text, additionalContext: text } };
    }
    return { decision: "block", reason: text };
  }
  return null;
}

export async function callDaemon({ app, event, payload, env, fetchImpl = fetch }) {
  const base = (env.CREWPIP_URL ?? "http://127.0.0.1:7357").replace(/\/$/, "");
  const timeout = Number(env.CREWPIP_HOOK_TIMEOUT_MS ?? 2500);
  const body = {
    app,
    event,
    sessionId: sessionIdOf(app, payload),
    cwd: cwdOf(app, payload, env),
    name: env.CREWPIP_SESSION_NAME ?? null,
    runId: env.CREWPIP_RUN ? Number(env.CREWPIP_RUN) : null,
    payload: { hook_event_name: payload.hook_event_name, stop_hook_active: payload.stop_hook_active, status: payload.status },
  };
  const token = readToken(env);
  const res = await fetchImpl(`${base}/hooks/${app}/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-crewpip-token": token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Daemon antwortete ${res.status}`);
  return res.json();
}

function debug(entry) {
  const file = process.env.CREWPIP_HOOK_DEBUG;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), app, event, ...entry }) + "\n");
  } catch {
    // Diagnose darf den Hook nie stören.
  }
}

async function main() {
  if (!APPS.has(app) || !EVENTS.has(event)) return; // falsch aufgerufen: still beenden
  const payload = readStdinJson();
  debug({ payload });
  try {
    const response = await callDaemon({ app, event, payload, env: process.env });
    debug({ response });
    const out = formatOutput(app, event, response);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    debug({ error: String(e && e.message) });
    throw e;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  main().catch(() => {}).finally(() => process.exit(0));
}
