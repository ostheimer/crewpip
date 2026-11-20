#!/usr/bin/env node
/**
 * CrewPip-Hook für Claude Code, Cursor, Codex und Antigravity.
 *
 *   node crewpip-hook.mjs <claude|cursor|codex|antigravity> <session-start|prompt|stop|session-end>
 *
 * Antigravity kennt kein UserPromptSubmit; dort hängt "prompt" an PreInvocation, das vor jedem
 * Modellaufruf feuert. Doppelte Zustellung verhindert der Daemon über den Zustellnachweis.
 *
 * Liest das Hook-Payload der App von stdin, meldet es dem Daemon und übersetzt die
 * Antwort in das Ausgabeformat der jeweiligen App. Läuft der Daemon nicht oder geht
 * irgendetwas schief, endet das Skript still mit Exit 0, damit der Chat nie hängt.
 *
 * Umgebungsvariablen: CREWPIP_URL (Standard http://127.0.0.1:7357),
 * CREWPIP_SESSION_NAME (optionaler Anzeigename der Session), CREWPIP_RUN (Nummer des Laufs,
 * wenn CrewPip die Session gestartet hat), CREWPIP_HOOK_TIMEOUT_MS (Standard 2500),
 * CREWPIP_HOOK_DEBUG (Dateipfad: schreibt Eingabe, Anfrage und Antwort dorthin),
 * CREWPIP_HOOK_ERROR_LOG (Standard ~/.crewpip/hook-errors.log: eine Zeile je fehlgeschlagenem
 * Aufruf, ohne Inhalte und ohne Token),
 * CREWPIP_TOKEN oder CREWPIP_TOKEN_FILE (Standard ~/.crewpip/token).
 */
import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [app, event] = process.argv.slice(2);
const APPS = new Set(["claude", "cursor", "codex", "antigravity"]);
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
  if (app === "antigravity") return payload.conversationId ?? null;
  if (app === "cursor") return payload.conversation_id ?? payload.session_id ?? null;
  return payload.session_id ?? null;
}

export function cwdOf(app, payload, env) {
  // Antigravity: Projekt laut Doku aus workspacePaths; 2.33 schickt zusätzlich cwd mit (gemessen
  // 20.11.2026, gleicher Wert). Der Hook selbst läuft in ~/.gemini/config, process.cwd() taugt
  // dort nicht. Leere Werte zählen nicht.
  if (app === "antigravity") return [payload.workspacePaths?.[0], payload.cwd].find((p) => typeof p === "string" && p) ?? null;
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

/**
 * Beginnt mit diesem "prompt" ein neuer menschlicher Turn? Nur Antigravity braucht das:
 * PreInvocation feuert vor jedem Modellaufruf, auch nach einem Stop mit "continue".
 * Gemessen mit 2.33 am 20.11.2026: invocationNum ist 0 beim ersten Modellaufruf nach einer
 * Eingabe des Menschen und zählt danach hoch, auch über ein "continue" hinweg. Fehlt das
 * Feld, gilt der Aufruf vorsichtshalber nicht als neuer Turn. Andere Apps: null (jeder
 * "prompt" ist ein menschlicher Prompt).
 */
export function turnStartOf(app, payload) {
  if (app !== "antigravity") return null;
  return payload.invocationNum === 0;
}

/**
 * Ein Schritt, den Antigravity in das Gespräch einspielt. Real geprüft am 20.11.2026: Ein
 * userMessage erreicht das Modell, bleibt im Verlauf und ist für den Menschen sichtbar.
 * ephemeralMessage wäre nur für einen Modellaufruf da, systemMessage ist in der Doku uneinheitlich.
 */
export function antigravityStep(text) {
  return { userMessage: text };
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
  if (app === "antigravity") {
    if (event === "session-start" || event === "prompt") return { injectSteps: [antigravityStep(text)] };
    // "continue" lässt den Agenten weiterlaufen; reason wird als Systemnachricht eingespielt.
    if (event === "stop") return { decision: "continue", reason: text };
    return null;
  }
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
    turnStart: turnStartOf(app, payload),
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

/** Ab dieser Größe wird das Fehlerprotokoll einmal nach *.1 verschoben. */
const ERROR_LOG_MAX = 256 * 1024;

/**
 * Kurzer Grund eines Fehlschlags, ohne Inhalte: fetch meldet "fetch failed" und legt die
 * Ursache (z. B. ECONNREFUSED) in cause; ein Zeitlimit heißt TimeoutError.
 */
export function errorReason(e) {
  if (!e) return "unbekannt";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "Zeitlimit überschritten";
  const cause = e.cause?.code ?? e.cause?.message;
  return String(e.message ?? e).slice(0, 200) + (cause ? ` (${String(cause).slice(0, 80)})` : "");
}

/**
 * Hält einen fehlgeschlagenen Aufruf fest, damit „Ohne Hook“ im Dashboard erklärbar ist (#21).
 * Nur App, Ereignis, Sitzungs-ID, Verzeichnis und Grund; nie Prompt, Antwort oder Token.
 */
export function logFailure({ app, event, payload, error, env = process.env }) {
  const file = env.CREWPIP_HOOK_ERROR_LOG ?? join(homedir(), ".crewpip", "hook-errors.log");
  try {
    try {
      if (statSync(file).size > ERROR_LOG_MAX) renameSync(file, `${file}.1`);
    } catch {
      // Datei gibt es noch nicht.
    }
    const entry = { at: new Date().toISOString(), app, event, sessionId: payload ? sessionIdOf(app, payload) : null, cwd: payload ? cwdOf(app, payload, env) : null, error };
    appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // Protokollieren darf den Hook nie stören.
  }
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
  if (!APPS.has(app) || !EVENTS.has(event)) {
    // Falsch aufgerufen: still beenden, aber festhalten, damit eine kaputte Einrichtung auffällt.
    logFailure({ app: app ?? null, event: event ?? null, payload: null, error: "unbekannte App oder unbekanntes Ereignis" });
    return;
  }
  const payload = readStdinJson();
  debug({ payload });
  if (!sessionIdOf(app, payload)) {
    // Ohne Sitzungs-ID kann der Daemon den Aufruf keiner Session zuordnen; er würde ihn verwerfen.
    logFailure({ app, event, payload, error: "Eingabe ohne Sitzungs-ID" });
    return;
  }
  try {
    const response = await callDaemon({ app, event, payload, env: process.env });
    debug({ response });
    const out = formatOutput(app, event, response);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    debug({ error: String(e && e.message) });
    logFailure({ app, event, payload, error: errorReason(e) });
    throw e;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  main().catch(() => {}).finally(() => process.exit(0));
}
