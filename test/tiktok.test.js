import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGift, mapUser, TikTokSource, USERNAME_RE } from '../src/tiktok.js';
import { parseRaw } from '../src/normalize.js';

test('maps a tiktok-live-connector gift payload to a valid raw event', () => {
  const raw = mapGift({
    common: { msgId: '7300000000000000001' },
    giftId: 5655,
    repeatCount: 7,
    repeatEnd: 1,
    giftDetails: { giftName: 'Rose', diamondCount: 1, giftType: 1 },
    user: { userId: '6800000000000000000', uniqueId: 'linh.ng', nickname: 'Linh', profilePicture: { url: ['https://p16-sign.tiktokcdn.com/a.webp'] } },
  });
  const p = parseRaw(raw);
  assert.equal(p.msgId, '7300000000000000001');
  assert.deepEqual(p.gift, { id: '5655', name: 'Rose', diamond: 1, repeatCount: 7, repeatEnd: true, streakable: true });
  assert.equal(p.user.name, 'Linh');
  assert.equal(p.user.avatarUrl, 'https://p16-sign.tiktokcdn.com/a.webp');
  assert.equal(mapUser({ uniqueId: 'x_y' }).name, 'x_y');
  assert.equal(mapUser(undefined).id, 'unknown');
});

test('username validation', () => {
  for (const ok of ['@linh.ng', 'abc_123', 'ab']) assert.ok(USERNAME_RE.test(ok), ok);
  for (const bad of ['a', 'has space', '../etc', 'x'.repeat(30), '<script>']) assert.ok(!USERNAME_RE.test(bad), bad);
});

test('library load failure becomes an error status, not a crash', async () => {
  const src = new TikTokSource({ emit() {}, logger: { warn() {} }, loadLib: async () => { throw new Error('boom'); } });
  const status = await src.connect('someone');
  assert.equal(status.state, 'error');
  assert.match(status.error, /failed to load: boom/);
  await assert.rejects(src.connect('bad name'), TypeError);
});
