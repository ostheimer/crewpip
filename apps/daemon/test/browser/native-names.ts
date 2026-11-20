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
  const filter = page.locator(".sidebar-search input");
  await filter.fill("Wartung");
  await page.locator('.matrix-repo[data-repo="Werkstatt"]').waitFor();
  assert.equal(await page.locator('.matrix-repo[data-repo="git-ordner"]').count(), 0);
  await filter.fill("");
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
  const card = page.locator(".message-list .message-card").filter({ hasText: "Nur der zweite Chat" });
  await card.waitFor();
  assert.equal(await page.locator(".message-list .message-card").count(), 1);
  // Die Browserseite bleibt geöffnet, während Registry, lokaler Alias und Zustellung wechseln.
  inbox.registrySync().upsert({ sessionId: "neu", name: "Neuer Chat", cwd: "/nirgends/neuer-ordner", pid: process.pid, nameSource: "user", startedAt: null });
  await select.locator('option[value="session:neu"]').waitFor({ state: "attached" });
  await select.selectOption("");
  inbox.renameSession("beta", "Neuer Titel");
  await page.waitForFunction(() => document.querySelector('option[value="session:beta"]')?.textContent === "Neuer Titel");
  inbox.take("beta", "mcp-read");
  await card.getByText("Im Empfänger-Chat zugestellt", { exact: true }).waitFor();
  assert.doesNotMatch(await card.innerText(), /wartet/);
});
