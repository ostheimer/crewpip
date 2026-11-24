import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { openDb } from "../../src/db.js";
import { Board } from "../../src/board.js";
import { Inbox } from "../../src/inbox.js";
import { Runner } from "../../src/runner/index.js";
import { createDaemon, type DaemonHandle } from "../../src/http.js";

/**
 * Akzeptanztest zu Issue #8: Die Übersicht zeigt pro Repo, welche Chats jetzt tatsächlich
 * verbunden sind, welche nur eingetragen sind, wer PM und Director ist und wo kein Chat
 * verbunden ist.
 */

let browser: Browser;
let daemon: DaemonHandle;
let url: string;
const token = randomUUID();
const ALIVE = process.pid;
const DEAD = 2147483646;

before(async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  const inbox = new Inbox(db, board, new Map([["ag-archiv", "archived"]]));
  inbox.upsertSession({ id: "ag-archiv", app: "antigravity", cwd: "/nirgends/demo-archiv", name: "Archivprobe" });
  inbox.setProcChain("ag-archiv", [{ pid: ALIVE, comm: "language_server" }, { pid: ALIVE, comm: "Antigravity" }]);
  const runner = new Runner(db, board, { logDir: tmpdir() });
  runner.available = () => [];

  // Repo "demo-alpha": PM in Claude verbunden, ein Codex-Thread verbunden, ein Claude-Chat ohne Hook.
  inbox.upsertSession({ id: "pm", app: "claude", cwd: "/nirgends/demo-alpha", name: "PM demo-alpha", pid: ALIVE, status: "idle" });
  inbox.setProcChain("pm", [{ pid: ALIVE, comm: "claude" }]);
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/nirgends/demo-alpha", name: "Codex Umbau" });
  inbox.setProcChain("cx", [{ pid: ALIVE, comm: "codex" }]);
  inbox.registrySync().upsert({ sessionId: "nohook", cwd: "/nirgends/demo-alpha", name: "Alter Arbeitschat", nameSource: "user", pid: ALIVE, startedAt: "2026-11-18T10:00:00.000Z" });
  // Repo "demo-beta": nur ein veralteter Eintrag, dessen Prozess nicht mehr läuft.
  inbox.upsertSession({ id: "old", app: "claude", cwd: "/nirgends/demo-beta", name: "Vergessener Chat", pid: DEAD });
  inbox.setProcChain("old", [{ pid: DEAD, comm: "claude" }]);
  // Director ohne Hook in einem eigenen Ordner.
  inbox.registrySync().upsert({ sessionId: "dir", cwd: "/nirgends/zentrale", name: "Director", nameSource: "user", pid: ALIVE, startedAt: "2026-11-18T09:00:00.000Z" });

  daemon = createDaemon(inbox, board, runner, {
    webDist: fileURLToPath(new URL("../../../web/dist/", import.meta.url)), token, log: () => {},
  });
  await new Promise<void>(resolve => daemon.server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); await daemon?.close(); });

test("Übersicht zeigt je Repo verbundene und nur eingetragene Chats", async () => {
  const page = await browser.newPage({ locale: "de-AT" });
  try {
    await page.goto(url);
    const panel = page.getByRole("region", { name: "Chats an CrewPip" });
    await panel.waitFor();

    const alpha = panel.locator('[data-repo="demo-alpha"]');
    await alpha.locator(".repo-toggle").click();
    assert.match(await alpha.locator(".repo-count").getAttribute("aria-label") ?? "", /2 von 3 Chats mit CrewPip verbunden/);
    const pm = alpha.locator(".conn-chat-list").getByRole("listitem").filter({ hasText: "PM demo-alpha" });
    assert.match(await pm.innerText(), /Post kommt an/);
    assert.match(await pm.innerText(), /PM/);
    const codex = alpha.locator(".conn-chat-list li").filter({ hasText: "Codex Umbau" });
    assert.match(await codex.innerText(), /Codex Umbau[\s\S]*Post kommt an/);
    const nohook = alpha.locator(".conn-chat-list").getByRole("listitem").filter({ hasText: "Alter Arbeitschat" });
    assert.match(await nohook.innerText(), /Ohne Hook/);
    assert.match(await nohook.innerText(), /Letzter Kontakt/);
    // PM und Director stehen beim Repo, mit App.
    assert.match(await alpha.innerText(), /PM:\s*PM demo-alpha \(Claude\)/);
    assert.match(await alpha.innerText(), /Director:\s*Director \(Claude\)/);

    // Beleg für den PR: CREWPIP_SCREENSHOT=<datei.png> legt ein Bild der Ansicht ab.
    if (process.env.CREWPIP_SCREENSHOT) await panel.screenshot({ path: process.env.CREWPIP_SCREENSHOT });

    const beta = panel.locator('[data-repo="demo-beta"]');
    await beta.locator(".repo-toggle").click();
    assert.match(await beta.locator(".repo-count").getAttribute("aria-label") ?? "", /0 von 1 Chat mit CrewPip verbunden/);
    assert.match(await beta.innerText(), /Veraltet/);
    assert.match(await beta.innerText(), /Kein Codex-Chat/);
    assert.match(await beta.innerText(), /PM:\s*nicht vergeben/);

    await page.getByLabel("Sprache", { exact: true }).selectOption("en");
    const en = page.getByRole("region", { name: "Chats on CrewPip" });
    await en.waitFor();
    assert.match(await en.locator('[data-repo="demo-beta"] .repo-count').getAttribute("aria-label") ?? "", /0 of 1 chat connected to CrewPip/);
    assert.match(await en.locator('[data-repo="demo-alpha"]').innerText(), /Without hook/);
  } finally { await page.close(); }
});

test("Die Matrix zeigt den archivierten Antigravity-Chat bei lebendem Prozess mit eigenem Status", async () => {
  const page = await browser.newPage({ locale: "de-AT" });
  try {
    await page.goto(url);
    const row = page.locator('[data-repo="demo-archiv"]');
    await row.locator(".repo-toggle").click();
    assert.match(await row.locator(".repo-count").getAttribute("aria-label") ?? "", /0 von 1 Chat/);
    assert.equal(await row.locator('button.dot-archived').getAttribute("data-chat"), "ag-archiv");
    assert.match(await row.locator(".conn-chat-list").innerText(), /Archivprobe[\s\S]*Archiviert/);
    await page.getByLabel("Sprache", { exact: true }).selectOption("en");
    assert.match(await row.locator(".conn-chat-list").innerText(), /Archived/);
  } finally { await page.close(); }
});
