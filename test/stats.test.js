import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStats } from '../src/stats.js';
import { OverlayEngine } from '../src/engine.js';

const u = (id) => ({ id, name: id.toUpperCase(), avatarUrl: '' });

test('per-user per-gift Nth-time counter', () => {
  const s = new SessionStats();
  for (let i = 1; i <= 18; i++) assert.equal(s.bumpGiftCount('u1', 'rose'), i);
  assert.equal(s.bumpGiftCount('u1', 'heart'), 1, 'independent per gift');
  assert.equal(s.bumpGiftCount('u2', 'rose'), 1, 'independent per user');
  assert.equal(s.giftCount('u1', 'rose'), 18);
});

test('leaderboard ranks by total diamonds, ties broken by earliest achievement', () => {
  const s = new SessionStats({ topN: 5 });
  s.addDiamonds(u('a'), 100);
  s.addDiamonds(u('b'), 50);
  s.addDiamonds(u('c'), 100); // ties with a but reached later
  s.addDiamonds(u('b'), 50); // b reaches 100 last
  const lb = s.leaderboard();
  assert.deepEqual(lb.map((e) => e.userId), ['a', 'c', 'b']);
  assert.deepEqual(lb.map((e) => e.rank), [1, 2, 3]);
  assert.equal(lb[0].total, 100);
  s.addDiamonds(u('c'), 1);
  assert.equal(s.leaderboard()[0].userId, 'c');
});

test('leaderboard caps at top N and uses integer totals', () => {
  const s = new SessionStats({ topN: 5 });
  for (let i = 0; i < 9; i++) s.addDiamonds(u(`x${i}`), (i + 1) * 10);
  const lb = s.leaderboard();
  assert.equal(lb.length, 5);
  assert.deepEqual(lb.map((e) => e.total), [90, 80, 70, 60, 50]);
  assert.equal(s.totalDiamonds, 450);
  assert.throws(() => s.addDiamonds(u('z'), 1.5), RangeError);
  assert.throws(() => s.addDiamonds(u('z'), -1), RangeError);
});

test('engine: leaderboard updates on every gift and Nth-time count reaches 18', () => {
  const engine = new OverlayEngine({ logger: { warn() {}, error() {} } });
  const boards = [];
  const gifts = [];
  engine.on('message', (m) => (m.kind === 'leaderboard' ? boards.push(m.data) : m.kind === 'event' && gifts.push(m.data)));
  for (let i = 0; i < 18; i++) {
    engine.ingest({ type: 'gift', user: { id: 'u1', name: 'Linh' }, gift: { id: '5655', name: 'Rose', diamond: 1, streakable: false } });
  }
  assert.equal(boards.length, 18);
  assert.equal(gifts.at(-1).gift.count, 18);
  assert.equal(boards.at(-1)[0].total, 18);
  engine.clear();
  assert.deepEqual(engine.snapshot().leaderboard, []);
});
