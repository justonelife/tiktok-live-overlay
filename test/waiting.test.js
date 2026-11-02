// Overlay "Đang chờ quà tặng…" hint: visible only before any activity, never in demo mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waitingHintVisible, isActivity, isDemo } from '../public/js/waiting.js';

test('hint is visible on a fresh, empty overlay', () => {
  assert.equal(waitingHintVisible({}), true);
  assert.equal(waitingHintVisible(), true);
});

test('hint is hidden once events flow, and stays hidden', () => {
  assert.equal(waitingHintVisible({ seenActivity: true }), false);
  assert.equal(waitingHintVisible({ leaderboardSize: 3 }), false, 'history from before a reload');
  assert.equal(waitingHintVisible({ commentCount: 1 }), false);
  // Simulate the overlay's sticky latch across a stream of messages.
  const state = { demo: false, seenActivity: false };
  const seen = [];
  for (const msg of [
    { kind: 'hello', data: { leaderboard: [], recentComments: [] } },
    { kind: 'config', data: {} },
    { kind: 'event', data: { type: 'gift' } },
    { kind: 'clear', data: {} },
    { kind: 'hello', data: { leaderboard: [], recentComments: [] } },
  ]) {
    if (isActivity(msg)) state.seenActivity = true;
    seen.push(waitingHintVisible(state));
  }
  assert.deepEqual(seen, [true, true, false, false, false]);
});

test('?demo=1 hides the hint permanently', () => {
  assert.equal(isDemo('?demo=1'), true);
  assert.equal(isDemo('?theme=neon&demo=true'), true);
  assert.equal(isDemo('?demo=0'), false);
  assert.equal(isDemo(''), false);
  assert.equal(waitingHintVisible({ demo: true }), false);
});

test('isActivity classifies server messages', () => {
  assert.equal(isActivity({ kind: 'event', data: {} }), true);
  assert.equal(isActivity({ kind: 'combo', data: {} }), true);
  assert.equal(isActivity({ kind: 'leaderboard', data: [] }), false);
  assert.equal(isActivity({ kind: 'leaderboard', data: [{ userId: 'u1' }] }), true);
  assert.equal(isActivity({ kind: 'hello', data: { leaderboard: [{}] } }), true);
  assert.equal(isActivity({ kind: 'hello', data: { recentComments: [{}] } }), true);
  assert.equal(isActivity({ kind: 'status', data: {} }), false);
  assert.equal(isActivity({ kind: 'hello', data: { activity: true, leaderboard: [] } }), true, 'mid-streak reload');
  assert.equal(isActivity({ kind: 'hello', data: { activity: false, leaderboard: [] } }), false);
  assert.equal(isActivity(null), false);
});

test('overlay markup ships the hint hidden-by-default-safe and fade is opacity-only', () => {
  const html = readFileSync(new URL('../public/overlay.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/overlay.css', import.meta.url), 'utf8');
  assert.match(html, /<p id="waiting" class="waiting" hidden>Đang chờ quà tặng…<\/p>/);
  const rule = /\.waiting\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /transition:\s*opacity/);
  assert.match(rule, /pointer-events:\s*none/);
  assert.match(rule, /background:\s*rgba\(/, 'translucent pill, safe on any OBS scene');
});
