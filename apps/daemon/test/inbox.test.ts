import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { Inbox } from "../src/inbox.js";

import { Board } from "../src/board.js";

function fresh(): Inbox {
  const db = openDb(":memory:");
  return new Inbox(db, new Board(db));
}

test("Session-Label aus App, Projektordner und Name", () => {
  const inbox = fresh();
  const s = inbox.upsertSession({ id: "s1", app: "claude", cwd: "/Users/a/GitHub/example-project", name: "api-worker" });
  assert.equal(s.project, "example-project");
  assert.equal(s.label, "Claude · example-project / api-worker");
  const s2 = inbox.upsertSession({ id: "s2", app: "codex", cwd: "/Users/a/GitHub/example-project" });
  assert.match(s2.name, /^Session \d\d:\d\d$/, "ohne Namen: Startzeit");
});

test("Ziele: session, project, app, all; Zustellung wird pro Session verbucht", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/example-project" });
  inbox.upsertSession({ id: "x1", app: "codex", cwd: "/p/example-project" });
  inbox.upsertSession({ id: "c2", app: "claude", cwd: "/p/demo-project" });

  const m1 = inbox.post({ sessionId: "c1" }, "project:example-project", "an das Projekt");
  assert.deepEqual(m1.pending, ["Codex · example-project / " + inbox.sessions().find((s) => s.id === "x1")!.name], "Absender selbst ist nicht Empfänger");
  assert.equal(m1.replyTo, "session:c1");

  const m2 = inbox.post({ human: "Mensch" }, "app:claude", "an alle Claude");
  assert.deepEqual(m2.pending.length, 2);
  assert.equal(m2.from.kind, "human");
  assert.equal(m2.toLabel, "alle Claude-Sessions");

  assert.deepEqual(inbox.pendingFor("x1").map((m) => m.id), [m1.id]);
  assert.deepEqual(inbox.pendingFor("c2").map((m) => m.id), [m2.id]);
  assert.deepEqual(inbox.pendingFor("c1").map((m) => m.id), [m2.id], "eigene Nachricht zählt nicht");

  const got = inbox.take("x1", "hook-prompt");
  assert.equal(got.length, 1);
  assert.equal(inbox.pendingFor("x1").length, 0);
  const again = inbox.message(m1.id)!;
  assert.equal(again.deliveries[0]!.method, "hook-prompt");
  assert.deepEqual(again.pending, []);
});

test("Nachrichten an all/app erreichen nur Sessions, die zum Sendezeitpunkt liefen; project auch spätere", async () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a" });
  const all = inbox.post({ human: "Mensch" }, "all", "hallo alle");
  const proj = inbox.post({ human: "Mensch" }, "project:b", "für b, wer auch immer kommt");
  await new Promise((r) => setTimeout(r, 5));
  inbox.upsertSession({ id: "later", app: "claude", cwd: "/p/b" });
  const ids = inbox.pendingFor("later").map((m) => m.id);
  assert.ok(!ids.includes(all.id));
  assert.ok(ids.includes(proj.id));
  assert.ok(inbox.pendingFor("c1").map((m) => m.id).includes(all.id));
});

test("resolveByCwd findet die aktive Session der App im Verzeichnis, sonst legt es eine an", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a" });
  assert.equal(inbox.resolveByCwd("claude", "/p/a").id, "c1");
  const auto = inbox.resolveByCwd("codex", "/p/a");
  assert.match(auto.id, /^mcp-codex-/);
  assert.equal(auto.name, "ohne Hook");
  assert.equal(inbox.resolveByCwd("codex", "/p/a/").id, auto.id, "Pfad wird normalisiert");
  inbox.endSession("c1");
  assert.notEqual(inbox.resolveByCwd("claude", "/p/a").id, "c1", "beendete Session wird nicht mehr gewählt");
});

test("Fehler: unbekannte Ziele, leere Texte, unbekannte Sessions", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a" });
  assert.throws(() => inbox.post({ sessionId: "c1" }, "foo:bar", "x"), /Unbekanntes Ziel/);
  assert.throws(() => inbox.post({ sessionId: "c1" }, "session:nope", "x"), /Unbekannte Session/);
  assert.throws(() => inbox.post({ sessionId: "nope" }, "all", "x"), /Unbekannte Session/);
  assert.throws(() => inbox.post({ human: "Mensch" }, "all", "  "), /Leere Nachricht/);
  assert.throws(() => inbox.post({ human: "" }, "all", "x"), /Ungültiger Name/);
});

test("waitFor wacht bei passender Nachricht auf und ignoriert fremde", async () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a" });
  inbox.upsertSession({ id: "c2", app: "claude", cwd: "/p/b" });
  const p = inbox.waitFor("c1", 2000);
  inbox.post({ human: "Mensch" }, "session:c2", "nicht für c1");
  setTimeout(() => inbox.post({ human: "Mensch" }, "session:c1", "für c1"), 20);
  const got = await p;
  assert.deepEqual(got.map((m) => m.text), ["für c1"]);
  assert.equal(got[0]!.deliveries[0]!.method, "mcp-wait");
});

test("waitFor lässt Post bei einem Abbruch vor der Abholung und beim Aufwachen liegen", async () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "antigravity", cwd: "/p/a" });
  const controller = new AbortController();
  // EventEmitter ruft bei emit auch einen Listener auf, der inzwischen entfernt wurde.
  inbox.once("message", () => controller.abort());
  const waiting = inbox.waitFor("c1", 2000, controller.signal);
  const msg = inbox.post({ human: "Mensch" }, "session:c1", "bleibt im Postfach");
  assert.deepEqual(await waiting, []);
  assert.deepEqual(await inbox.waitFor("c1", 2000, controller.signal), []);
  assert.deepEqual(inbox.pendingFor("c1").map(m => m.id), [msg.id]);
  assert.deepEqual(inbox.message(msg.id)!.deliveries, []);
  assert.equal(inbox.listenerCount("message"), 0);
});

