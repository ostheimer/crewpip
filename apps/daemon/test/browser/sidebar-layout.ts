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
 * Akzeptanztest zu Issue #14: Die Projektliste der Seitenleiste zeigt auch bei niedrigem Fenster
 * (800 x 600) mindestens fünf Einträge vollständig, nichts überlappt, Sprach-/Darstellungsauswahl
 * und Hilfe bleiben erreichbar.
 */

let browser: Browser;
let daemon: DaemonHandle;
let url: string;
const token = randomUUID();

before(async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  const inbox = new Inbox(db, board);
  const runner = new Runner(db, board, { logDir: tmpdir() });
  runner.available = () => [];
  for (let i = 1; i <= 12; i++) {
    inbox.upsertSession({ id: `s${i}`, app: "claude", cwd: `/nirgends/projekt-${String(i).padStart(2, "0")}`, name: `Chat ${i}`, pid: process.pid, status: "idle" });
    inbox.setProcChain(`s${i}`, [{ pid: process.pid, comm: "claude" }]);
  }
  daemon = createDaemon(inbox, board, runner, {
    webDist: fileURLToPath(new URL("../../../web/dist/", import.meta.url)), token, log: () => {},
  });
  await new Promise<void>(resolve => daemon.server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); await daemon?.close(); });

for (const [width, height, minVisible] of [[800, 600, 6], [1024, 768, 7], [1440, 900, 8]] as const) {
  for (const locale of ["de-AT", "en-US"]) {
    test(`Seitenleiste ${width}x${height} (${locale}): Projektliste lesbar`, async () => {
      const page = await browser.newPage({ locale, viewport: { width, height } });
      try {
        await page.goto(url);
        await page.locator(".project-list .project-link").nth(1).waitFor();
        // Als String, weil tsx sonst Hilfsfunktionen (__name) einfügt, die im Browser fehlen.
        const m = await page.evaluate(`(() => {
          const rect = el => el.getBoundingClientRect();
          const list = document.querySelector(".project-list");
          const lr = rect(list);
          const links = [...list.querySelectorAll(".project-link")].map(rect);
          const fullyVisible = links.filter(r => r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5).length;
          // Überlappung: kein Bereich der Seitenleiste darf den nächsten überdecken.
          const kids = [...document.querySelector(".sidebar").children].map(rect);
          const reach = sel => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== "none"; };
          return {
            fullyVisible,
            overlaps: kids.some((a, i) => kids.slice(i + 1).some(b => a.height > 0 && b.height > 0 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5)),
            controls: reach(".language-select") && reach(".sidebar-bottom .text-button"),
          };
        })()`) as { fullyVisible: number; overlaps: boolean; controls: boolean };
        if (process.env.CREWPIP_SCREENSHOT_DIR && locale === "de-AT") await page.screenshot({ path: `${process.env.CREWPIP_SCREENSHOT_DIR}/sidebar-${width}x${height}.png` });
        assert.ok(m.fullyVisible >= minVisible, `nur ${m.fullyVisible} Einträge vollständig sichtbar, erwartet ${minVisible}`);
        assert.equal(m.overlaps, false, "Bereiche der Seitenleiste überlappen");
        assert.ok(m.controls, "Sprachauswahl oder Hilfe fehlen");
        // Erreichbar: per Scrollen in der Seitenleiste oder weil sie ohnehin sichtbar sind.
        await page.locator(".sidebar-bottom .text-button").scrollIntoViewIfNeeded();
        const help = await page.locator(".sidebar-bottom .text-button").boundingBox();
        assert.ok(help && help.y >= 0 && help.y + help.height <= height, "Hilfe liegt nach dem Scrollen nicht im Fenster");
      } finally { await page.close(); }
    });
  }
}
