import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Prüft die Farb-Tokens aus src/theme.css gegen WCAG 2.1 AA (Text 4.5:1, Bedienelemente/Rahmen 3:1).
const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const lightStart = css.indexOf(':root[data-theme="light"]');
const dark = css.slice(0, lightStart);
const light = css.slice(lightStart, css.indexOf("@media (prefers-color-scheme: light)"));
const systemLight = css.slice(css.indexOf("@media (prefers-color-scheme: light)"));

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
  ["connected", "panel"], ["attention-fg", "accent-bg"], ["warn-fg", "panel"], ["on-accent", "accent"], ["connected", "bg"], ["no-hook", "panel"], ["no-hook", "bg"],
  ["claude-fg", "claude-bg"], ["codex-fg", "codex-bg"], ["cursor-fg", "cursor-bg"], ["human-fg", "human-bg"],
];
const UI_PAIRS = [["border-strong", "panel"], ["border-strong", "bg"], ["focus", "bg"], ["focus", "panel"], ["frame", "panel"], ["frame", "bg"], ["attention-line", "panel"], ["attention-line", "bg"]];

for (const [name, block] of [["dunkel", dark], ["hell", light], ["System hell", systemLight]]) {
  const t = tokens(block, name === "dunkel" ? {} : tokens(dark));
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

test("System-Hell und Hell definieren dieselben Farben", () => {
  const l = tokens(light), s = tokens(systemLight);
  for (const k of Object.keys(l)) assert.equal(s[k], l[k], `Token ${k} weicht ab`);
});
test("Fließtext mindestens 15 px, keine Animationen, Effekte aus bei reduzierter Bewegung", () => {
  assert.match(styles, /body \{[^}]*font-size: 16px/);
  assert.doesNotMatch(styles, /@keyframes|animation\s*:|transition\s*:/);
  assert.match(styles, /prefers-reduced-motion: reduce\) \{[^}]*--glow: none[^}]*--scanlines: none/);
});
test("Glühen steht nicht auf Fließtext-Selektoren", () => {
  const withTextShadow = [...styles.matchAll(/([^{}]+)\{[^}]*text-shadow:\s*var\(--text-glow\)/g)].map(m => m[1].trim());
  for (const sel of withTextShadow) assert.match(sel, /^(h1|h2|\.brand|\.stat strong)/, `Glühen auf ${sel}`);
});
test("kleine Bedienelemente und Warntexte unterschreiten die Mindestgrößen nicht", () => {
  const layer = styles.slice(styles.indexOf("Retro-Terminal-Schicht"));
  for (const [sel, min] of [[".warn", 15], [".section-heading .text-button", 13], [".all-projects", 13]]) {
    const m = [...layer.matchAll(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*font-size:\\s*(\\d+)px`, "g"))];
    assert.ok(m.length && Number(m.at(-1)[1]) >= min, `${sel} < ${min}px`);
  }
});
