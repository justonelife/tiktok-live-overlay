// HTTP + WebSocket smoke test on a random port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createOverlayServer } from '../src/server.js';

const silent = { log() {}, warn() {}, error() {} };
let app;
let base;

before(async () => {
  app = createOverlayServer({ mock: false, logger: silent });
  base = await app.listen(0);
});
after(() => app.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function overlayClient(headers) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers });
  const messages = [];
  ws.on('message', (buf) => messages.push(JSON.parse(buf)));
  const ready = new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    const check = () => (messages.some((m) => m.kind === 'hello') ? resolve() : setTimeout(check, 5));
    ws.once('open', check);
  });
  return { ws, messages, ready };
}

const waitFor = async (pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('two overlay clients receive 5 mock gifts in order + matching leaderboard', async () => {
  const a = overlayClient();
  const b = overlayClient();
  await Promise.all([a.ready, b.ready]);
  assert.equal(a.messages[0].kind, 'hello');
  assert.equal(a.messages[0].data.config.theme, 'temple');

  const gifts = [
    { user: 'u1', name: 'Linh', gift: '5655', gname: 'Rose', diamond: 1, n: 10 },
    { user: 'u2', name: 'Minh', gift: '6267', gname: 'Corgi', diamond: 299, n: 1 },
    { user: 'u3', name: 'Hoa', gift: '5658', gname: 'Perfume', diamond: 20, n: 3 },
    { user: 'u1', name: 'Linh', gift: '5655', gname: 'Rose', diamond: 1, n: 50 },
    { user: 'u4', name: 'Bao', gift: '5879', gname: 'Doughnut', diamond: 30, n: 2 },
  ];
  for (const [i, g] of gifts.entries()) {
    const res = await post('/api/mock/emit', {
      type: 'gift',
      msgId: `smoke${i}`,
      ts: 1_700_000_000_000 + i,
      user: { id: g.user, name: g.name },
      gift: { id: g.gift, name: g.gname, diamond: g.diamond, repeatCount: g.n, streakable: false },
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).results, [{ ok: true, status: 'finalized' }]);
  }

  for (const c of [a, b]) {
    await waitFor(() => c.messages.filter((m) => m.kind === 'leaderboard').length === 5);
    const events = c.messages.filter((m) => m.kind === 'event').map((m) => m.data);
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((e) => [e.id, e.type, e.user.id, e.gift.comboCount, e.gift.diamondTotal, e.gift.count]),
      [
        ['msg_smoke0', 'gift', 'u1', 10, 10, 1],
        ['msg_smoke1', 'gift', 'u2', 1, 299, 1],
        ['msg_smoke2', 'gift', 'u3', 3, 60, 1],
        ['msg_smoke3', 'gift', 'u1', 50, 50, 2],
        ['msg_smoke4', 'gift', 'u4', 2, 60, 1],
      ],
    );
    assert.deepEqual(Object.keys(events[0]).sort(), ['gift', 'id', 'ts', 'type', 'user']);
    assert.deepEqual(Object.keys(events[0].user).sort(), ['avatarUrl', 'id', 'name']);
    // Each event is immediately followed by a leaderboard update.
    const kinds = c.messages.slice(1).map((m) => m.kind);
    assert.deepEqual(kinds, Array(5).fill(['event', 'leaderboard']).flat());
    const lb = c.messages.at(-1).data;
    // u3 and u4 tie at 60; u3 got there first.
    assert.deepEqual(
      lb.map((e) => [e.rank, e.userId, e.total]),
      [
        [1, 'u2', 299],
        [2, 'u3', 60],
        [3, 'u1', 60],
        [4, 'u4', 60],
      ].sort((x, y) => x[0] - y[0]),
    );
  }
  a.ws.close();
  b.ws.close();
});

test('/health, /overlay and /panel respond with security headers', async () => {
  const h = await fetch(base + '/health');
  assert.equal(h.status, 200);
  const body = await h.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'live');
  assert.equal(body.counters.emitted >= 5, true);
  for (const p of ['/overlay', '/panel']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
});

test('/api input validation, CSRF and host guards', async () => {
  assert.equal((await post('/api/mock/emit', { type: 'gift', user: { id: 'x' } })).status, 400);
  assert.equal((await post('/api/mock/emit', '{not json')).status, 400);
  assert.equal((await post('/api/mock/emit', [])).status, 400);
  assert.equal((await post('/api/config', { theme: 'evil' })).status, 400);
  assert.equal((await post('/api/config', { __proto__: { theme: 'neon' }, admin: true })).status, 400);
  assert.equal((await post('/api/connect', { username: 'a b; rm -rf /' })).status, 400);
  assert.equal((await post('/api/mock/start', { rate: 1e9 })).status, 400);
  const form = await fetch(base + '/api/clear', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
  assert.equal(form.status, 415);
  assert.equal((await post('/api/clear', {}, { origin: 'https://evil.example' })).status, 403);
  const cfg = await post('/api/config', { theme: 'neon', ticker: false });
  assert.equal(cfg.status, 200);
  assert.equal((await cfg.json()).config.theme, 'neon');
  await assert.rejects(overlayClient({ origin: 'https://evil.example' }).ready, /HTTP 401/);
});

test('connect failure degrades gracefully with a clear error', async () => {
  app.tiktok.loadLib = async () => ({
    WebcastEvent: {},
    ControlEvent: {},
    TikTokLiveConnection: class {
      on() {}
      async connect() {
        throw Object.assign(new Error('offline'), { name: 'UserOfflineError' });
      }
      async disconnect() {}
    },
  });
  const res = await post('/api/connect', { username: '@some.creator' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.tiktok.state, 'error');
  assert.match(body.tiktok.error, /offline/i);
  assert.equal((await fetch(base + '/health')).status, 200, 'server still alive');
});
