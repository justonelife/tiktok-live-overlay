// HTTP + WebSocket server: /overlay, /panel, /health, /api/*, /ws.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { OverlayEngine } from './engine.js';
import { MockGenerator, GIFT_CATALOG } from './mock.js';
import { TikTokSource, USERNAME_RE } from './tiktok.js';
import { validateConfigPatch } from './config.js';
import { loadSettings, saveSettings } from './settings.js';
import { listenOnFreePort } from './port.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MAX_EMIT_BATCH = 100;
const WS_MAX_BUFFER = 1 << 20;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: http: data:",
  "connect-src 'self'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function httpError(status, message, errorCode) {
  const err = new Error(message);
  err.status = status;
  if (errorCode) err.errorCode = errorCode;
  return err;
}

/**
 * Build (but do not start) the server.
 * @param {object} [opts]
 * @param {boolean} [opts.mock]       start the mock generator
 * @param {number}  [opts.mockRate]   events/second for the mock generator
 * @param {number}  [opts.quietMs]    combo quiet window
 * @param {string}  [opts.host]
 * @param {string}  [opts.settingsPath] persist config to this JSON file (off when omitted)
 * @param {object}  [opts.logger]
 */
export function createOverlayServer(opts = {}) {
  const { mock = false, mockRate = 2, quietMs, host = '127.0.0.1', settingsPath, logger = console } = opts;
  const startedAt = Date.now();
  const config = loadSettings(settingsPath, logger);
  const engine = new OverlayEngine({ quietMs, topN: config.topN, logger });
  const ingest = (raw) => engine.ingest(raw);
  const mockGen = new MockGenerator({ emit: ingest, rate: mockRate });
  const tiktok = new TikTokSource({ emit: ingest, logger });
  const clients = new Set();

  const broadcast = (msg) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > WS_MAX_BUFFER) {
        ws.terminate(); // slow consumer; it will reconnect and resync
        continue;
      }
      ws.send(payload);
    }
  };
  engine.on('message', broadcast);
  // Has anything flowed since the last clear? Lets a reloaded overlay skip its "waiting" hint.
  let activity = false;
  engine.on('message', (m) => {
    if (m.kind === 'event' || m.kind === 'combo') activity = true;
    else if (m.kind === 'clear') activity = false;
  });
  tiktok.onStatus = (status) => broadcast({ kind: 'status', data: status });

  const health = () => ({
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    mode: mock ? 'mock' : 'live',
    port: server.address()?.port ?? null,
    tiktok: tiktok.status,
    mock: { running: mockGen.running, rate: mockGen.rate },
    clients: clients.size,
    counters: { ...engine.counters },
    config,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });

  // DNS-rebinding guard when bound to loopback: only accept loopback Host headers.
  const loopbackOnly = LOOPBACK_HOSTS.has(host) || host === '::1';
  const hostOk = (req) => {
    if (!loopbackOnly) return true;
    const h = (req.headers.host ?? '').replace(/:\d+$/, '');
    return LOOPBACK_HOSTS.has(h);
  };
  const originOk = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (curl, tests, OBS)
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  app.use((req, res, next) => (hostOk(req) ? next() : res.status(421).json({ ok: false, error: 'bad host' })));

  app.get('/', (req, res) => res.redirect('/panel'));
  app.get('/overlay', (req, res) => res.sendFile(path.join(PUBLIC, 'overlay.html')));
  app.get('/panel', (req, res) => res.sendFile(path.join(PUBLIC, 'panel.html')));
  app.use('/static', express.static(PUBLIC, { index: false, dotfiles: 'deny' }));
  app.get('/health', (req, res) => res.json(health()));

  // ---- API ---------------------------------------------------------------
  const api = express.Router();
  api.use((req, res, next) => {
    if (req.method === 'GET') return next();
    if (!originOk(req)) return next(httpError(403, 'cross-origin request rejected'));
    if (!req.is('application/json')) return next(httpError(415, 'Content-Type must be application/json'));
    next();
  });
  api.use(express.json({ limit: '32kb', strict: true }));

  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

  api.get('/state', (req, res) => res.json({ ok: true, config, ...engine.snapshot() }));

  api.post('/mock/emit', (req, res) => {
    const b = req.body;
    const list = Array.isArray(b) ? b : [b];
    if (list.length === 0 || list.length > MAX_EMIT_BATCH) throw httpError(400, `send 1..${MAX_EMIT_BATCH} events`);
    const results = list.map((raw) => engine.ingest(raw));
    const okAll = results.every((r) => r.ok);
    res.status(okAll ? 200 : 400).json({ ok: okAll, results });
  });

  api.post('/mock/start', (req, res) => {
    const { rate } = body(req);
    if (rate !== undefined && !(typeof rate === 'number' && rate >= 0.2 && rate <= 50)) {
      throw httpError(400, 'rate must be a number 0.2..50');
    }
    mockGen.start(rate);
    res.json({ ok: true, mock: { running: true, rate: mockGen.rate } });
  });

  api.post('/mock/stop', (req, res) => {
    mockGen.stop();
    res.json({ ok: true, mock: { running: false, rate: mockGen.rate } });
  });

  api.post('/test-gift', (req, res) => {
    const { giftId } = body(req);
    if (giftId !== undefined && typeof giftId !== 'string') throw httpError(400, 'giftId must be a string');
    const gift = giftId ? GIFT_CATALOG.find((g) => g.id === giftId) : GIFT_CATALOG[Math.floor(Math.random() * GIFT_CATALOG.length)];
    if (!gift) throw httpError(400, 'unknown giftId');
    mockGen.gift({ id: 'test_operator', name: 'Khán giả thử', avatarUrl: '' }, gift);
    res.json({ ok: true, gift: { id: gift.id, name: gift.name } });
  });

  api.get('/gifts', (req, res) => res.json({ ok: true, gifts: GIFT_CATALOG.map(({ id, name, diamond }) => ({ id, name, diamond })) }));

  api.post('/config', (req, res) => {
    const patch = validateConfigPatch(req.body);
    Object.assign(config, patch);
    saveSettings(settingsPath, config, logger);
    if (patch.topN) engine.stats.topN = patch.topN;
    broadcast({ kind: 'config', data: config });
    if (patch.topN) broadcast({ kind: 'leaderboard', data: engine.stats.leaderboard() });
    res.json({ ok: true, config });
  });

  api.post('/clear', (req, res) => {
    engine.clear();
    res.json({ ok: true });
  });

  api.post('/connect', async (req, res) => {
    const { username } = body(req);
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw httpError(400, 'username must be 2-24 chars: letters, digits, "." or "_" (optional leading @)', 'invalid_username');
    }
    // Do not await the whole handshake past a reasonable time; status is also pushed over WS.
    const status = await Promise.race([
      tiktok.connect(username),
      new Promise((r) => setTimeout(() => r(tiktok.status), 20_000).unref()),
    ]);
    res.status(status.state === 'error' ? 502 : 200).json({ ok: status.state !== 'error', tiktok: status });
  });

  api.post('/disconnect', async (req, res) => {
    await tiktok.disconnect();
    res.json({ ok: true, tiktok: tiktok.status });
  });

  api.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  app.use('/api', api);

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) logger.error('[http] error', err);
    const message = status >= 500 ? 'internal error' : err.type === 'entity.parse.failed' ? 'invalid JSON' : err.message;
    res.status(status).json({ ok: false, error: message, ...(err.errorCode ? { errorCode: err.errorCode } : {}) });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 4096,
    verifyClient: ({ req }) => hostOk(req) && originOk(req),
  });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.on('message', () => {}); // overlay channel is server -> client only
    ws.send(JSON.stringify({ kind: 'hello', data: { config, mode: mock ? 'mock' : 'live', tiktok: tiktok.status, activity, ...engine.snapshot() } }));
  });

  // Keep-alive so dead OBS sources are reaped.
  const ping = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  ping.unref();
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
  });

  if (mock) mockGen.start();

  return {
    server,
    engine,
    mockGen,
    tiktok,
    config,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const { port: p } = server.address();
          resolve(`http://${host.includes(':') ? `[${host}]` : host}:${p}`);
        });
      });
    },
    async close() {
      clearInterval(ping);
      mockGen.stop();
      engine.close();
      await tiktok.disconnect();
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise((r) => server.close(r));
    },
  };
}

// ---- CLI entry -------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mock = process.env.MOCK === '1' || process.env.MOCK === 'true';
  const port = Number(process.env.PORT ?? 7373);
  const host = process.env.HOST ?? '127.0.0.1';
  const mockRate = Number(process.env.MOCK_RATE ?? 2);
  const app = createOverlayServer({ mock, mockRate, host });

  process.on('unhandledRejection', (err) => console.error('[process] unhandled rejection', err));
  process.on('uncaughtException', (err) => console.error('[process] uncaught exception', err));

  const { url } = await listenOnFreePort(app, port, { host }); // auto-increment if busy
  console.log(`TikTok LIVE overlay server (${mock ? 'MOCK' : 'live'} mode)`);
  console.log(`  overlay: ${url}/overlay`);
  console.log(`  panel:   ${url}/panel`);
  console.log(`  health:  ${url}/health`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn(`  WARNING: bound to ${host}; the control API has no authentication.`);
  }

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
