// Optional on-disk persistence of the operator config (theme, mute, template...).
// A missing, corrupt or partially invalid file must never crash the server:
// every problem is logged and the affected keys fall back to defaults.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { defaultConfig, validateConfigPatch } from './config.js';

/**
 * Merge a parsed settings object over the defaults, key by key.
 * Invalid keys are skipped (and reported), valid ones kept. Pure.
 * @returns {{ config: object, problems: string[] }}
 */
export function sanitizeConfig(raw) {
  const config = defaultConfig();
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) problems.push('settings must be a JSON object');
    return { config, problems };
  }
  for (const [k, v] of Object.entries(raw)) {
    try {
      Object.assign(config, validateConfigPatch({ [k]: v }));
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { config, problems };
}

/** Load settings from `file`. Never throws. */
export function loadSettings(file, logger = console) {
  if (!file) return defaultConfig();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[settings] cannot read ${file}: ${err.message}; using defaults`);
    return defaultConfig();
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    logger.warn(`[settings] ${file} is not valid JSON (${err.message}); using defaults`);
    return defaultConfig();
  }
  const { config, problems } = sanitizeConfig(raw);
  for (const p of problems) logger.warn(`[settings] ignoring bad value in ${file}: ${p}`);
  return config;
}

/** Best-effort atomic save. Never throws; returns false on failure. */
export function saveSettings(file, config, logger = console) {
  if (!file) return false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
    renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.warn(`[settings] cannot save ${file}: ${err.message}`);
    return false;
  }
}
