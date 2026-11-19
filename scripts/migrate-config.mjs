// Umzug ausschließlich der zugehörigen MCP- und Hook-Einträge. Andere Einstellungen,
// insbesondere Zugriffsrechte, bleiben erhalten. TOML-Tabellen außerhalb des Servers
// bleiben sogar bytegleich, einschließlich Kommentaren.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { parse } from "smol-toml";
import { parseTree, findNodeAtLocation, modify, applyEdits } from "jsonc-parser";

function renameKey(object, before, after) {
  const next = object[before];
  if (Object.hasOwn(object, after) && !equal(object[after], next)) {
    throw new Error("Unterschiedliche Einstellungen für denselben CrewPip-Eintrag");
  }
  object[after] = next;
  delete object[before];
}

const tokenHeader = "x-crewpip-token";
const headerFields = ["headers", "http_headers", "env_http_headers"];
const matchesToken = (name, old) => [tokenHeader, "x-" + old + "-token"].includes(name.toLowerCase());

function checkLocalServer(server) {
  if (!server || typeof server !== "object" || !server.url)
    throw new Error("Unerwartete lokale MCP-Konfiguration");
  const url = new URL(server.url);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    !/^\/mcp\/(claude|codex|cursor)$/.test(url.pathname)
  )
    throw new Error("MCP-Ziel ist kein lokaler CrewPip-Endpunkt");
}

function migrateServer(server, old, renames, renamedEnv) {
  checkLocalServer(server);
  for (const [key, source] of Object.entries(server.env_http_headers ?? {})) {
    if (renamedEnv?.has(source)) server.env_http_headers[key] = renamedEnv.get(source);
  }
  for (const field of headerFields) {
    const headers = server[field];
    for (const key of Object.keys(headers ?? {})) {
      if (key === tokenHeader || !matchesToken(key, old)) continue;
      renameKey(headers, key, tokenHeader);
      renames?.set(key, tokenHeader);
    }
  }
  if (renamedEnv?.has(server.bearer_token_env_var))
    server.bearer_token_env_var = renamedEnv.get(server.bearer_token_env_var);
}

function migrateServers(servers, old, renames, renamedEnv) {
  const legacy = servers?.[old];
  const current = servers?.crewpip;
  const stale = headerFields.some((field) =>
    Object.keys(current?.[field] ?? {}).some((key) => key.toLowerCase() === "x-" + old + "-token"),
  );
  const movedSource =
    renamedEnv?.has(current?.bearer_token_env_var) ||
    Object.values(current?.env_http_headers ?? {}).some((name) => renamedEnv?.has(name));
  if (!legacy && !stale && !movedSource) return false;
  if (current) migrateServer(current, old, renames, renamedEnv);
  if (legacy) {
    migrateServer(legacy, old, renames, renamedEnv);
    renameKey(servers, old, "crewpip");
  }
  return true;
}

// Die App-Snippets verwenden einen Node-Befehl, einen Skriptpfad und zwei
// Argumente. Ein absoluter Interpreter und quotierte Pfade bleiben gültig.
const hookPattern =
  /^(\s*(?:'[^']+'|"[^"]+"|\S+)\s+)(?:'([^']+)'|"([^"]+)"|(\S+))(\s+(?:claude|codex|cursor)\s+(?:session-start|prompt|stop|session-end)\s*)$/;

function parseHook(command) {
  const match = hookPattern.exec(command);
  return match && { prefix: match[1], script: match[2] ?? match[3] ?? match[4], args: match[5] };
}

function hookCommand(command, old, target) {
  const previous = old + "-hook.mjs";
  if (!command.includes(previous)) return command;
  const parsed = parseHook(command);
  if (!parsed?.script.endsWith("/apps/hook/" + previous))
    throw new Error("Angepassten Hook vor dem Umzug einzeln prüfen");
  const quoted = /^[/\w.-]+$/.test(target) ? target : "'" + target.replaceAll("'", "'\\''") + "'";
  return parsed.prefix + quoted + parsed.args;
}

function migrateHooks(hooks, old, repo) {
  const target = path.join(repo, "apps/hook/crewpip-hook.mjs");
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    // Jede Gruppe behält ihren Ort. Nur bereits vertretene Board-Hooks mit
    // gleichem Gruppen-Kontext und vollständig gleicher Hook-Konfiguration entfallen.
    const seen = [];
    const result = [];
    for (const group of groups) {
      const { hooks: entries, ...context } = group;
      const updated = [];
      for (const hook of entries ?? [group]) {
        if (typeof hook.command !== "string") {
          updated.push(hook);
          continue;
        }
        const next = { ...hook, command: hookCommand(hook.command, old, target) };
        if (parseHook(next.command)?.script === target) {
          const configured = { context: entries ? context : null, hook: next };
          if (seen.some((existing) => equal(existing, configured))) continue;
          seen.push(configured);
        }
        updated.push(next);
      }
      if (entries?.length === 0 || updated.length)
        result.push(entries ? { ...context, hooks: updated } : updated[0]);
    }
    hooks[event] = result;
  }
}

