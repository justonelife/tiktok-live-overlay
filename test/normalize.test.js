import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRaw, toEvent, cleanText, EventValidationError, EVENT_TYPES } from '../src/normalize.js';
import { OverlayEngine } from '../src/engine.js';

const user = { id: 'u1', name: 'Linh', avatarUrl: 'https://p16.example.com/a.jpg' };
const silent = { warn() {}, error() {} };

test('normalizes a comment into the public event shape', () => {
  const ev = toEvent(parseRaw({ type: 'comment', ts: 1000, user, text: '  hello   world  ' }));
  assert.match(ev.id, /^evt_/);
  assert.equal(ev.ts, 1000);
  assert.equal(ev.type, 'comment');
  assert.deepEqual(ev.user, user);
  assert.equal(ev.text, 'hello world');
  assert.equal('gift' in ev, false);
});

test('gift events carry id/name/count/comboCount/diamondTotal', () => {
  const p = parseRaw({ type: 'gift', msgId: 42, user, gift: { id: 5655, name: 'Rose', diamond: '1', repeatCount: 3 } });
  assert.deepEqual(p.gift, { id: '5655', name: 'Rose', diamond: 1, repeatCount: 3, repeatEnd: false, streakable: true });
  const ev = toEvent(p, { count: 2, comboCount: 3, diamondTotal: 3 });
  assert.equal(ev.id, 'msg_42');
  assert.deepEqual(ev.gift, { id: '5655', name: 'Rose', count: 2, comboCount: 3, diamondTotal: 3 });
});

test('accepts every documented type', () => {
  for (const type of EVENT_TYPES) {
    const raw = { type, user };
    if (type === 'gift') raw.gift = { id: '1', diamond: 1 };
    if (type === 'comment') raw.text = 'hi';
    assert.equal(parseRaw(raw).type, type);
  }
});

test('rejects malformed events with EventValidationError', () => {
  const bad = [
    null,
    [],
    'gift',
    { type: 'nope', user },
    { type: 'comment', user },
    { type: 'comment', text: 'x' },
    { type: 'like', user: { id: '' } },
    { type: 'like', user: { id: 'a b<script>' } },
    { type: 'gift', user },
    { type: 'gift', user, gift: { id: '1', diamond: -5 } },
    { type: 'gift', user, gift: { id: '1', diamond: 1.5 } },
    { type: 'gift', user, gift: { id: '1', diamond: 1, repeatCount: 0 } },
    { type: 'gift', user, gift: { id: '1', diamond: 1e12 } },
  ];
  for (const raw of bad) assert.throws(() => parseRaw(raw), EventValidationError, JSON.stringify(raw));
});

test('sanitizes names, text and avatar URLs', () => {
  const p = parseRaw({
    type: 'comment',
    user: { id: 'u2', name: 'Evil‮Name\u0000', avatarUrl: 'javascript:alert(1)' },
    text: 'x'.repeat(500),
  });
  assert.equal(p.user.name, 'Evil Name');
  assert.equal(p.user.avatarUrl, '');
  assert.equal(p.text.length, 200);
  assert.equal(parseRaw({ type: 'join', user: { id: 'u3' } }).user.name, 'u3', 'name falls back to id');
  assert.equal(cleanText(123, 10), '');
});

test('engine never throws on garbage and counts drops', () => {
  const engine = new OverlayEngine({ logger: silent });
  const out = [];
  engine.on('message', (m) => out.push(m));
  for (const raw of [undefined, 1, { type: 'gift' }, { type: 'comment', user, text: '' }, { __proto__: { type: 'like' } }]) {
    const r = engine.ingest(raw);
    assert.equal(r.ok, false);
  }
  assert.equal(engine.counters.dropped, 5);
  assert.equal(out.length, 0);
  assert.equal(engine.ingest({ type: 'like', user }).ok, true);
  assert.equal(out.at(-1).kind, 'event');
});
