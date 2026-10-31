import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BannerQueue, BANNER_QUEUE_CAP, BANNER_MS } from '../public/js/banner-queue.js';
import { renderTemplate, bannerVars, ordinal, DEFAULT_TEMPLATE } from '../public/js/template.js';
import { tierFor, particleCount, MAX_PARTICLES_PER_BURST } from '../public/js/tiers.js';

test('banner queue shows one at a time, ~4s each, in order', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const shown = [];
  const q = new BannerQueue({ show: (b) => shown.push(b) });
  q.push('a');
  q.push('b');
  assert.deepEqual(shown, ['a']);
  ctx.mock.timers.tick(BANNER_MS - 1);
  assert.deepEqual(shown, ['a'], 'no overlap before 4s');
  ctx.mock.timers.tick(1);
  assert.deepEqual(shown, ['a', 'b']);
  q.clear();
});

test('banner queue drops stale banners when more than 6 are waiting', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const shown = [];
  const q = new BannerQueue({ show: (b) => shown.push(b) });
  for (let i = 0; i < 10; i++) q.push(i); // 0 on screen, 1..9 waiting -> 3 oldest dropped
  assert.equal(BANNER_QUEUE_CAP, 6);
  assert.equal(q.size, 6);
  assert.equal(q.dropped, 3);
  for (let i = 0; i < 10; i++) ctx.mock.timers.tick(BANNER_MS);
  assert.deepEqual(shown, [0, 4, 5, 6, 7, 8, 9]);
});

test('template supports {user} {gift} {count} {unit} and friends', () => {
  const ev = { user: { name: 'Linh' }, gift: { name: 'Rose', count: 18, comboCount: 5, diamondTotal: 5 } };
  const vars = bannerVars(ev);
  assert.equal(renderTemplate('{user} tặng {gift} {unit} — lần thứ {count}', vars), 'Linh tặng Rose ×5 — lần thứ 18');
  assert.equal(renderTemplate(DEFAULT_TEMPLATE, vars), 'Linh sent Rose ×5 · 18th time');
  assert.equal(renderTemplate('{nope} {diamonds}', vars), '{nope} 5', 'unknown vars untouched');
  assert.equal(renderTemplate('{constructor}', vars), '{constructor}', 'no prototype leakage');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '111th']);
});

test('gift tier and particle intensity scale with diamond value', () => {
  assert.equal(tierFor(1), 'petals');
  assert.equal(tierFor(20), 'sparkle');
  assert.equal(tierFor(299), 'rain');
  assert.equal(tierFor(29999), 'mega');
  assert.ok(particleCount(1) < particleCount(30));
  assert.ok(particleCount(30) < particleCount(1000));
  assert.equal(particleCount(10_000_000), MAX_PARTICLES_PER_BURST);
});
