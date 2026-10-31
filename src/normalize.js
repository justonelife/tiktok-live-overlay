// Input validation + normalization for inbound events.
//
// Two stages:
//   parseRaw(raw)      -> "parsed" intermediate (validated, gift streak info intact) or throws
//   toEvent(parsed, …) -> final normalized event shape sent to clients
//
// Raw input format (used by the mock generator, POST /api/mock/emit and the
// TikTok adapter after mapping):
//   {
//     type: 'gift'|'comment'|'like'|'follow'|'share'|'join',
//     msgId?: string|number,          // optional upstream id, used for exact-duplicate drop
//     ts?: number,                    // epoch ms, defaults to now
//     user: { id, name?, avatarUrl? },
//     gift?: { id, name?, diamond, repeatCount?, repeatEnd?, streakable? },
//     text?: string                   // comments
//   }

export const EVENT_TYPES = Object.freeze(['gift', 'comment', 'like', 'follow', 'share', 'join']);

export const LIMITS = Object.freeze({
  idLen: 64,
  nameLen: 48,
  giftNameLen: 40,
  textLen: 200,
  urlLen: 512,
  maxDiamondPerUnit: 1_000_000,
  maxRepeat: 10_000,
});

export class EventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventValidationError';
  }
}

const fail = (msg) => {
  throw new EventValidationError(msg);
};

// Strip control / bidi-override chars, collapse whitespace, cap length.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('');
}

function cleanId(value, what) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(Math.trunc(value));
  if (typeof value === 'bigint') value = value.toString();
  if (typeof value !== 'string') fail(`${what} must be a string or number`);
  const s = value.trim();
  if (!s || s.length > LIMITS.idLen || !/^[A-Za-z0-9_.:@-]+$/.test(s)) fail(`${what} is invalid`);
  return s;
}

function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > LIMITS.urlLen) return '';
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

function cleanInt(value, what, min, max, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    fail(`${what} is required`);
  }
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(`${what} must be an integer in [${min}, ${max}]`);
  return n;
}

function cleanUser(user) {
  if (!user || typeof user !== 'object') fail('user is required');
  const id = cleanId(user.id, 'user.id');
  const name = cleanText(user.name, LIMITS.nameLen) || id;
  return { id, name, avatarUrl: cleanUrl(user.avatarUrl) };
}

/** Validate a raw event. Returns the parsed intermediate or throws EventValidationError. */
export function parseRaw(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('event must be an object');
  if (!EVENT_TYPES.includes(raw.type)) fail(`unknown event type: ${String(raw.type).slice(0, 32)}`);

  const ts =
    raw.ts === undefined ? now : cleanInt(raw.ts, 'ts', 0, 8.64e15);
  const msgId = raw.msgId === undefined || raw.msgId === null ? null : cleanId(raw.msgId, 'msgId');
  const parsed = { type: raw.type, ts, msgId, user: cleanUser(raw.user) };

  if (raw.type === 'gift') {
    const g = raw.gift;
    if (!g || typeof g !== 'object') fail('gift is required for gift events');
    const id = cleanId(g.id, 'gift.id');
    parsed.gift = {
      id,
      name: cleanText(g.name, LIMITS.giftNameLen) || `Gift ${id}`,
      diamond: cleanInt(g.diamond, 'gift.diamond', 0, LIMITS.maxDiamondPerUnit),
      repeatCount: cleanInt(g.repeatCount, 'gift.repeatCount', 1, LIMITS.maxRepeat, 1),
      repeatEnd: g.repeatEnd === true,
      // Default: streakable unless explicitly false (TikTok giftType 1 gifts streak).
      streakable: g.streakable !== false,
    };
  } else if (raw.type === 'comment') {
    const text = cleanText(raw.text, LIMITS.textLen);
    if (!text) fail('comment text is required');
    parsed.text = text;
  }
  return parsed;
}

let seq = 0;
export function nextEventId() {
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
  return `evt_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/**
 * Build the public normalized event:
 * { id, ts, type, user:{id,name,avatarUrl}, gift?:{id,name,count,comboCount,diamondTotal}, text? }
 * For gifts `extra` must carry { count, comboCount, diamondTotal }.
 */
export function toEvent(parsed, extra = {}) {
  const ev = {
    id: parsed.msgId ? `msg_${parsed.msgId}` : nextEventId(),
    ts: parsed.ts,
    type: parsed.type,
    user: { ...parsed.user },
  };
  if (parsed.type === 'gift') {
    ev.gift = {
      id: parsed.gift.id,
      name: parsed.gift.name,
      count: extra.count,
      comboCount: extra.comboCount,
      diamondTotal: extra.diamondTotal,
    };
  }
  if (parsed.text) ev.text = parsed.text;
  return ev;
}
