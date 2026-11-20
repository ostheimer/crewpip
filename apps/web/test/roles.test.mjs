import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { sessions, projects, flows } from "./fixture.mjs";

// Akzeptanztest Issue #28: Rollenkonflikt in der Projektzeile, Rollenwechsel erklärt.

const root = new URL("../../../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

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

const holder = sessions.find(s => s.name === "PM billing");
const claimant = { ...sessions.find(s => s.name === "#3 Mahnungen"), name: "PM billing", roleConflict: { role: "pm", holderId: holder.id, holderLabel: holder.label } };
const withConflict = sessions.map(s => (s.id === claimant.id ? claimant : s));

for (const language of ["de", "en"]) {
  test(`#28 Übersicht (${language}): Rollenkonflikt steht in der Projektzeile`, async () => {
    await withModules(language, async server => {
      const { buildMatrix } = await server.ssrLoadModule("/src/matrix.ts");
      const row = buildMatrix(withConflict, projects, null).rows.find(r => r.name === "billing");
      assert.deepEqual(row.conflicts?.map(s => s.id), [claimant.id]);
      assert.equal(row.pm.id, holder.id, "der Inhaber bleibt PM");
      assert.deepEqual(buildMatrix(sessions, projects, null).rows.find(r => r.name === "billing").conflicts, []);

      const { Connections } = await server.ssrLoadModule("/src/Connections.tsx");
      const { LanguageProvider } = await server.ssrLoadModule("/src/language.tsx");
      const { [language]: copy } = await server.ssrLoadModule(`/src/locales/${language}.ts`);
      const html = renderToStaticMarkup(React.createElement(LanguageProvider, null, React.createElement(Connections, { sessions: withConflict, projects, projectId: null, flows })));
      const billing = html.slice(html.indexOf('data-repo="billing"'), html.indexOf("</tbody>", html.indexOf('data-repo="billing"')));
      assert.ok(billing.includes("repo-conflict"), "Konfliktmarke in der Zeile");
      assert.ok(billing.includes(copy.roleConflictBadge), "Konflikt in Worten, nicht nur als Symbol");
      assert.equal((html.match(/repo-conflict/g) ?? []).length, 1, "nur die betroffene Zeile");
      assert.equal(typeof copy.roleConflictText, "function");
      assert.match(copy.roleConflictText("PM billing", "Codex", "PM", "Claude · billing / PM billing"), /PM billing/);
    });
  });
}

test("#28 Erklärseite und Doku: Rollenwechsel mit set_role beschrieben (de/en)", async () => {
  for (const language of ["de", "en"]) {
    await withModules(language, async server => {
      const { [language]: copy } = await server.ssrLoadModule(`/src/locales/${language}.ts`);
      assert.ok(copy.guide.rolesTitle, "eigener Abschnitt zu Rollen");
      assert.match(copy.guide.roles.map(([a, b]) => `${a} ${b}`).join(" "), /set_role/);
      const { Guide } = await server.ssrLoadModule("/src/Guide.tsx");
      const { LanguageProvider } = await server.ssrLoadModule("/src/language.tsx");
      const html = renderToStaticMarkup(React.createElement(LanguageProvider, null, React.createElement(Guide, { onWrite() {}, onTasks() {} })));
      assert.ok(html.includes(copy.guide.rolesTitle));
      assert.ok(html.includes("set_role"));
    });
  }
  for (const file of ["docs/rollen.md", "docs/roles.md"]) {
    const doc = read(file);
    assert.match(doc, /set_role/, file);
    assert.match(doc, /role_changes|protokoll|log/i, file);
  }
});
