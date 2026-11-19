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

let browser: Browser;
let daemon: DaemonHandle;
let url: string;
const token = randomUUID();

before(async () => {
  const db = openDb(":memory:");
  const board = new Board(db);
  const runner = new Runner(db, board, { logDir: tmpdir() });
  runner.available = () => [];
  daemon = createDaemon(new Inbox(db, board), board, runner, {
    webDist: fileURLToPath(new URL("../../../web/dist/", import.meta.url)), token, log: () => {},
  });
  await new Promise<void>(resolve => daemon.server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); await daemon?.close(); });

test("empty board and guide link to setup and first delivery in the selected language", async () => {
  const page = await browser.newPage({ locale: "en-US" });
  try {
    await page.goto(url);
    await page.getByRole("heading", { name: "What's next?" }).waitFor();
    const connect = page.getByRole("link", { name: "Connect your first chat" });
    assert.equal(await connect.count(), 1);
    assert.equal(await connect.getAttribute("href"), "https://github.com/ostheimer/crewpip/blob/main/README.md#connect-your-first-chat");
    await page.getByRole("button", { name: "What can I do here?" }).click();
    await connect.waitFor();
    assert.equal(await page.getByRole("link", { name: "Deliver your first message" }).getAttribute("href"), "https://github.com/ostheimer/crewpip/blob/main/README.md#deliver-your-first-message");
    await page.getByLabel("Language", {exact:true}).selectOption("de");
    assert.equal(await page.getByRole("link", { name: "Ersten Chat verbinden" }).getAttribute("href"), "https://github.com/ostheimer/crewpip/blob/main/README.de.md#den-ersten-chat-verbinden");
    assert.equal(await page.getByRole("link", { name: "Erste Nachricht zustellen" }).getAttribute("href"), "https://github.com/ostheimer/crewpip/blob/main/README.de.md#die-erste-nachricht-zustellen");
  } finally { await page.close(); }
});

test("switching language preserves the default sender's address and an open draft", async () => {
  const page = await browser.newPage({ locale: "de-AT" });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Director schreiben", exact: true }).click();
    const text = "Ein Entwurf — one draft";
    await page.getByRole("textbox", { name: "Nachricht", exact: true }).fill(text);
    await page.getByLabel("Sprache", {exact:true}).selectOption("en");
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), text);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Message saved.", { exact: false }).waitFor();
    const response = await fetch(url + "/api/messages", { headers: { "x-crewpip-token": token } });
    const message = (await response.json()).find((item: {text: string}) => item.text === text);
    assert.equal(message.replyTo, "human:Mensch");
    assert.equal(message.from.name, "Mensch");
    await page.reload();
    await page.getByRole("heading", { name: "What's next?" }).waitFor();
  } finally { await page.close(); }
});

test("connection errors use the selected language and preserve unsent text", async () => {
  const page = await browser.newPage({ locale: "de-AT" });
  try {
    await page.goto(url);
    await page.getByRole("heading", { name: "Was steht an?" }).waitFor();
    await page.getByRole("button", { name: "Director schreiben", exact: true }).click();
    await page.getByRole("textbox", { name: "Nachricht", exact: true }).fill("Mein Entwurf");
    await page.route("**/api/messages", route => route.abort("failed"));
    await page.getByRole("button", { name: "Nachricht senden", exact: true }).click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    assert.match(await alert.innerText(), /Senden fehlgeschlagen\. Dein Text bleibt erhalten\./);
    assert.equal(await page.getByRole("textbox", { name: "Nachricht", exact: true }).inputValue(), "Mein Entwurf");
    await page.reload();
    await alert.waitFor();
    assert.match(await alert.innerText(), /Verbindung fehlgeschlagen\. Bitte die Seite neu laden\./);
    await page.getByLabel("Sprache", {exact:true}).selectOption("en");
    assert.match(await alert.innerText(), /Connection failed\. Please reload the page\./);
  } finally { await page.close(); }
});
