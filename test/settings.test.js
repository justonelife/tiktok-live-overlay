// A bad settings file must never crash the server: log, fall back, keep serving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sanitizeConfig, loadSettings, saveSettings } from '../src/settings.js';
import { defaultConfig } from '../src/config.js';
import { createOverlayServer } from '../src/server.js';

const capture = () => {
  const warnings = [];
  return { warnings, logger: { log() {}, error() {}, warn: (m) => warnings.push(m) } };
};
const tmp = () => mkdtempSync(path.join(tmpdir(), 'tlo-settings-'));

test('sanitizeConfig keeps valid keys and drops bad ones individually', () => {
  const { config, problems } = sanitizeConfig({ theme: 'neon', topN: 999, muted: 'yes', evil: 1 });
  assert.equal(config.theme, 'neon');
  assert.equal(config.topN, defaultConfig().topN);
  assert.equal(config.muted, false);
  assert.equal(problems.length, 3);
  assert.deepEqual(sanitizeConfig([1, 2]).config, defaultConfig());
  assert.deepEqual(sanitizeConfig(null).config, defaultConfig());
});

test('loadSettings never throws on missing, corrupt or wrong-type files', () => {
  const dir = tmp();
  try {
    const { warnings, logger } = capture();
    assert.deepEqual(loadSettings(path.join(dir, 'missing.json'), logger), defaultConfig());
    assert.equal(warnings.length, 0, 'missing file is normal on first run');
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{ theme: neon,,, ');
    assert.deepEqual(loadSettings(bad, logger), defaultConfig());
    assert.match(warnings.at(-1), /not valid JSON/);
    writeFileSync(bad, '"just a string"');
    assert.deepEqual(loadSettings(bad, logger), defaultConfig());
    assert.deepEqual(loadSettings(dir, logger), defaultConfig(), 'a directory instead of a file');
    assert.deepEqual(loadSettings(undefined, logger), defaultConfig());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveSettings round-trips and reports failure instead of throwing', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'nested', 'settings.json');
    assert.equal(saveSettings(file, { ...defaultConfig(), theme: 'tet' }), true);
    assert.equal(loadSettings(file).theme, 'tet');
    const { logger } = capture();
    assert.equal(saveSettings(path.join(file, 'cannot', 'be', 'here.json'), defaultConfig(), logger), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server boots with a corrupt settings file, keeps serving and persists changes', async () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, '{"theme":"hacker","topN":"many","muted":true}');
  const { warnings, logger } = capture();
  const app = createOverlayServer({ settingsPath: file, logger });
  try {
    const base = await app.listen(0);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.config.theme, 'temple', 'bad theme ignored');
    assert.equal(health.config.muted, true, 'good key kept');
    assert.equal(warnings.length, 2);
    const res = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"theme":"neon"}' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).theme, 'neon', 'saved to disk');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('connect errors carry a machine code for the panel; server stays up', async () => {
  const app = createOverlayServer({ logger: capture().logger });
  try {
    const base = await app.listen(0);
    const post = (body) => fetch(`${base}/api/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const invalid = await (await post({ username: 'có dấu cách' })).json();
    assert.equal(invalid.errorCode, 'invalid_username');
    app.tiktok.loadLib = async () => ({
      WebcastEvent: {},
      ControlEvent: {},
      TikTokLiveConnection: class {
        on() {}
        async connect() {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND www.tiktok.com'), { code: 'ENOTFOUND' });
        }
        async disconnect() {}
      },
    });
    const r = await post({ username: 'linh.ng' });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).tiktok.errorCode, 'network');
    assert.equal((await fetch(`${base}/health`)).status, 200, 'still serving');
    // Retry works after a failure (the "Thử lại" button just reposts).
    assert.equal((await post({ username: 'linh.ng' })).status, 502);
  } finally {
    await app.close();
  }
});
