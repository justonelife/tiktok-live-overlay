import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ComboTracker } from '../src/combo.js';
import { parseRaw } from '../src/normalize.js';
import { OverlayEngine } from '../src/engine.js';

const silent = { warn() {}, error() {} };
const gift = (userId, repeatCount, extra = {}) =>
  parseRaw({
    type: 'gift',
    user: { id: userId, name: userId },
    gift: { id: '5655', name: 'Rose', diamond: 1, repeatCount, ...extra },
  });

function tracker() {
  const finals = [];
  const progress = [];
  const t = new ComboTracker({
    quietMs: 1500,
    now: () => Date.now(),
    onFinalize: (f) => finals.push(f),
    onProgress: (p) => progress.push(p.comboCount),
  });
  return { t, finals, progress };
}

test('a streak collapses into one finalized gift on repeatEnd', () => {
  const { t, finals, progress } = tracker();
  assert.equal(t.push(gift('a', 1)), 'pending');
  assert.equal(t.push(gift('a', 2)), 'pending');
  assert.equal(t.push(gift('a', 5)), 'pending');
  assert.equal(t.push(gift('a', 5, { repeatEnd: true })), 'finalized');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].comboCount, 5);
  assert.deepEqual(progress, [1, 2, 5]);
  t.reset();
});

test('quiet window finalizes after 1500ms without updates', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { t, finals } = tracker();
  t.push(gift('a', 1));
  ctx.mock.timers.tick(1000);
  t.push(gift('a', 2));
  ctx.mock.timers.tick(1499);
  assert.equal(finals.length, 0, 'timer resets on each update');
  ctx.mock.timers.tick(1);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].comboCount, 2);
  // Trailing repeatEnd after the quiet window must not double count.
  assert.equal(t.push(gift('a', 2, { repeatEnd: true })), 'duplicate');
  assert.equal(finals.length, 1);
});

test('dedupe key is giftId + userId: parallel streaks stay separate', () => {
  const { t, finals } = tracker();
  t.push(gift('a', 1));
  t.push(gift('b', 1));
  t.push(gift('a', 2));
  t.push(parseRaw({ type: 'gift', user: { id: 'a' }, gift: { id: '9999', diamond: 5, repeatCount: 1 } }));
  t.flushAll();
  const byKey = Object.fromEntries(finals.map((f) => [`${f.parsed.user.id}|${f.parsed.gift.id}`, f.comboCount]));
  assert.deepEqual(byKey, { 'a|5655': 2, 'b|5655': 1, 'a|9999': 1 });
});

test('exact duplicate msgId is dropped; non-streakable finalizes immediately', () => {
  const { t, finals } = tracker();
  const p = parseRaw({ type: 'gift', msgId: 'm1', user: { id: 'a' }, gift: { id: '11046', diamond: 1000, streakable: false } });
  assert.equal(t.push(p), 'finalized');
  assert.equal(t.push(p), 'duplicate');
  assert.equal(finals.length, 1);
});

test('sources without cumulative counts (repeatCount=1 each) still accumulate', () => {
  const { t, finals } = tracker();
  for (let i = 0; i < 4; i++) t.push(gift('a', 1));
  t.push(gift('a', 1, { repeatEnd: true }));
  assert.equal(finals[0].comboCount, 5);
});

test('engine emits combo progress, then one gift event + leaderboard', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const engine = new OverlayEngine({ logger: silent });
  const kinds = [];
  let gEvent;
  engine.on('message', (m) => {
    kinds.push(m.kind);
    if (m.kind === 'event') gEvent = m.data;
  });
  for (let i = 1; i <= 3; i++) engine.ingest({ type: 'gift', user: { id: 'u1', name: 'Linh' }, gift: { id: '5487', name: 'Finger Heart', diamond: 5, repeatCount: i } });
  ctx.mock.timers.tick(1500);
  assert.deepEqual(kinds, ['combo', 'combo', 'combo', 'event', 'leaderboard']);
  assert.deepEqual(gEvent.gift, { id: '5487', name: 'Finger Heart', count: 1, comboCount: 3, diamondTotal: 15 });
});
