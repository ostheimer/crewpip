import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { sessions, projects, flows } from "./fixture.mjs";

// Akzeptanztest Issue #22: Matrix Repo × App statt großer Karten je Repo.

async function withModules(language, fn) {
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

test("Matrix-Ableitung: Zeilen je Repo, Spalten nur für vorkommende Apps, Namen unverändert", async () => {
  await withModules("de", async server => {
    const { buildMatrix } = await server.ssrLoadModule("/src/matrix.ts");
    const m = buildMatrix(sessions, projects, null);
    assert.deepEqual(m.apps, ["claude", "codex", "cursor", "antigravity"]);
    assert.equal(m.rows.length, 14);
    assert.deepEqual(m.rows.map(r => r.name), [...m.rows.map(r => r.name)].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(m.withoutChat.map(p => p.name), ["archiv-demo"]);
    const ex = m.rows.find(r => r.name === "example.org");
    // Verbundene Chats vor veralteten; Namen exakt aus dem Feld `name`.
    assert.deepEqual(ex.cells.codex.map(s => [s.name, s.connection]), [["#13 Rechnungen prüfen", "connected"], ["#14 Seed-Daten", "stale"]]);
    assert.equal(ex.pm.name, "PM example.org");
    assert.equal(ex.alert, false);
    // PM ohne Hook hebt die Zeile hervor, ein Worker ohne Hook nicht.
    assert.equal(m.rows.find(r => r.name === "shop-api").alert, true);
    assert.equal(m.rows.find(r => r.name === "billing").alert, false);
    // Ohne Cursor und Antigravity entfallen deren Spalten; beendete Chats zählen nicht.
    const reduced = sessions.filter(s => s.app === "claude" || s.app === "codex").map(s => s.name === "#9 Import" ? { ...s, connection: "ended" } : s);
    const r = buildMatrix(reduced, projects, null);
    assert.deepEqual(r.apps, ["claude", "codex"]);
    assert.equal(r.rows.some(x => x.name === "data-pipeline"), false);
    assert.equal(buildMatrix(sessions, projects, "p-billing").rows.length, 1);
  });
});

for (const [language, title, labels] of [
  ["de", "Chats an CrewPip", { connected: "Post kommt an", noHook: "Ohne Hook", stale: "Veraltet" }],
  ["en", "Chats on CrewPip", { connected: "Messages arrive", noHook: "Without hook", stale: "Stale" }],
]) {
  test(`Übersicht (${language}): kompakte Matrix, Details und Erklärtexte zugeklappt`, async () => {
    await withModules(language, async server => {
      const { Connections } = await server.ssrLoadModule("/src/Connections.tsx");
      const { LanguageProvider } = await server.ssrLoadModule("/src/language.tsx");
      const { [language]: copy } = await server.ssrLoadModule(`/src/locales/${language}.ts`);
      const html = renderToStaticMarkup(React.createElement(LanguageProvider, null, React.createElement(Connections, { sessions, projects, projectId: null, flows })));
      assert.match(html, new RegExp(`<h2[^>]*>${title}</h2>`));
      assert.match(html, /<table class="conn-matrix"/);
      assert.equal((html.match(/<tbody class="matrix-repo/g) ?? []).length, 14, "eine Zeile je Repo");
      assert.equal((html.match(/<th scope="col"><span class="app-mark/g) ?? []).length, 4, "eine Spalte je vorkommender App");
      // Ein Symbol je Chat, Zustand als Form (data-state) und im Namen, nicht nur als Farbe.
      assert.equal((html.match(/data-chat="/g) ?? []).length, sessions.length);
      for (const state of ["connected", "no-hook", "stale"]) assert.ok(html.includes(`data-state="${state}"`), state);
      assert.ok(html.includes(`aria-label="PM shop-api, Claude, PM, ${labels.noHook}"`), "Name, App, Rolle, Zustand am Symbol");
      assert.ok(html.includes(">PM</span>") && html.includes(">D</span>"), "Kürzel für PM und Director");
      assert.ok(html.includes("matrix-alert"), "Zeile mit PM ohne Hook hervorgehoben");
      assert.ok(html.includes("<code>session:"), "Adresse im Hinweis");
      // Standard zugeklappt: keine Chatlisten, Wege, Grafik; Erklärtexte nur hinter dem Info-Knopf.
      assert.equal(html.includes("matrix-detail"), false);
      assert.equal(html.includes("conn-graph"), false);
      assert.equal(html.includes(copy.connectionsIntro), false, "Erklärtext sichtbar statt hinter dem Info-Knopf");
      assert.ok(html.includes(`aria-label="${copy.matrixInfoLabel}"`) && html.includes('aria-expanded="false"'));
      assert.equal((html.match(/aria-expanded="false" aria-controls="repo-/g) ?? []).length, 14);
      for (const l of Object.values(labels)) assert.ok(html.includes(l), `Legende nennt ${l}`);
      assert.ok(html.includes("archiv-demo"), "Repo ohne Chat bleibt genannt");
    });
  });
}