// Eine Änderung wird an den Quellpositionen der betroffenen Schlüssel und Werte
// angewandt. So bleibt auch ein großer, parallel gepflegter Chat-Katalog unverändert.
function jsonEdits(source, before, after, keys) {
  let result = source;
  function replace(node, value) {
    result = result.slice(0, node.offset) + JSON.stringify(value) + result.slice(node.offset + node.length);
  }
  function visit(previous, next, parts) {
    if (equal(previous, next)) return;
    const locate = (p) => findNodeAtLocation(parseTree(result), p);
    if (Array.isArray(previous) && Array.isArray(next) && previous.length === next.length) {
      previous.forEach((v, i) => visit(v, next[i], [...parts, i]));
    } else if (
      previous &&
      next &&
      typeof previous === "object" &&
      typeof next === "object" &&
      !Array.isArray(previous) &&
      !Array.isArray(next)
    ) {
      for (const [key, value] of Object.entries(previous)) {
        if (Object.hasOwn(next, key)) {
          visit(value, next[key], [...parts, key]);
          continue;
        }
        const renamed = keys.get(key);
        if (renamed && Object.hasOwn(next, renamed) && !locate([...parts, renamed])) {
          replace(locate([...parts, key]).parent.children[0], renamed);
          visit(value, next[renamed], [...parts, renamed]);
        } else {
          result = applyEdits(result, modify(result, [...parts, key], undefined, {}));
        }
      }
      for (const [key, value] of Object.entries(next)) {
        if (!Object.hasOwn(previous, key) && !locate([...parts, key]))
          result = applyEdits(result, modify(result, [...parts, key], value, {}));
      }
    } else {
      replace(locate(parts), next);
    }
  }
  visit(before, after, []);
  if (!equal(JSON.parse(result), after)) throw new Error("JSON-Abgleich fehlgeschlagen");
  return result;
}

function jsonConfig(source, old, repo) {
  const doc = JSON.parse(source);
  const before = structuredClone(doc);
  const renames = new Map([[old, "crewpip"]]);
  migrateServers(doc.mcpServers, old, renames);
  if (doc.hooks) migrateHooks(doc.hooks, old, repo);
  if (doc.permissions) {
    const previousPrefix = "mcp__" + old;
    const currentPrefix = "mcp__crewpip";
    const sets = { old: [], current: [] };
    const matches = (rule, prefix) =>
      typeof rule === "string" &&
      (rule === prefix || rule.startsWith(prefix + "__") || rule.startsWith(prefix + "("));
    for (const policy of ["allow", "ask", "deny"]) {
      const rules = doc.permissions[policy];
      if (!Array.isArray(rules)) continue;
      const next = [];
      for (const rule of rules) {
        const previous = matches(rule, previousPrefix);
        const current = matches(rule, currentPrefix);
        const renamed = previous ? currentPrefix + rule.slice(previousPrefix.length) : rule;
        if (previous || current) {
          sets[previous ? "old" : "current"].push(policy + " " + renamed);
          if (!next.includes(renamed)) next.push(renamed);
        } else next.push(rule);
      }
      doc.permissions[policy] = next;
    }
    if (
      sets.old.length &&
      sets.current.length &&
      !equal([...new Set(sets.old)].sort(), [...new Set(sets.current)].sort())
    ) {
      throw new Error("Regeln beider Server haben unterschiedliche Geltungsbereiche");
    }
    if (JSON.stringify(doc.permissions).includes(previousPrefix))
      throw new Error("Angepasste Werkzeugregel einzeln prüfen");
  }
  return jsonEdits(source, before, doc, renames);
}

