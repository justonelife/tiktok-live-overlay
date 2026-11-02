// Launcher: port picking (with a really occupied port) and launch() without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { candidatePorts, isPortFree, findFreePort, listenOnFreePort } from '../src/port.js';
import { launch, parseLauncherArgs, openCommand, banner, DEFAULT_START_PORT } from '../src/launch.js';
import { createOverlayServer } from '../src/server.js';

const silent = { log() {}, warn() {}, error() {} };

/** Occupy a free port on 127.0.0.1 and return it with a closer. */
async function occupy() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

test('candidatePorts walks upward and never passes 65535', () => {
  assert.deepEqual(candidatePorts(3000, 3), [3000, 3001, 3002]);
  assert.deepEqual(candidatePorts(65534, 5), [65534, 65535]);
  assert.throws(() => candidatePorts(0), RangeError);
  assert.throws(() => candidatePorts('abc'), RangeError);
});

test('findFreePort skips a port that is really in use', async () => {
  const busy = await occupy();
  try {
    assert.equal(await isPortFree(busy.port), false, 'occupied port reported busy');
    const port = await findFreePort(busy.port);
    assert.ok(port > busy.port, `picked ${port} after busy ${busy.port}`);
    assert.equal(await isPortFree(port), true);
  } finally {
    await busy.close();
  }
  assert.equal(await isPortFree(busy.port), true, 'port is free again after release');
});

test('findFreePort uses the injected probe and gives up after maxTries', async () => {
  const taken = new Set([3000, 3001, 3002]);
  assert.equal(await findFreePort(3000, { isFree: async (p) => !taken.has(p) }), 3003);
  await assert.rejects(findFreePort(3000, { maxTries: 3, isFree: async (p) => !taken.has(p) }), /no free port/);
});

test('listenOnFreePort retries when the probe races with another process', async () => {
  const attempts = [];
  const fakeApp = {
    async listen(port) {
      attempts.push(port);
      if (port === 4000) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
      return `http://127.0.0.1:${port}`;
    },
  };
  const res = await listenOnFreePort(fakeApp, 4000, { isFree: async () => true });
  assert.deepEqual(attempts, [4000, 4001]);
  assert.deepEqual(res, { url: 'http://127.0.0.1:4001', port: 4001 });
  const boom = { listen: async () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } };
  await assert.rejects(listenOnFreePort(boom, 4000, { isFree: async () => true }), /nope/);
});

test('listenOnFreePort(0) lets the OS choose', async () => {
  const app = createOverlayServer({ logger: silent });
  try {
    const { url, port } = await listenOnFreePort(app, 0);
    assert.ok(port > 0);
    assert.equal(url, `http://127.0.0.1:${port}`);
  } finally {
    await app.close();
  }
});

test('real server auto-increments past an occupied port', async () => {
  const busy = await occupy();
  const app = createOverlayServer({ logger: silent });
  try {
    const { url, port } = await listenOnFreePort(app, busy.port);
    assert.ok(port > busy.port);
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.port, port, '/health reports the chosen port');
  } finally {
    await app.close();
    await busy.close();
  }
});

test('parseLauncherArgs: defaults, --no-open, --port, --mock, env', () => {
  assert.deepEqual(parseLauncherArgs([], {}), { open: true, port: DEFAULT_START_PORT, mock: false });
  assert.equal(DEFAULT_START_PORT, 3000);
  assert.deepEqual(parseLauncherArgs(['--no-open', '--port=3100', '--mock'], {}), { open: false, port: 3100, mock: true });
  assert.equal(parseLauncherArgs([], { PORT: '4555', NO_OPEN: '1' }).port, 4555);
  assert.equal(parseLauncherArgs([], { NO_OPEN: '1' }).open, false);
  assert.equal(parseLauncherArgs(['--port=99999'], {}).port, DEFAULT_START_PORT, 'invalid port falls back');
});

test('openCommand uses `open` on mac and `start` on Windows', () => {
  assert.deepEqual(openCommand('http://x', 'darwin'), { cmd: 'open', args: ['http://x'] });
  const win = openCommand('http://x', 'win32');
  assert.equal(win.cmd, 'cmd');
  assert.deepEqual(win.args, ['/c', 'start', '""', 'http://x']);
  assert.equal(openCommand('http://x', 'linux').cmd, 'xdg-open');
});

test('launch({ open: false }) picks a free port, waits for /health and never opens a browser', async () => {
  const busy = await occupy();
  let openedWith = null;
  const run = await launch({ port: busy.port, open: false, logger: silent, openUrl: async (u) => (openedWith = u) });
  try {
    assert.ok(run.port > busy.port);
    assert.equal(run.opened, false);
    assert.equal(openedWith, null, 'browser not opened with --no-open');
    assert.equal(run.urls.overlay, `http://127.0.0.1:${run.port}/overlay`);
    assert.equal((await fetch(run.urls.panel)).status, 200);
    const text = banner({ ...run, preferredPort: busy.port, mock: false });
    assert.match(text, /ĐỪNG ĐÓNG CỬA SỔ NÀY/);
    assert.ok(text.includes(run.urls.overlay), 'banner shows the OBS URL');
    assert.match(text, new RegExp(`cổng ${busy.port} đang bận nên đã dùng cổng ${run.port}`));
  } finally {
    await run.close();
    await busy.close();
  }
});

test('launch({ open: true }) opens the panel URL', async () => {
  let openedWith = null;
  const run = await launch({ port: 3000, open: true, logger: silent, openUrl: async (u) => ((openedWith = u), true) });
  try {
    assert.equal(openedWith, run.urls.panel);
    assert.equal(run.opened, true);
  } finally {
    await run.close();
  }
});
