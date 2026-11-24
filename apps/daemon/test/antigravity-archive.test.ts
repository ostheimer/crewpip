import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { refreshAntigravityArchives, type ArchiveState } from "../src/registry/antigravity.js";

test("Der App-Abgleich prüft Archiv, Entarchivierung und unklare Quellen ohne Gesprächsinhalte", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "crewpip-archive-test-"));
  const id = "10000000-1111-2222-3333-000000000001";
  const ide = "10000000-1111-2222-3333-000000000002";
  const states = new Map<string, ArchiveState>();
  const sync = () => refreshAntigravityArchives(states, [id, ide], root);
  const annotation = path.join(root, "annotations", id + ".pbtxt");
  try {
    await sync();
    assert.equal(states.get(id), "unconfirmed");
    mkdirSync(path.dirname(annotation));
    const db = new DatabaseSync(path.join(root, "conversation_summaries.db"));
    try {
      db.exec(`
        CREATE TABLE search_schema_version(version INTEGER);
        INSERT INTO search_schema_version VALUES (3);
        CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, app_data_dir TEXT);
        INSERT INTO conversation_summaries VALUES ('${id}','antigravity'), ('${ide}','antigravity-ide');
        CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, archived UNINDEXED, title);
        INSERT INTO conversations_fts VALUES ('${id}',-1,0,'Test'), ('${id}',0,0,'Test'), ('${ide}',-1,1,'IDE');
      `);
      writeFileSync(annotation, 'title:"archived:true" last_user_view_time:{seconds:100 nanos:0}');
      await sync();
      assert.equal(states.get(id), "open");
      assert.equal(states.get(ide), "unconfirmed");
      assert.equal(await sync(), false);
      // Die Annotation ist geschrieben, der Suchindex hinkt hinterher.
      writeFileSync(annotation, 'title:"Prüfchat" archived:true archival_status_timestamp:{seconds:100}');
      await sync();
      assert.equal(states.get(id), "archived");
      db.exec("UPDATE search_schema_version SET version=4");
      rmSync(annotation);
      await sync();
      assert.equal(states.get(id), "archived");
      states.clear();
      await sync();
      assert.equal(states.get(id), "unconfirmed");
      db.exec(`UPDATE search_schema_version SET version=3; UPDATE conversations_fts SET archived=1 WHERE chunk_index=-1`);
      writeFileSync(annotation, 'title:"Prüfchat" archived:false');
      await sync();
      assert.equal(states.get(id), "archived");
      db.exec("UPDATE conversations_fts SET archived=0 WHERE chunk_index=-1");
      await sync();
      assert.equal(states.get(id), "open");
      writeFileSync(annotation, 'title:"halb geschrieben');
      await sync();
      assert.equal(states.get(id), "unconfirmed");
      db.exec("DELETE FROM conversations_fts WHERE chunk_index=-1");
      writeFileSync(annotation, 'title:"archived:true" last_user_view_time:{archived:true}');
      await sync();
      assert.equal(states.get(id), "open");
      db.exec("DELETE FROM conversation_summaries");
      await sync();
      assert.equal(states.get(id), "unconfirmed");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
