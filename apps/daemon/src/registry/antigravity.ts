import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

export type ArchiveState = "archived" | "open" | "unconfirmed";

/** Oberste Felder des von Antigravity 2.34 geschriebenen Protobuf-Textes. Unbekannte
 * Schreibweisen bleiben unbestätigt. Ein Titel oder Zeitstempel ist kein Archivkennzeichen. */
function archiveFlag(text: string): boolean | null | undefined {
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
  return result ?? null;
}

/** Der lokale Index enthält auch Text-Chunks mit archived=0 für archivierte Chats. Nur die
 * Kopfzeile (-1) gilt für das Gespräch. Die Abfrage liest weder Titel noch Nachrichten. */
function appHeaders(file: string, ids: string[]): Map<string, number | null> | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (db.prepare("SELECT version FROM search_schema_version").get()?.version !== 3) return undefined;
    const rows = db.prepare(
      `WITH wanted(id) AS MATERIALIZED (SELECT value FROM json_each(?)),
       headers AS MATERIALIZED (
         SELECT conversation_id, MAX(archived) AS archived FROM conversations_fts
         WHERE chunk_index = -1 AND conversation_id IN (SELECT id FROM wanted) GROUP BY conversation_id
       )
       SELECT s.conversation_id, h.archived FROM conversation_summaries s
       LEFT JOIN headers h ON h.conversation_id = s.conversation_id
       WHERE s.app_data_dir = 'antigravity' AND s.conversation_id IN (SELECT id FROM wanted)`
    ).all(JSON.stringify(ids));
    return new Map(rows.map(r => [String(r.conversation_id), r.archived === null ? null : Number(r.archived)]));
  } catch { return undefined; }
  finally { db?.close(); }
}

// Node-SQLite arbeitet synchron. Auch bei großen Archiven muss der Daemon Post annehmen können.
if (!isMainThread && workerData?.task === "antigravity-archives") {
  parentPort?.postMessage(appHeaders(workerData.file, workerData.ids));
}

function readHeaders(file: string, ids: string[]): Promise<Map<string, number | null> | undefined> {
  return new Promise<Map<string, number | null> | undefined>((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { task: "antigravity-archives", file, ids } });
    worker.once("message", resolve);
    worker.once("error", () => resolve(undefined));
    worker.once("exit", () => resolve(undefined));
  }).catch(() => undefined);
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Start und 30-Sekunden-Abgleich. Nur IDs vom Board werden als Dateinamen verwendet. */
export async function refreshAntigravityArchives(
  states: Map<string, ArchiveState>,
  ids: string[],
  root = path.join(os.homedir(), ".gemini", "antigravity"),
): Promise<boolean> {
  const candidates = ids.filter(id => uuid.test(id));
  if (!candidates.length) return false;
  const headers = await readHeaders(path.join(root, "conversation_summaries.db"), candidates);
  const directory = path.join(root, "annotations");
  const files = await readdir(directory).then(entries => new Set(entries)).catch(() => undefined);
  let changed = false;
  for (const id of candidates) {
    const file = id + ".pbtxt";
    const listed = files?.has(file);
    const header = headers?.get(id);
    const annotation = listed ? await readFile(path.join(directory, file), "utf8").then(archiveFlag).catch(() => undefined) : undefined;
    const previous = states.get(id);
    let state: ArchiveState = "unconfirmed";
    if (header === 1 || annotation === true) state = "archived";
    else if (header !== undefined && (header === 0 || annotation === false) &&
      (listed === false || annotation !== undefined)) state = "open";
    if (state === "unconfirmed" && previous === "archived") state = "archived";
    if (state !== previous) { states.set(id, state); changed = true; }
  }
  return changed;
}
