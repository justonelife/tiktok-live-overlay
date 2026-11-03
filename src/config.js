// Operator-controlled overlay config with strict validation.

import { VI_TEMPLATE } from '../public/js/template.js';

export const THEMES = Object.freeze(['temple', 'neon', 'tet']);

export const CHARACTER_DEFAULTS = Object.freeze({ enabled: true, max: 12, scale: 3, groupDance: true });

export function defaultConfig() {
  return { theme: 'temple', muted: false, ticker: true, template: VI_TEMPLATE, topN: 5, characters: { ...CHARACTER_DEFAULTS } };
}

const CHARACTER_VALIDATORS = {
  enabled: (v) => (typeof v === 'boolean' ? v : bad('characters.enabled must be boolean')),
  max: (v) => (Number.isInteger(v) && v >= 1 && v <= 20 ? v : bad('characters.max must be an integer 1..20')),
  scale: (v) => (Number.isInteger(v) && v >= 1 && v <= 6 ? v : bad('characters.scale must be an integer 1..6')),
  groupDance: (v) => (typeof v === 'boolean' ? v : bad('characters.groupDance must be boolean')),
};

const VALIDATORS = {
  theme: (v) => (THEMES.includes(v) ? v : bad('theme must be one of ' + THEMES.join(', '))),
  muted: (v) => (typeof v === 'boolean' ? v : bad('muted must be boolean')),
  ticker: (v) => (typeof v === 'boolean' ? v : bad('ticker must be boolean')),
  template: (v) => {
    if (typeof v !== 'string') bad('template must be a string');
    // eslint-disable-next-line no-control-regex
    const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!s || s.length > 160) bad('template must be 1..160 characters');
    return s;
  },
  topN: (v) => (Number.isInteger(v) && v >= 1 && v <= 10 ? v : bad('topN must be an integer 1..10')),
  // Partial object: only the given sub-keys are validated and returned (merged by applyConfigPatch).
  characters: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) bad('characters must be an object');
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (!Object.hasOwn(CHARACTER_VALIDATORS, k)) bad(`unknown characters key: ${k.slice(0, 32)}`);
      out[k] = CHARACTER_VALIDATORS[k](val);
    }
    return out;
  },
};

function bad(msg) {
  const err = new TypeError(msg);
  err.status = 400;
  throw err;
}

/** Validate a partial config patch. Unknown keys are rejected. Returns the cleaned patch. */
export function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('config patch must be an object');
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(VALIDATORS, k)) bad(`unknown config key: ${k.slice(0, 32)}`);
    out[k] = VALIDATORS[k](v);
  }
  return out;
}

/** Apply a validated patch to `config` in place; nested `characters` is merged, not replaced. */
export function applyConfigPatch(config, patch) {
  for (const [k, v] of Object.entries(patch)) {
    config[k] = k === 'characters' ? { ...CHARACTER_DEFAULTS, ...config.characters, ...v } : v;
  }
  return config;
}
