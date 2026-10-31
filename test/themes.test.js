import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES } from '../src/config.js';

const css = readFileSync(new URL('../public/css/themes.css', import.meta.url), 'utf8');
const overlayCss = readFileSync(new URL('../public/css/overlay.css', import.meta.url), 'utf8');

export const REQUIRED_TOKENS = [
  'font-display', 'font-body',
  'panel-bg', 'panel-bg-2', 'panel-border', 'panel-border-width', 'panel-border-style', 'panel-radius', 'panel-shadow', 'ornament',
  'text', 'text-muted', 'accent', 'accent-2', 'accent-text',
  'banner-bg', 'banner-bg-2', 'banner-text', 'banner-border',
  'combo-bg', 'combo-color', 'combo-label',
  'rank-1', 'rank-2', 'rank-3', 'rank-text',
  'ticker-bg', 'ticker-text', 'ticker-name',
  'particle-1', 'particle-2', 'particle-3', 'glow',
];

/** Parse `html[data-theme='x'] { --a: b; }` blocks into { x: { a: 'b' } }. */
function parseThemes(src) {
  const out = {};
  const blockRe = /([^{}]+)\{([^}]*)\}/g;
  for (const [, selector, body] of src.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(blockRe)) {
    const names = [...selector.matchAll(/data-theme='(\w+)'/g)].map((m) => m[1]);
    const tokens = Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    for (const n of names) out[n] = { ...(out[n] ?? {}), ...tokens };
  }
  return out;
}

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `expected opaque #rrggbb, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const themes = parseThemes(css);

// Foreground/background pairs actually rendered together in overlay.css.
const PAIRS = [
  ['text', 'panel-bg'], ['text', 'panel-bg-2'],
  ['text-muted', 'panel-bg'], ['text-muted', 'panel-bg-2'],
  ['accent-2', 'panel-bg'], ['accent-2', 'panel-bg-2'],
  ['accent-text', 'accent'],
  ['banner-text', 'banner-bg'], ['banner-text', 'banner-bg-2'],
  ['combo-color', 'combo-bg'], ['combo-label', 'combo-bg'],
  ['rank-text', 'rank-1'], ['rank-text', 'rank-2'], ['rank-text', 'rank-3'],
  ['ticker-text', 'ticker-bg'], ['ticker-name', 'ticker-bg'],
];

test('contrast helper matches WCAG reference values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48');
});

test('at least three themes exist and match server whitelist', () => {
  assert.deepEqual(Object.keys(themes).sort(), [...THEMES].sort());
  assert.ok(THEMES.length >= 3);
});

for (const name of THEMES) {
  test(`theme "${name}" defines every required token`, () => {
    const missing = REQUIRED_TOKENS.filter((t) => !themes[name]?.[t]);
    assert.deepEqual(missing, []);
  });

  test(`theme "${name}" keeps text contrast >= 4.5:1`, () => {
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(themes[name][fg], themes[name][bg]);
      assert.ok(ratio >= 4.5, `${name}: --${fg} on --${bg} = ${ratio.toFixed(2)}:1`);
    }
  });
}

test('overlay CSS is OBS-safe: transparent bg, no backdrop-filter, no web fonts, no external URLs', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const all = strip(css + overlayCss);
  assert.doesNotMatch(all, /backdrop-filter/);
  assert.doesNotMatch(all, /@font-face|@import|url\(/);
  assert.match(overlayCss, /background:\s*transparent/);
  assert.match(overlayCss, /overflow:\s*hidden/);
  // Keyframes only animate transform / opacity.
  for (const [, body] of overlayCss.matchAll(/@keyframes[^{]+\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)) {
    const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(props)].filter((p) => p !== 'transform' && p !== 'opacity'), []);
  }
});
