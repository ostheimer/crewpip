import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ArchiveState = "archived" | "open" | "unconfirmed";

/** Oberste Felder des von Antigravity 2.34 geschriebenen Protobuf-Textes. Unbekannte
 * Schreibweisen bleiben unbestätigt. Ein Titel oder Zeitstempel ist kein Archivkennzeichen. */
function archiveFlag(text: string): boolean | undefined {
  const source = text.trim();
  if (!source) return undefined;
  const field = /\s*([A-Za-z_]\w*)\s*:\s*("(?:\\.|[^"\\])*"|[\w+.-]+|\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})(?=\s|$)/gy;
  let result: boolean | undefined;
  while (field.lastIndex < source.length) {
    const match = field.exec(source);
    if (!match) return undefined;
    if (match[1] === "archived") {
      if (result !== undefined || !["true", "false"].includes(match[2]!)) return undefined;
      result = match[2] === "true";
    }
  }
  return result ?? false;
}

/** Der lokale Index enthält auch Text-Chunks mit archived=0 für archivierte Chats. Nur die
 * Kopfzeile (-1) gilt für das Gespräch. Die Abfrage liest weder Titel noch Nachrichten. */
function appHeaders(file: string): Map<string, number | null> | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (db.prepare("SELECT version FROM search_schema_version").get()?.version !== 3) return undefined;
    const rows = db.prepare(
      `SELECT s.conversation_id, MAX(h.archived) AS archived FROM conversation_summaries s
       LEFT JOIN conversations_fts h ON h.conversation_id = s.conversation_id AND h.chunk_index = -1
       WHERE s.app_data_dir = 'antigravity' GROUP BY s.conversation_id`
    ).all();
    return new Map(rows.map(r => [String(r.conversation_id), r.archived === null ? null : Number(r.archived)]));
  } catch { return undefined; }
  finally { db?.close(); }
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Start und 30-Sekunden-Abgleich. Nur IDs vom Board werden als Dateinamen verwendet. */
export async function refreshAntigravityArchives(
  states: Map<string, ArchiveState>,
  ids: string[],
  root = path.join(os.homedir(), ".gemini", "antigravity"),
): Promise<boolean> {
  if (!ids.length) return false;
  const headers = appHeaders(path.join(root, "conversation_summaries.db"));
  const directory = path.join(root, "annotations");
  const files = await readdir(directory).then(entries => new Set(entries)).catch(() => undefined);
  let changed = false;
  for (const id of ids) {
    if (!uuid.test(id)) continue;
    const file = id + ".pbtxt";
    const listed = files?.has(file);
    const header = headers?.get(id);
    const annotation = listed ? await readFile(path.join(directory, file), "utf8").then(archiveFlag).catch(() => undefined) : undefined;
    const previous = states.get(id);
    let state: ArchiveState = "unconfirmed";
    if (header === 1 || annotation === true) state = "archived";
    else if (header !== undefined && (header === 0 || header === null) && (annotation === false || listed === false)) {
      // Fehlen beide Archivsignale nach zuvor sicherem Archivstatus, könnte der Chat
      // gelöscht oder der Index im Umbau sein. Erst eine bestätigte Entarchivierung gewinnt.
      if (previous !== "archived" || header === 0 || annotation === false) state = "open";
    }
    if (state === "unconfirmed" && previous === "archived") state = "archived";
    if (state !== previous) { states.set(id, state); changed = true; }
  }
  return changed;
}
