// API key for the signature provider: storage, masking, error classification
// and the two /api/signkey endpoints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isValidSignKey, maskSignKey, loadSignKey, saveSignKey, SIGN_KEY_FILE } from '../src/signkey.js';
import { describeError, TikTokSource } from '../src/tiktok.js';
import { validateConfigPatch } from '../src/config.js';

const withTmpDir = (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signkey-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ---------- validation ----------

test('accepts realistic API keys and rejects junk', () => {
  assert.equal(isValidSignKey('abc123def456ghi789'), true);
  assert.equal(isValidSignKey('  padded-key_1234  '), true);
  assert.equal(isValidSignKey(''), false);
  assert.equal(isValidSignKey('short'), false); // too short
  assert.equal(isValidSignKey('has space inside key'), false);
  assert.equal(isValidSignKey('x'.repeat(201)), false); // too long
  assert.equal(isValidSignKey(null), false);
  assert.equal(isValidSignKey(42), false);
});

test('maskSignKey never leaks the middle of the key', () => {
  assert.equal(maskSignKey(''), '');
  assert.equal(maskSignKey('short'), '••••');
  const masked = maskSignKey('abcdefghijklmnop');
  assert.equal(masked, 'abc…nop');
  assert.ok(!masked.includes('defghijk'));
});

// ---------- storage ----------

test('saves, reloads and deletes the key; file is 0600', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, SIGN_KEY_FILE);
    const key = 'livekey_0123456789';

    assert.equal(loadSignKey(file, silent()), '', 'missing file -> empty key');
    assert.equal(saveSignKey(file, key, silent()), true);
    assert.equal(loadSignKey(file, silent()), key);
    assert.equal(readFileSync(file, 'utf8').trim(), key);
    assert.equal(statSync(file).mode & 0o777, 0o600, 'key file must not be world-readable');

    assert.equal(saveSignKey(file, '', silent()), true, 'empty string deletes');
    assert.equal(existsSync(file), false);
    assert.equal(loadSignKey(file, silent()), '');
  });
});

test('a corrupt key file is ignored, not trusted', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, SIGN_KEY_FILE);
    saveSignKey(file, 'garbage key with spaces', silent());
    assert.equal(loadSignKey(file, silent()), '');
  });
});

// ---------- error classification ----------

test('signature-provider failures map to needs_sign_key, not unknown', () => {
  const premium = Object.assign(new Error('Error fetching the signed TikTok WebSocket'), { name: 'PremiumFeatureError' });
  assert.equal(describeError(premium).code, 'needs_sign_key');

  const missing = Object.assign(
    new Error('[Empty Payload] [fetchWebcastSignatureFromEulerRoute] Failed to sign a request: This endpoint requires a Business plan.'),
    { name: 'SignatureMissingTokensError' },
  );
  const d = describeError(missing);
  assert.equal(d.code, 'needs_sign_key');
  assert.ok(d.message.length <= 300);

  // must not swallow the errors that were already classified
  const offline = Object.assign(new Error("The requested user isn't online :("), { name: 'UserOfflineError' });
  assert.equal(describeError(offline).code, 'user_offline');
});

test('a generic network error is still classified as network', () => {
  const err = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
  assert.equal(describeError(err).code, 'network');
});

// ---------- TikTokSource wiring ----------

test('setApiKey stores a trimmed key and clears on junk input', () => {
  const src = new TikTokSource({ emit: () => {}, logger: silent() });
  assert.equal(src.apiKey, '', 'anonymous by default');
  src.setApiKey('  my-key_1234  ');
  assert.equal(src.apiKey, 'my-key_1234');
  src.setApiKey(null);
  assert.equal(src.apiKey, '');
});

test('the key is passed to the connector as signApiKey (real connect call)', async () => {
  const seen = [];
  const fakeLib = {
    TikTokLiveConnection: class {
      constructor(uniqueId, opts) {
        seen.push({ uniqueId, opts });
        this.handlers = {};
      }
      on() {}
      async connect() {
        const err = Object.assign(new Error('offline in test'), { name: 'UserOfflineError' });
        throw err;
      }
      async disconnect() {}
    },
    WebcastEvent: {},
    ControlEvent: {},
  };
  const mk = () => new TikTokSource({ emit: () => {}, logger: silent(), loadLib: async () => fakeLib });

  const withKey = mk();
  withKey.setApiKey('key_abcdefgh');
  await withKey.connect('someone');
  assert.equal(seen[0].opts.signApiKey, 'key_abcdefgh');

  const anonymous = mk();
  await anonymous.connect('someone');
  assert.equal('signApiKey' in seen[1].opts, false, 'anonymous connect must not send an empty key');

  // status still surfaces the friendly code, not a crash
  assert.equal(anonymous.status.errorCode, 'user_offline');
});

// ---------- config stays clean ----------

test('the API key is not a config key (never broadcast to overlays)', () => {
  assert.throws(() => validateConfigPatch({ signApiKey: 'leak' }), /unknown config key/);
  assert.throws(() => validateConfigPatch({ signkey: 'leak' }), /unknown config key/);
});

function silent() {
  return { warn() {}, error() {}, log() {} };
}
