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
 * Akzeptanztest zu Issue #15: Die Übersicht macht klar, dass jeder Chat mit CrewPip verbunden
 * ist (nicht mit anderen Chats), unterscheidet Claude und Codex nicht nur über Farbe, erklärt
 * jeden Zustand per Tastatur und zeigt die Nachrichtenwege der letzten 24 Stunden.
 */

let browser: Browser;
let daemon: DaemonHandle;
let url: string;
const token = randomUUID();
const ALIVE = process.pid;

before(async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  const inbox = new Inbox(db, board);
  const runner = new Runner(db, board, { logDir: tmpdir() });
  runner.available = () => [];
  inbox.upsertSession({ id: "pm", app: "claude", cwd: "/nirgends/demo-alpha", name: "PM demo-alpha", pid: ALIVE, status: "idle" });
  inbox.setProcChain("pm", [{ pid: ALIVE, comm: "claude" }]);
  inbox.upsertSession({ id: "cx", app: "codex", cwd: "/nirgends/demo-alpha", name: "Codex Umbau" });
  inbox.setProcChain("cx", [{ pid: ALIVE, comm: "codex" }]);
  inbox.registrySync().upsert({ sessionId: "nohook", cwd: "/nirgends/demo-alpha", name: "Alter Arbeitschat", nameSource: "user", pid: ALIVE, startedAt: "2026-11-18T10:00:00.000Z" });
  inbox.upsertSession({ id: "dir", app: "claude", cwd: "/nirgends/zentrale", name: "Director", pid: ALIVE, role: "director" });
  inbox.setProcChain("dir", [{ pid: ALIVE, comm: "claude" }]);
  // Codex schreibt an die Rolle PM, der PM holt ab; der PM meldet an den Director.
  inbox.post({ sessionId: "cx" }, "pm:demo-alpha", "geheimer Befundtext");
  inbox.post({ sessionId: "cx" }, "pm:demo-alpha", "zweiter Befund");
  inbox.take("pm", "hook-prompt");
  inbox.post({ sessionId: "pm" }, "director", "Stand");
  inbox.take("dir", "mcp-read");
  daemon = createDaemon(inbox, board, runner, {
    webDist: fileURLToPath(new URL("../../../web/dist/", import.meta.url)), token, log: () => {},
  });
  await new Promise<void>(resolve => daemon.server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); await daemon?.close(); });

test("Übersicht: Verbindung zu CrewPip, Anbieter erkennbar, Zustände erklärt, Nachrichtenwege", async () => {
  const page = await browser.newPage({ locale: "de-AT", viewport: { width: 1440, height: 1600 } });
  try {
    await page.goto(url);
    const panel = page.getByRole("region", { name: "Chats an CrewPip" });
    await panel.waitFor();
    assert.match(await panel.innerText(), /nicht direkt mit anderen Chats/);
    assert.match(await page.locator(".connection").innerText(), /Board mit CrewPip verbunden/);

    const alpha = panel.getByRole("group", { name: "demo-alpha" });
    assert.match(await alpha.innerText(), /2 von 3 Chats mit CrewPip verbunden/);

    // Grafik: Nabe CrewPip, jeder Chat als Speiche, Kante Codex → PM mit Anzahl.
    const graph = alpha.getByRole("img");
    const label = await graph.getAttribute("aria-label");
    assert.match(label ?? "", /demo-alpha/);
    assert.match(label ?? "", /CrewPip/);
    const svg = await graph.innerHTML();
    assert.match(svg, />CrewPip</);
    assert.equal(await graph.locator(".graph-spoke").count(), 3, "eine Speiche je Chat");
    assert.equal(await graph.locator(".graph-edge").count(), 1, "eine Kante für den Weg innerhalb des Repos");

    // Liste der Wege: Absender, Empfänger, Anzahl, letzter Zeitpunkt, kein Inhalt.
    const flows = alpha.getByRole("list", { name: "Nachrichtenwege der letzten 24 Stunden" });
    const text = await flows.innerText();
    assert.match(text, /Codex Umbau[\s\S]*→[\s\S]*PM demo-alpha[\s\S]*2 Nachrichten[\s\S]*zuletzt/);
    assert.match(text, /PM demo-alpha[\s\S]*→[\s\S]*Director[\s\S]*1 Nachricht/, "Weg zum Director in ein anderes Repo");
    assert.doesNotMatch(await page.locator("main").innerText(), /geheimer Befundtext/);

    // Anbieter: Name und Form, nicht nur Farbe.
    const claudeMark = alpha.locator(".app-mark[data-app=claude]").first();
    const codexMark = alpha.locator(".app-mark[data-app=codex]").first();
    assert.match(await claudeMark.innerText(), /Claude/);
    assert.match(await codexMark.innerText(), /Codex/);
    const shape = (l: typeof claudeMark) => l.locator("svg > *").first().evaluate(el => el.tagName);
    assert.notEqual(await shape(claudeMark), await shape(codexMark), "Claude und Codex mit unterschiedlicher Form");

    // Zustände mit Erklärung, per Tastatur erreichbar.
    const nohook = alpha.locator(".conn-apps").getByRole("listitem").filter({ hasText: "Alter Arbeitschat" });
    assert.match(await nohook.innerText(), /Ohne Hook/);
    const state = nohook.locator(".conn-state");
    await state.focus();
    assert.equal(await state.evaluate(el => el === document.activeElement), true, "Zustand ist fokussierbar");
    const tip = page.locator(`#${await state.getAttribute("aria-describedby")}`);
    assert.match(await tip.innerText(), /Post kommt nicht sicher von selbst an/);
    assert.equal(await tip.isVisible(), true, "Erklärung sichtbar bei Fokus");
    const pm = alpha.locator(".conn-apps").getByRole("listitem").filter({ hasText: "PM demo-alpha" });
    assert.match(await pm.innerText(), /Post kommt an/);

    if (process.env.CREWPIP_SCREENSHOT_DIR) await panel.screenshot({ path: `${process.env.CREWPIP_SCREENSHOT_DIR}/uebersicht-de.png` });
    await page.getByLabel("Sprache", { exact: true }).selectOption("en");
    const en = page.getByRole("region", { name: "Chats on CrewPip" });
    await en.waitFor();
    assert.match(await en.innerText(), /Messages arrive/);
    assert.match(await en.getByRole("group", { name: "demo-alpha" }).getByRole("list", { name: "Message paths in the last 24 hours" }).innerText(), /2 messages/);
  } finally { await page.close(); }
});
