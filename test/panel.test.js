// Static checks on the beginner panel: 3 steps, copy button, theme cards, no
// template artifacts, accessible labels and AA contrast for panel colors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES } from '../src/config.js';

const html = readFileSync(new URL('../public/panel.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/panel.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/js/panel.js', import.meta.url), 'utf8');
const text = html.replace(/<!--[\s\S]*?-->/g, '');

test('panel shows the three numbered step headings in Vietnamese', () => {
  assert.match(text, /<html lang="vi">/);
  const steps = [...text.matchAll(/<h2[^>]*class="step__title"[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(steps, ['1BƯỚC 1 — Nhập tên TikTok của bạn', '2BƯỚC 2 — Chọn giao diện', '3BƯỚC 3 — Dán vào OBS']);
});

test('step 1 has a labelled username input, connect, retry and a test-gift button', () => {
  assert.match(text, /<label for="username"/);
  assert.match(text, /<input id="username"/);
  assert.match(text, /<button type="submit" id="connect"[^>]*>Kết nối<\/button>/);
  assert.match(text, /<button type="button" id="retry"[^>]*hidden>Thử lại<\/button>/);
  assert.match(text, /id="test-gift"[^>]*>🎁 Bắn thử một món quà<\/button>/);
  const step1 = text.slice(text.indexOf('id="step-1"'), text.indexOf('id="step-2"'));
  assert.ok(step1.includes('id="test-gift"'), 'test button lives in step 1');
  assert.doesNotMatch(step1.match(/<button[^>]*id="test-gift"[^>]*>/)[0], /disabled|hidden/, 'usable without connecting');
});

test('step 2 has one clickable theme card per theme with a preview thumbnail', () => {
  for (const t of THEMES) {
    assert.match(text, new RegExp(`<label class="theme-card" data-theme="${t}">\\s*<input type="radio" name="theme" value="${t}" />\\s*<span class="thumb thumb--${t}"`), t);
    assert.match(css, new RegExp(`\\.thumb--${t}\\s*\\{`), `${t} preview colors`);
  }
  for (const name of ['Chùa', 'Neon', 'Tết']) assert.ok(text.includes(`<span class="theme-card__name">${name}</span>`), name);
});

test('step 3 has a read-only URL box with a copy button and the 4 OBS steps', () => {
  assert.match(text, /<label for="overlay-url"/);
  assert.match(text, /<input id="overlay-url"[^>]*readonly/);
  assert.match(text, /<button type="button" id="copy"[^>]*>Sao chép<\/button>/);
  const obs = /<ol class="obs-steps">([\s\S]*?)<\/ol>/.exec(text)[1];
  const items = [...obs.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  assert.equal(items.length, 4);
  assert.match(items[0], /Nguồn/);
  assert.match(items[1], /Trình duyệt/);
  assert.match(items[2], /URL/);
  assert.match(items[3], /1080.*1920/);
  assert.match(text, /<summary>Mở hướng dẫn OBS chi tiết<\/summary>/);
  assert.match(js, /navigator\.clipboard\.writeText/);
  assert.match(js, /execCommand\('copy'\)/, 'clipboard fallback');
});

test('advanced section is collapsed and keeps the old controls', () => {
  assert.match(text, /<details class="advanced" id="advanced">\s*<summary>Nâng cao<\/summary>/);
  const adv = text.slice(text.indexOf('id="advanced"'));
  for (const id of ['template', 'topN', 'ticker', 'muted', 'gift', 'send-gift', 'mock-start', 'mock-stop', 'clear', 'log']) {
    assert.ok(adv.includes(`id="${id}"`), id);
  }
});

test('no raw template artifacts or English UI left in the markup', () => {
  assert.doesNotMatch(text, /[{}]/, 'no { or } in panel HTML');
  assert.doesNotMatch(text, /\$\{|undefined|null|NaN/);
  for (const english of ['Connect', 'Disconnect', 'Send test gift', 'Clear session', 'Live event log', 'Theme']) {
    assert.ok(!new RegExp(`>\\s*${english}`).test(text), english);
  }
});

test('every form control has a label', () => {
  const controls = [...text.matchAll(/<(input|select)\b([^>]*)>/g)];
  for (const [tag, , attrs] of controls) {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const wrapped = /type="(radio|checkbox)"/.test(attrs); // wrapped in <label>
    assert.ok(wrapped || (id && text.includes(`for="${id}"`)), `unlabelled control: ${tag}`);
  }
});

test('panel colors meet WCAG AA (>= 4.5:1) and focus rings exist', () => {
  const vars = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const pairs = [
    ['text', 'bg'], ['text', 'card'], ['muted', 'card'], ['muted', 'bg'],
    ['on-primary', 'primary'], ['on-primary', 'primary-hover'], ['on-gift', 'gift'],
    ['ok', 'card'], ['busy', 'card'], ['err', 'card'], ['primary', 'card'], ['focus', 'card'],
  ];
  for (const [fg, bg] of pairs) {
    const r = ratio(vars[fg], vars[bg]);
    assert.ok(r >= 4.5, `--${fg} on --${bg} = ${r.toFixed(2)}:1`);
  }
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*3px solid/);
});
