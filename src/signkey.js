// Optional Euler Stream API key for the signature provider used by
// tiktok-live-connector. Kept in its OWN file on purpose: the operator config
// is broadcast to every overlay client over /ws, and the key must never leave
// the server. Only a masked hint is ever exposed to the browser.

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

export const SIGN_KEY_FILE = 'sign-api-key.txt';

// Euler keys are opaque tokens; accept a conservative printable set.
const KEY_RE = /^[A-Za-z0-9._~+/=-]{8,200}$/;

/** True when `key` looks like a usable API key (trimmed). */
export function isValidSignKey(key) {
  return typeof key === 'string' && KEY_RE.test(key.trim());
}

/** Never log or return the full key: "abc…xyz" for the UI. */
export function maskSignKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return '';
  return s.length <= 8 ? '••••' : `${s.slice(0, 3)}…${s.slice(-3)}`;
}

/** Read the key from `file`. Missing/corrupt file -> '' (never throws). */
export function loadSignKey(file, logger = console) {
  if (!file) return '';
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[signkey] cannot read ${file}: ${err.message}`);
    return '';
  }
  const key = text.split('\n')[0].trim();
  if (!key) return '';
  if (!isValidSignKey(key)) {
    logger.warn(`[signkey] ${file} does not look like an API key; ignoring it`);
    return '';
  }
  return key;
}

/** Persist `key` (empty string deletes the file). Never throws; returns boolean. */
export function saveSignKey(file, key, logger = console) {
  if (!file) return false;
  const clean = String(key ?? '').trim();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if (!clean) {
      rmSync(file, { force: true });
      return true;
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, clean + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.warn(`[signkey] cannot save ${file}: ${err.message}`);
    return false;
  }
}