test("waitFor läuft in den Timeout, wenn nichts kommt", async () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a" });
  const t0 = Date.now();
  assert.deepEqual(await inbox.waitFor("c1", 60), []);
  assert.ok(Date.now() - t0 >= 55);
});

test("Schleifensperre pro Session, Reset, Umbenennen", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "c1", app: "claude", cwd: "/p/a" });
  assert.equal(inbox.countStopContinuation("c1", 1), true);
  assert.equal(inbox.countStopContinuation("c1", 1), false);
  inbox.resetStopContinuations("c1");
  assert.equal(inbox.countStopContinuation("c1", 1), true);
  assert.equal(inbox.renameSession("c1", "api-worker").label, "Claude · a / api-worker");
});

test("Rollen: aus dem Namen abgeleitet, je Projekt nur ein PM, insgesamt ein Director", () => {
  const inbox = fresh();
  const d = inbox.upsertSession({ id: "d", app: "claude", cwd: "/p/crewpip", name: "Director" });
  assert.equal(d.role, "director", "die Namenskonvention setzt die Rolle");
  assert.equal(inbox.upsertSession({ id: "w", app: "claude", cwd: "/p/crewpip", name: "Worker CrewPip" }).role, "worker");
  assert.equal(inbox.upsertSession({ id: "x", app: "claude", cwd: "/p/outbig", name: "irgendwas" }).role, null);

  const pm1 = inbox.upsertSession({ id: "pm1", app: "claude", cwd: "/p/outbig", name: "PM outbig" });
  assert.equal(pm1.role, "pm");
  // Seit #28: Ein zweiter PM-Name im selben Projekt hängt nicht still um, sondern zeigt einen Konflikt.
  inbox.upsertSession({ id: "pm2", app: "claude", cwd: "/p/outbig", name: "PM outbig neu" });
  assert.equal(inbox.sessions().find((s) => s.id === "pm1")!.role, "pm");
  assert.equal(inbox.sessions().find((s) => s.id === "pm2")!.role, null);
  assert.equal(inbox.sessions().find((s) => s.id === "pm2")!.roleConflict?.holderId, "pm1");
  // Ausdrücklich gesetzt (Dashboard, set_role) löst die neue Vergabe den bisherigen PM ab
  assert.equal(inbox.setRole("pm2", "pm", "Test").role, "pm");
  assert.equal(inbox.sessions().find((s) => s.id === "pm1")!.role, null);
  // Ein PM in einem anderen Projekt bleibt unberührt
  inbox.upsertSession({ id: "pm3", app: "claude", cwd: "/p/demo-project", name: "PM demo-project" });
  assert.equal(inbox.sessions().find((s) => s.id === "pm2")!.role, "pm");

  // Umbenennen wertet den Namen neu aus, hängt aber ebenfalls nicht still um
  assert.equal(inbox.renameSession("x", "PM outbig").role, null);
  assert.equal(inbox.sessions().find((s) => s.id === "pm2")!.role, "pm");
  assert.equal(inbox.renameSession("w", "PM crewpip").role, "pm", "freie Rolle wird per Umbenennen vergeben");
  assert.equal(inbox.setRole("x", null).role, null);
});

test("Ziele pm:<projekt> und director folgen der Rolle, nicht der Sitzung", () => {
  const inbox = fresh();
  inbox.upsertSession({ id: "abs", app: "claude", cwd: "/p/demo-project", name: "Worker demo-project" });
  const m = inbox.post({ sessionId: "abs" }, "pm:outbig", "Bitte um Freigabe");
  assert.equal(m.toLabel, "PM von outbig");
  assert.deepEqual(m.pending, [], "ohne PM wartet die Nachricht");

  // Der PM erscheint erst danach und bekommt sie trotzdem
  const pm = inbox.upsertSession({ id: "pm", app: "claude", cwd: "/p/outbig", name: "PM outbig" });
  assert.deepEqual(inbox.pendingFor(pm.id).map((x) => x.id), [m.id]);

  const dm = inbox.post({ sessionId: "abs" }, "director", "Stand gemeldet");
  assert.equal(dm.toLabel, "den Director");
  const dir = inbox.upsertSession({ id: "dir", app: "claude", cwd: "/p/crewpip", name: "Director" });
  assert.deepEqual(inbox.pendingFor(dir.id).map((x) => x.id), [dm.id]);
  assert.deepEqual(inbox.pendingFor(pm.id).map((x) => x.id), [m.id], "der PM bekommt nicht, was an den Director ging");

  // Nach einem Neustart unter anderer Sitzung greift die Rolle weiter
  inbox.endSession("dir");
  const dir2 = inbox.upsertSession({ id: "dir2", app: "claude", cwd: "/p/crewpip", name: "Director" });
  const dm2 = inbox.post({ sessionId: "abs" }, "director", "zweite Meldung");
  // Die erste Meldung wurde nie abgeholt, deshalb bekommt sie der neue Director mit.
  assert.deepEqual(inbox.pendingFor(dir2.id).map((x) => x.id), [dm.id, dm2.id]);
  assert.throws(() => inbox.post({ sessionId: "abs" }, "rolle:chef", "x"), /Unbekanntes Ziel/);
});

