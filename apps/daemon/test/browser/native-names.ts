import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { openDb } from "../../src/db.js";
import { Board } from "../../src/board.js";
import { Inbox } from "../../src/inbox.js";
import { Runner } from "../../src/runner/index.js";
import { createDaemon } from "../../src/http.js";

test("Seitenleiste und mobile Auswahl öffnen jeden eigenständigen Chat unter seinem App-Titel", async (t) => {
  const db = openDb(":memory:");
  const board = new Board(db, {
    titles: new Map([["codex:alpha", "Wartung"], ["claude:beta", "Planung"]]),
    projects: new Map([["/nirgends/git-ordner", "Werkstatt"]]),
  });
  const inbox = new Inbox(db, board);
  inbox.upsertSession({ id: "alpha", app: "codex", cwd: "/nirgends/rohordner" });
  inbox.upsertSession({ id: "beta", app: "claude", cwd: "/nirgends/rohordner" });
  const other = inbox.upsertSession({ id: "unknown", app: "codex", cwd: "/nirgends/rohordner" });
  inbox.upsertSession({ id: "c", app: "claude", cwd: "/nirgends/git-ordner" });
  inbox.post({ human: "Test" }, "session:alpha", "Nur der erste Chat");
  inbox.post({ human: "Test" }, "session:beta", "Nur der zweite Chat");
  inbox.endSession("alpha");
  const runner = new Runner(db, board, { logDir: tmpdir() });
  runner.available = () => [];
  const daemon = createDaemon(inbox, board, runner, { webDist: fileURLToPath(new URL("../../../web/dist/", import.meta.url)), token: randomUUID(), log: () => {} });
  await new Promise<void>(resolve => daemon.server.listen(0, "127.0.0.1", resolve));
  t.after(() => daemon.close());
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "de-AT" });
  await page.goto(`http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`);
  await page.locator(".all-projects").click();
  await page.locator(".project-list").getByRole("button", { name: "Wartung", exact: true }).click();
  assert.equal(await page.locator(".desktop-project").innerText(), "Wartung");
  assert.match(await page.locator(".message-list .message-card summary").first().innerText(), /Nur der erste Chat/);
  assert.equal(await page.locator(".message-list .message-card").count(), 1);
  assert.ok(!/rohordner|git-ordner/.test(await page.locator(".project-list").innerText()));
  await page.setViewportSize({ width: 400, height: 760 });
  const select = page.locator(".mobile-project");
  assert.equal(await select.isVisible(), true);
  assert.deepEqual((await select.locator("option").allTextContents()).sort(), ["Alle Projekte", "Planung", "Wartung", "Werkstatt", other.name].sort());
  await select.selectOption("session:unknown");
  assert.equal(await page.locator(".message-list .message-card").count(), 0);
  await select.selectOption({ label: "Planung" });
  await page.getByRole("button", { name: "Chat schreiben", exact: true }).click();
  assert.equal(await page.locator(".composer select").inputValue(), "session:beta");
  assert.equal(await page.locator(".message-list .message-card").count(), 1);
  assert.match(await page.locator(".message-list .message-card").innerText(), /Nur der zweite Chat/);
});
