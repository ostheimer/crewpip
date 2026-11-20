import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = new URL("../../../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

// Werte, die Erklärseite und Doku nennen, kommen aus dem Code und nicht aus dem Gedächtnis.
const config = read("apps/daemon/src/config.ts");
const MAX_STOP = Number(config.match(/CREWPIP_MAX_STOP_CONTINUATIONS \?\? (\d+)/)[1]);
const MAX_WAIT = Number(config.match(/CREWPIP_MAX_WAIT_SECONDS \?\? (\d+)/)[1]);
const PORT = Number(config.match(/CREWPIP_PORT \?\? (\d+)/)[1]);
const ADDRESSES = ["session:", "pm:", "director", "project:", "all"];

async function withBoard(language, fn) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "silent" });
  const storage = { getItem: key => (key === "crewpip.language" ? language : null) };
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage, navigator: globalThis.navigator };
  try {
    await fn(server);
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    await server.close();
  }
}

for (const [language, nav, headings] of [
  ["de", "So funktioniert CrewPip", ["Aufbau", "Zustellwege", "Adressen", "Zustände", "Grenzen"]],
  ["en", "How CrewPip works", ["Building blocks", "Delivery paths", "Addresses", "States", "Limits"]],
]) {
  test(`Erklärseite (${language}): eigener Menüpunkt, alle Abschnitte, Grafik, Werte aus dem Code`, async () => {
    await withBoard(language, async server => {
      const { App } = await server.ssrLoadModule("/src/App.tsx");
      const board = renderToStaticMarkup(React.createElement(App));
      const navBlock = board.slice(board.indexOf('class="primary-nav"'), board.indexOf("</nav>"));
      assert.ok(navBlock.includes(nav), `Menüpunkt „${nav}“ fehlt in der Hauptnavigation`);

      const { Guide } = await server.ssrLoadModule("/src/Guide.tsx");
      const { LanguageProvider } = await server.ssrLoadModule("/src/language.tsx");
      const html = renderToStaticMarkup(React.createElement(LanguageProvider, null, React.createElement(Guide, { onWrite() {}, onTasks() {} })));
      for (const h of headings) assert.match(html, new RegExp(`<h2[^>]*>${h}</h2>`), `Abschnitt ${h} fehlt`);
      for (const a of ADDRESSES) assert.ok(html.includes(`<code>${a}`), `Adresse ${a} fehlt`);
      assert.match(html, /class="flow-diagram" role="img" aria-label="[^"]*post_message/, "Grafik des Nachrichtenflusses fehlt");
      assert.ok(html.includes(`${language === "de" ? "höchstens" : "at most"} ${MAX_STOP} `), "Schleifensperre nennt nicht den Wert aus config.ts");
      // Zustandsnamen wie in der Übersicht, damit man sie dort wiederfindet.
      const { [language]: copy } = await server.ssrLoadModule(`/src/locales/${language}.ts`);
      for (const label of Object.values(copy.connectionState)) assert.ok(html.includes(`<dt>${label}</dt>`), `Zustand ${label} fehlt oder heißt anders als in der Übersicht`);
      assert.ok(html.includes(`${MAX_WAIT} s`), "wait_for_message nennt nicht die Obergrenze aus config.ts");
      for (const tool of ["post_message", "read_inbox", "wait_for_message", "UserPromptSubmit"]) assert.ok(html.includes(tool), `${tool} fehlt`);
    });
  });
}

for (const [file, readme, headings] of [
  ["docs/kommunikation.md", "README.de.md", ["Aufbau", "Zustellwege", "Adressen", "Zustände", "Grenzen"]],
  ["docs/communication.md", "README.md", ["Building blocks", "Delivery paths", "Addresses", "States", "Limits"]],
]) {
  test(`Doku ${file}: vorhanden, verlinkt, Werte aus dem Code`, () => {
    assert.ok(existsSync(new URL(file, root)), `${file} fehlt`);
    const doc = read(file);
    assert.ok(read(readme).includes(`](${file})`), `${readme} verlinkt ${file} nicht`);
    for (const h of headings) assert.match(doc, new RegExp(`^## ${h}`, "m"), `Abschnitt ${h} fehlt`);
    for (const a of ADDRESSES) assert.ok(doc.includes(`\`${a}`), `Adresse ${a} fehlt`);
    assert.ok(doc.includes(`127.0.0.1:${PORT}`));
    assert.match(doc, new RegExp(`CREWPIP_MAX_STOP_CONTINUATIONS[^\\n]*${MAX_STOP}`));
    assert.match(doc, new RegExp(`${MAX_WAIT} s`));
    assert.ok(doc.includes("verbindung.md"), "Verweis auf die Verbindungsregel fehlt");
    const locale = read(`apps/web/src/locales/${file.endsWith("kommunikation.md") ? "de" : "en"}.ts`);
    const labels = [...locale.match(/connectionState: \{([^}]*)\}/)[1].matchAll(/: "([^"]+)"/g)].map(m => m[1]);
    assert.equal(labels.length, 5);
    for (const label of labels) assert.ok(doc.includes(`| ${label} |`), `Zustand ${label} fehlt oder heißt anders als im Board`);
  });
}