// Inline-Header sind Stringzuweisungen. Nur die Trennkommas außerhalb der
// Anführungszeichen teilen, damit Werte, Leerraum und fremde Header intakt bleiben.
function inlineHeaders(body, edit) {
  const fields = [];
  let start = 0;
  for (const token of body.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|,/g)) {
    if (token[0] !== ",") continue;
    fields.push(body.slice(start, token.index));
    start = token.index + 1;
  }
  fields.push(body.slice(start));
  return fields
    .map(edit)
    .filter((field) => field !== null)
    .join(",");
}

function tomlConfig(source, old, renamedEnv) {
  const doc = parse(source);
  function checkOverrides(doc) {
    if (JSON.stringify(doc).includes("mcp__" + old + "__"))
      throw new Error("Angepasste Codex-Werkzeugkennung vor dem Umzug prüfen");
  }
  const duplicate = !!doc.mcp_servers?.[old] && !!doc.mcp_servers?.crewpip;
  const changed = migrateServers(doc.mcp_servers, old, undefined, renamedEnv);
  checkOverrides(doc);
  if (!changed) return source;
  const seen = new Set();
  let server;
  let subtable;
  function editEnvValue(assignment) {
    return assignment.replace(
      /^(\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[\w-]+)\s*=\s*)(["'])([^"']+)\2/,
      (whole, prefix, quote, value) =>
        renamedEnv?.has(value) ? prefix + quote + renamedEnv.get(value) + quote : whole,
    );
  }
  function editHeader(assignment, field) {
    if (field === "env_http_headers") assignment = editEnvValue(assignment);
    const match = /^(\s*)(["']?)([\w-]+)\2(?=\s*=)/.exec(assignment);
    if (!match || !matchesToken(match[3], old)) return assignment;
    if (seen.has(field)) return null;
    seen.add(field);
    return match[1] + match[2] + tokenHeader + match[2] + assignment.slice(match[0].length);
  }
  function commentLine(line) {
    const comment = [...line.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|#.*$/gm)].find((token) => token[0][0] === "#");
    return comment ? line.slice(comment.index) : "";
  }
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result = lines
    .map((line) => {
      if (/^\s*\[/.test(line)) {
        const section =
          /^(\s*\[\s*(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*\.\s*)(["']?)([\w-]+)\2\s*([^\]]*)\]/.exec(
            line,
          );
        server = section?.[3];
        subtable = section?.[4].trim();
        if (server === old && !duplicate)
          return line.replace(section[1] + section[2] + old, section[1] + section[2] + "crewpip");
      }
      if (server !== old && server !== "crewpip") return line;
      if (server === old && duplicate) return commentLine(line);
      const headerTable = /^\.\s*["']?(http_headers|env_http_headers)["']?$/.exec(subtable);
      if (headerTable) {
        return editHeader(line, headerTable[1]) ?? commentLine(line);
      }
      if (!subtable) {
        if (/^\s*["']?bearer_token_env_var["']?\s*=/.test(line)) return editEnvValue(line);
        const inline =
          /^(\s*["']?(http_headers|env_http_headers)["']?\s*=\s*\{)((?:"(?:\\.|[^"\\])*"|'[^']*'|[^}"'])*)(\}[^\S\n]*(?:#.*)?\r?\n?)$/.exec(
            line,
          );
        if (inline)
          return inline[1] + inlineHeaders(inline[3], (field) => editHeader(field, inline[2])) + inline[4];
      }
      return line;
    })
    .join("");
  // Nur anwenden, wenn die vollständige TOML-Datenstruktur dem geplanten Ergebnis entspricht.
  if (!equal(parse(result), doc)) throw new Error("Angepassten Codex-MCP-Abschnitt vor dem Umzug einzeln prüfen");
  return result;
}

// Andere MCP-Einträge dürfen ihre explizit vom LaunchAgent geerbte Quelle
// nicht verlieren. Nur Variablennamen vergleichen, keine Fremdzugänge auflösen.
export function checkForeignEnvReferences(home, old, renamedEnv) {
  if (!renamedEnv?.size) return;
  const file = path.join(home, ".codex/config.toml");
  if (!fs.existsSync(file)) return;
  let source, servers;
  try {
    source = fs.readFileSync(file, "utf8");
    servers = parse(source).mcp_servers ?? {};
  } catch {
    throw new Error("Konfiguration nicht sicher übernehmbar: " + file);
  }
  for (const [index, [id, server]] of Object.entries(servers).entries()) {
    if (id === old || id === "crewpip") continue;
    let field;
    if (renamedEnv.has(server.bearer_token_env_var)) field = "bearer_token_env_var";
    else if (Object.values(server.env_http_headers ?? {}).some((name) => renamedEnv.has(name)))
      field = "env_http_headers";
    if (!field) continue;
    const line = source.split("\n").findIndex((text) => {
      const match =
        /^\s*\[\s*(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*\.\s*(?:"([^"\\]*)"|'([^']*)'|([\w-]+))\s*[.\]]/.exec(
          text,
        );
      return match && (match[1] ?? match[2] ?? match[3]) === id;
    });
    const location = line >= 0 ? file + ":" + (line + 1) : file;
    throw new Error(
      `MCP-Eintrag Nr. ${index + 1} in ${location} bezieht über ${field} eine bisherige LaunchAgent-Variable. Diesen Bezug vor dem Umzug klären.`,
    );
  }
}

export function configChanges(home, repo, old, renamedEnv) {
  const files = [".claude.json", ".claude/settings.json", ".codex/config.toml", ".codex/hooks.json"].map((f) =>
    path.join(home, f),
  );
  const changes = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    if (!before.toLowerCase().includes(old)) continue;
    try {
      const after = file.endsWith(".toml") ? tomlConfig(before, old, renamedEnv) : jsonConfig(before, old, repo);
      if (before !== after) {
        if (!fs.lstatSync(file).isFile()) throw new Error("Verknüpfte Konfiguration bitte am Ziel überprüfen");
        changes.push({ file, before, after, mode: fs.statSync(file).mode & 0o777 });
      }
    } catch {
      // Parserfehler können ganze Zeilen mitsamt Zugangsdaten enthalten.
      throw new Error("Konfiguration nicht sicher übernehmbar: " + file);
    }
  }
  return changes;
}

// Nur ausdrücklich referenzierte Auth-Variablen des lokalen MCP-Servers lesen.
function environmentValues(name, plist) {
  if (typeof name !== "string" || !name) throw new Error();
  const values = new Set();
  if (Object.hasOwn(plist?.environment ?? {}, name)) values.add(plist.environment[name]);
  if (Object.hasOwn(process.env, name)) values.add(process.env[name]);
  for (const [before, after] of plist?.renamedEnv ?? []) {
    if (after === name && Object.hasOwn(process.env, before)) values.add(process.env[before]);
  }
  if (!values.size) throw new Error();
  return [...values];
}

function clientTokens(server, codex, plist) {
  if (!server) return [];
  const fields = codex ? ["http_headers", "env_http_headers"] : ["headers"];
  function headers(name) {
    const headers = [];
    for (const field of fields) {
      for (const [key, value] of Object.entries(server[field] ?? {})) {
        if (key.toLowerCase() !== name) continue;
        checkLocalServer(server);
        const values = field === "env_http_headers" ? environmentValues(value, plist) : [value];
        for (const raw of values) {
          if (typeof raw !== "string" || (!codex && /\$\{[^}]+\}/.test(raw))) throw new Error();
          // Gleiche Normalisierung und Prüfung wie beim Aufbau eines HTTP-Headers.
          headers.push(new Headers([[name, raw]]).get(name));
        }
      }
    }
    return headers;
  }
  // tokenFromRequest nimmt zuerst den Produkttoken-Header. Fremde oder
  // nachrangige Authorization-Quellen in diesem Fall gar nicht auflösen.
  const primary = headers(tokenHeader);
  if (primary.some(Boolean)) {
    const tokens = primary.map((value) => value.trim());
    if (tokens.some((token) => !token)) throw new Error();
    return tokens;
  }
  const tokens = headers("authorization").map((header) => {
    if (!header.toLowerCase().startsWith("bearer ")) throw new Error();
    return header.slice(7).trim();
  });
  if (codex && Object.hasOwn(server, "bearer_token_env_var")) {
    checkLocalServer(server);
    for (const value of environmentValues(server.bearer_token_env_var, plist)) {
      const header = new Headers([["authorization", "Bearer " + value]]).get("authorization");
      tokens.push(header.slice(7).trim());
    }
  }
  if (tokens.some((token) => !token) || (primary.length && !tokens.length)) throw new Error();
  return tokens;
}

// Nur die Token-Header der beteiligten lokalen MCP-Einträge vergleichen. Bei einer
// Installation mit ausschließlich gespeicherter Clientkonfiguration kann so derselbe
// Zugang beim ersten Dienststart weiterverwendet werden.
export function installationToken(home, changes, dir, plist, expected = plist?.configuredToken) {
  const tokens = new Set();
  if (expected) tokens.add(expected);
  const tokenFile = path.join(dir, "token");
  if (fs.existsSync(tokenFile)) tokens.add(fs.readFileSync(tokenFile, "utf8").trim());
  const sources = new Map(changes.map(({ file, after }) => [file, after]));
  for (const relative of [".claude.json", ".codex/config.toml"]) {
    const file = path.join(home, relative);
    if (!sources.has(file) && fs.existsSync(file)) sources.set(file, fs.readFileSync(file, "utf8"));
  }
  for (const [file, source] of sources) {
    try {
      const codex = file.endsWith(".toml");
      const server = codex ? parse(source).mcp_servers?.crewpip : JSON.parse(source).mcpServers?.crewpip;
      for (const token of clientTokens(server, codex, plist)) tokens.add(token);
    } catch {
      // Weder Parserfehler noch Headerwerte aus den privaten Konfigurationen ausgeben.
      throw new Error("Lokales MCP-Token nicht eindeutig bestimmbar: " + file);
    }
  }
  if (tokens.size > 1)
    throw new Error("Lokale Token stimmen nicht überein. Getrennte Installationen vor dem Umzug prüfen.");
  return [...tokens][0];
}

// Bei einer Rücknahme nur die tatsächlich migrierten Felder zurücklegen. Der
// Claude-Client kann z.B. in derselben Datei gleichzeitig Nutzungszähler pflegen.
export function restoreConfig(file, before, after, current, old) {
  if (current === after) return before;
  if (current === before) return current;
  const isToml = file.endsWith(".toml");
  const decode = isToml ? parse : JSON.parse;
  function undo(original, applied, live) {
    if (equal(original, applied) || equal(original, live)) return live;
    if (equal(applied, live)) return original;
    if ([original, applied, live].every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      const result = { ...live };
      for (const key of new Set([...Object.keys(original), ...Object.keys(applied)])) {
        const value = undo(original[key], applied[key], live[key]);
        if (value === undefined) delete result[key];
        else result[key] = value;
      }
      return result;
    }
    throw new Error("Betroffener Konfigurationseintrag wurde zusätzlich geändert: " + file);
  }
  if (isToml) {
    // Wird das TOML parallel geändert, alle Fassungen für die manuelle
    // Zusammenführung bewahren. Es gibt in Codex keinen Schreib-Lock für Clients.
    throw new Error("Parallele TOML-Änderung vor der Wiederherstellung abgleichen: " + file);
  }
  const doc = decode(current);
  const restored = undo(decode(before), decode(after), doc);
  return jsonEdits(
    current,
    doc,
    restored,
    new Map([
      ["crewpip", old],
      ["x-crewpip-token", "x-" + old + "-token"],
    ]),
  );
}
