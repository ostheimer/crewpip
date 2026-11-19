import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Prüft die Farb-Tokens aus src/theme.css gegen WCAG 2.1 AA (Text 4.5:1, Bedienelemente/Rahmen 3:1).
const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

const tokens = (block, base = {}) => {
  const t = { ...base };
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) t[m[1]] = m[2];
  return t;
};
const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TEXT_PAIRS = [
  ["text", "bg"], ["text", "panel"], ["muted", "bg"], ["muted", "panel"], ["muted", "accent-bg"], ["text", "accent-bg"],
  ["accent", "bg"], ["accent", "panel"], ["accent", "accent-bg"], ["on-accent", "accent-solid"],
  ["danger", "bg"], ["danger", "panel"], ["attention-fg", "panel"], ["attention-fg", "bg"],
  ["warn-fg", "warn-bg"], ["error-fg", "error-bg"], ["ok-fg", "ok-bg"],
  ["connected", "panel"], ["connected", "bg"], ["no-hook", "panel"], ["no-hook", "bg"],
  ["claude-fg", "claude-bg"], ["codex-fg", "codex-bg"], ["cursor-fg", "cursor-bg"], ["human-fg", "human-bg"],
];
const UI_PAIRS = [["border-strong", "panel"], ["border-strong", "bg"], ["focus", "bg"], ["focus", "panel"], ["brass", "panel"], ["brass", "bg"], ["attention-line", "panel"], ["attention-line", "bg"]];

for (const [name, block] of [["hell", light], ["dunkel", dark]]) {
  const t = tokens(block, name === "dunkel" ? tokens(light) : {});
  test(`Textkontrast AA (${name})`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      assert.ok(t[fg] && t[bg], `Token fehlt: ${fg}/${bg}`);
      assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${fg} ${t[fg]} auf ${bg} ${t[bg]}: ${ratio(t[fg], t[bg]).toFixed(2)} < 4.5`);
    }
  });
  test(`Bedienelement-Kontrast 3:1 (${name})`, () => {
    for (const [fg, bg] of UI_PAIRS) assert.ok(ratio(t[fg], t[bg]) >= 3, `${fg} auf ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)} < 3`);
  });
}
test("keine Netz-Abhängigkeiten in den Stilen", () => {
  for (const f of ["../src/theme.css", "../src/styles.css"]) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /https?:\/\/(?!www\.w3\.org)/);
});
