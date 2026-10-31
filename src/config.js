// Operator-controlled overlay config with strict validation.

import { DEFAULT_TEMPLATE } from '../public/js/template.js';

export const THEMES = Object.freeze(['temple', 'neon', 'tet']);

export function defaultConfig() {
  return { theme: 'temple', muted: false, ticker: true, template: DEFAULT_TEMPLATE, topN: 5 };
}

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
