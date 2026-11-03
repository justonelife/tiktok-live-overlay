// Pixel viewer characters: per-character state machine, the stage "world"
// (spawn / cap / eviction / separation / timed actions / effect particles),
// and CharacterLayer, which wires the world to a <canvas> with ONE
// requestAnimationFrame loop driven by delta time.
//
// CharacterWorld and Character are pure (no DOM) so they run under node:test.
// Coordinates are canvas device pixels; `pixel` is the size of one sprite pixel.

import { appearanceFor, FEET_ROW } from './characters-sprite.js';
import { onEvent, onCombo, tickInteractions, GROUP_DANCE } from './characters-interact.js';
import { CharacterRenderer, readThemeColors } from './characters-render.js';

export const CHARACTER_DEFAULTS = Object.freeze({ enabled: true, max: 12, scale: 3, groupDance: true });
export const STATES = Object.freeze(['enter', 'idle', 'walk', 'wave', 'dance', 'celebrate', 'talk', 'heart', 'star', 'leave']);
export const ENTER_DUR = 0.75;
export const LEAVE_DUR = 0.5;
export const BUBBLE_SEC = 4;
export const BUBBLE_CHARS = 26;
export const MAX_BUBBLES = 3; // more at once just covers heads; the oldest fades out quickly
export const MAX_FX = 48;
export const MAX_LATER = 64;
const BODY_PX = 16; // a body is 16x16 sprite pixels

/**
 * Reactions requested by events / interactions. Higher `prio` wins; while a
 * higher-priority animation runs, lower ones are dropped (no queue). `cd` is
 * the per-character cooldown for that reaction (anti-spam).
 */
export const REACTIONS = Object.freeze({
  heart: { state: 'heart', dur: 1.4, prio: 1, cd: 1.2 },
  nod: { state: 'talk', dur: 0.9, prio: 1, cd: 2.5 }, // short `talk` without a bubble
  wave: { state: 'wave', dur: 1.6, prio: 2, cd: 2.5 },
  star: { state: 'star', dur: 1.6, prio: 2, cd: 2 },
  talk: { state: 'talk', dur: 2.6, prio: 3, cd: 0.6 },
  dance: { state: 'dance', dur: 2.4, prio: 4, cd: 0.8 },
  celebrate: { state: 'celebrate', dur: 3.4, prio: 5, cd: 1.5 },
});

/** Cut a comment to `max` visible characters (code points), adding an ellipsis. */
export function truncate(text, max = BUBBLE_CHARS) {
  const chars = Array.from(String(text ?? '').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

export class Character {
  /**
   * @param {{id: string, name?: string}} user
   * @param {{x: number, y: number, time: number, rng?: () => number}} at
   */
  constructor(user, { x, y, time, rng = Math.random }) {
    this.id = user.id;
    this.name = user.name || user.id;
    this.look = appearanceFor(user.id);
    this.rng = rng;
    this.x = x;
    this.y = y;
    this.targetX = x;
    this.targetY = y;
    this.dir = this.look.seed & 1 ? 1 : -1;
    this.state = 'enter';
    this.kind = null; // active reaction key (REACTIONS) or null
    this.t = 0;
    this.dur = ENTER_DUR;
    this.after = null; // single deferred reaction while entering (not a queue)
    this.cooldowns = Object.create(null);
    this.bubble = null; // { text, until, born }
    this.crown = 0; // leaderboard rank, 0 = none
    this.lastActive = time;
    this.greetAt = time + 3; // no greeting right after spawning
    this.phase = (this.look.seed % 1000) / 100; // de-syncs blinking/breathing
    this.sync = false;
    this.fxClock = 0;
    this.gone = false;
  }

  get speed() {
    return 10 + this.look.pace * 8; // sprite pixels per second
  }

  /** Is the character in a reaction animation (not enter/idle/walk/leave)? */
  get reacting() {
    return this.kind !== null;
  }

  #toIdle() {
    this.state = 'idle';
    this.kind = null;
    this.sync = false;
    this.t = 0;
    this.dur = 1.2 + this.rng() * 2.8;
  }

  #face(x) {
    if (x !== undefined && Math.abs(x - this.x) > 1) this.dir = x > this.x ? 1 : -1;
  }

  /**
   * Request a reaction.
   * @param {keyof REACTIONS} kind
   * @param {number} now world time (s)
   * @param {{face?: number, force?: boolean, sync?: boolean, dur?: number}} [opts]
   * @returns {'applied'|'extended'|'deferred'|null} null = dropped (cooldown / busy / leaving)
   */
  react(kind, now, opts = {}) {
    const r = REACTIONS[kind];
    if (!r || this.state === 'leave') return null;
    if (this.state === 'enter') {
      if (!this.after || REACTIONS[this.after.kind].prio <= r.prio) this.after = { kind, opts: { ...opts, force: false } };
      return 'deferred';
    }
    if (!opts.force && (this.cooldowns[kind] ?? -Infinity) > now) return null;
    const cur = this.kind ? REACTIONS[this.kind] : null;
    const dur = opts.dur ?? r.dur;
    if (cur && !opts.force) {
      const left = this.dur - this.t;
      if (cur.prio > r.prio && left > 0.25) return null; // keep the more important animation
      if (cur.prio === r.prio && left >= dur) {
        // Same importance and the current one lasts longer: keep it, no queueing.
        this.cooldowns[kind] = now + r.cd;
        this.#face(opts.face);
        return 'extended';
      }
    }
    this.#face(opts.face);
    this.kind = kind;
    this.state = r.state;
    this.t = 0;
    this.dur = dur;
    this.sync = Boolean(opts.sync);
    this.fxClock = 0;
    this.cooldowns[kind] = now + r.cd;
    return 'applied';
  }

  /** Show a speech bubble (does not change state by itself). */
  say(text, now, seconds = BUBBLE_SEC) {
    const t = truncate(text);
    if (t) this.bubble = { text: t, until: now + seconds, born: now };
  }

  leave() {
    if (this.state === 'leave') return;
    this.state = 'leave';
    this.kind = null;
    this.after = null;
    this.bubble = null;
    this.t = 0;
    this.dur = LEAVE_DUR;
  }

  /** Bring a leaving character back (the viewer did something again). */
  revive(now) {
    if (this.state !== 'leave') return;
    this.#toIdle();
    this.lastActive = now;
  }

  /** Advance the state machine by `dt` seconds. */
  update(dt, world) {
    this.t += dt;
    const now = world.time;
    if (this.bubble && now >= this.bubble.until) this.bubble = null;
    switch (this.state) {
      case 'enter':
        if (this.t >= this.dur) {
          this.#toIdle();
          if (this.after) {
            const { kind, opts } = this.after;
            this.after = null;
            this.react(kind, now, opts);
          }
        }
        break;
      case 'leave':
        if (this.t >= this.dur) this.gone = true;
        break;
      case 'idle':
        if (this.t >= this.dur) {
          if (this.rng() < 0.55) {
            this.targetY = world.laneY(Math.min(1, Math.max(0, this.look.lane + (this.rng() - 0.5) * 0.5)));
            this.targetX = world.roomyX(this, this.targetY);
            this.state = 'walk';
            this.t = 0;
            this.dur = 8; // safety cap
          } else this.#toIdle();
        }
        break;
      case 'walk': {
        const v = this.speed * world.pixel;
        const dx = this.targetX - this.x;
        if (Math.abs(dx) > 1) this.dir = dx > 0 ? 1 : -1;
        this.x += Math.sign(dx) * Math.min(Math.abs(dx), v * dt);
        const dyy = this.targetY - this.y;
        this.y += Math.sign(dyy) * Math.min(Math.abs(dyy), v * 0.35 * dt);
        if ((Math.abs(this.targetX - this.x) < 1 && Math.abs(this.targetY - this.y) < 1) || this.t >= this.dur) this.#toIdle();
        break;
      }
      default: {
        // Reaction states. Hearts / stars / sparkles pop out while they play.
        this.fxClock -= dt;
        if (this.fxClock <= 0) {
          const headY = this.y - BODY_PX * world.pixel;
          if (this.state === 'heart') {
            world.fx('heart', this.x + this.dir * 3 * world.pixel, headY);
            this.fxClock = 0.45;
          } else if (this.state === 'star') {
            world.fx('star', this.x, headY - 2 * world.pixel);
            this.fxClock = 0.5;
          } else if (this.state === 'celebrate') {
            world.fx('spark', this.x + (this.rng() - 0.5) * 12 * world.pixel, headY);
            this.fxClock = 0.25;
          } else this.fxClock = Infinity;
        }
        if (this.t >= this.dur) this.#toIdle();
      }
    }
  }
}

/** Animation frame (pose name in characters-sprite.js) for a character at world time `time`. */
export function poseFor(ch, time) {
  const p = time + ch.phase;
  switch (ch.state) {
    case 'enter':
      return ch.t < ch.dur * 0.6 ? 'cheer' : 'idleB';
    case 'walk':
      return ['walkA', 'walkM', 'walkB', 'walkM'][Math.floor(ch.t * 8) % 4];
    case 'wave':
      return Math.floor(ch.t * 6) % 2 ? 'waveB' : 'waveA';
    case 'dance':
      return Math.floor((ch.sync ? time : ch.t) * 4) % 2 ? 'danceB' : 'danceA';
    case 'celebrate':
      return Math.floor(ch.t * 5) % 3 === 2 ? 'danceA' : 'cheer';
    case 'talk':
      if (ch.kind === 'nod') return Math.floor(ch.t * 5) % 2 ? 'idleB' : 'idleA';
      return Math.floor(ch.t * 7) % 2 ? 'talkB' : 'talkA';
    case 'heart':
      return 'heart';
    case 'star':
    case 'leave':
      return 'cheer';
    default:
      if (p % 3.4 < 0.14) return 'blink';
      return p % 1.4 < 0.7 ? 'idleA' : 'idleB';
  }
}

/** Vertical offset (device px, negative = up), alpha and scale for drawing. */
export function motionFor(ch, world) {
  const px = world.pixel;
  const t = ch.t;
  switch (ch.state) {
    case 'enter': {
      // Drop in from above with a little bounce.
      const p = Math.min(1, t / ch.dur);
      const drop = ch.y + BODY_PX * px * 2;
      let e;
      if (p < 0.7) e = 1 - (p / 0.7) ** 2;
      else e = Math.sin(((p - 0.7) / 0.3) * Math.PI) * 0.08;
      return { dy: -e * drop, alpha: 1, scale: 1 };
    }
    case 'leave': {
      const p = Math.min(1, t / ch.dur);
      return { dy: -p * 6 * px, alpha: 1 - p, scale: 1 - 0.35 * p };
    }
    case 'celebrate':
      return { dy: -Math.abs(Math.sin(t * Math.PI * 2.5)) * 4 * px, alpha: 1, scale: 1 };
    case 'dance':
      if (ch.sync) return { dy: -Math.abs(Math.sin((world.time - world.groupStart) * Math.PI * GROUP_DANCE.beatsPerSec)) * 4 * px, alpha: 1, scale: 1 };
      return { dy: -Math.abs(Math.sin(t * Math.PI * 4)) * 1.5 * px, alpha: 1, scale: 1 };
    case 'star':
      return { dy: t < 0.4 ? -Math.sin((t / 0.4) * Math.PI) * 3 * px : 0, alpha: 1, scale: 1 };
    default:
      return { dy: 0, alpha: 1, scale: 1 };
  }
}

export class CharacterWorld {
  constructor({ width = 1080, height = 730, pixel = 9, margin = 40, max = CHARACTER_DEFAULTS.max, groupDance = true, rng = Math.random } = {}) {
    this.rng = rng;
    this.time = 0;
    this.characters = [];
    this.pending = []; // created but waiting for a free slot (an evicted one is still leaving)
    this.ranks = new Map(); // userId -> leaderboard rank
    this.effects = []; // live effect particles (≤ MAX_FX)
    this.pool = []; // recycled particle objects
    this.timers = []; // [{ at, fn }] timed interaction steps (≤ MAX_LATER)
    this.max = max;
    this.groupDance = groupDance;
    this.groupStart = -Infinity;
    this.groupTimer = this.#nextGroupDelay();
    this.greetClock = 0;
    this.stats = { spawned: 0, evicted: 0, greetings: 0, groupDances: 0 };
    this.resize(width, height, pixel, margin);
  }

  #nextGroupDelay() {
    return GROUP_DANCE.min + this.rng() * (GROUP_DANCE.max - GROUP_DANCE.min);
  }

  get bodyW() {
    return BODY_PX * this.pixel;
  }

  resize(width, height, pixel, margin = this.margin) {
    const old = this.width ? { w: this.width, minY: this.minY, maxY: this.maxY } : null;
    this.width = width;
    this.height = height;
    this.pixel = Math.max(1, Math.round(pixel));
    this.margin = margin;
    this.maxY = Math.max(0, height - this.pixel * 4); // room for the name tag
    // Feet live in the lower part of the band; the sprite needs FEET_ROW+1 sprite px above them.
    this.minY = Math.min(this.maxY, Math.max(height * 0.55, (FEET_ROW + 1) * this.pixel));
    if (!old) return;
    for (const ch of [...this.characters, ...this.pending]) {
      ch.x = this.clampX((ch.x / old.w) * width);
      ch.targetX = this.clampX((ch.targetX / old.w) * width);
      ch.y = ch.targetY = this.laneY(ch.look.lane);
    }
  }

  /** Clamp a feet x so the whole body stays inside the side margins. */
  clampX(x) {
    const half = this.bodyW / 2;
    const lo = this.margin + half;
    const hi = this.width - this.margin - half;
    return lo > hi ? this.width / 2 : Math.min(hi, Math.max(lo, x));
  }

  /** A walk target for `ch`: the least crowded of a few random spots at depth `y`. */
  roomyX(ch, y) {
    const span = this.width * 0.35;
    let best = ch.x;
    let bestD = -1;
    for (let i = 0; i < 3; i++) {
      const x = this.clampX(ch.x + (this.rng() * 2 - 1) * span);
      let d = Infinity;
      for (const c of this.characters) {
        if (c === ch || Math.abs(c.y - y) > this.bodyW * 0.6) continue;
        d = Math.min(d, Math.abs(c.targetX - x), Math.abs(c.x - x));
      }
      if (d > bestD) [best, bestD] = [x, d];
    }
    return best;
  }

  laneY(f) {
    return this.minY + f * (this.maxY - this.minY);
  }

  configure({ max, groupDance } = {}) {
    if (typeof groupDance === 'boolean') this.groupDance = groupDance;
    if (Number.isInteger(max) && max >= 1 && max !== this.max) {
      this.max = max;
      // Shrinking: drop the extras immediately (with a puff) so the cap holds right away.
      while (this.characters.length > max) {
        const victim = this.characters.find((c) => c.state === 'leave') ?? this.#lru();
        this.characters.splice(this.characters.indexOf(victim), 1);
        this.#puff(victim);
        this.stats.evicted++;
      }
      if (this.pending.length > max) this.pending.splice(0, this.pending.length - max);
      this.#rebalance();
    }
  }

  find(id) {
    return this.characters.find((c) => c.id === id) ?? this.pending.find((c) => c.id === id) ?? null;
  }

  /** On stage and visible (not waiting for a slot). */
  isOnStage(ch) {
    return this.characters.includes(ch);
  }

  /**
   * Get (or create) the character for `user` and mark it active. New characters
   * enter immediately when there is room, otherwise the least recently active
   * one is sent off and the newcomer enters as soon as it is gone.
   */
  ensure(user) {
    if (!user || typeof user.id !== 'string' || !user.id) return null;
    let ch = this.find(user.id);
    if (ch) {
      ch.lastActive = this.time;
      if (user.name) ch.name = user.name;
      if (ch.state === 'leave') {
        ch.revive(this.time);
        this.#rebalance(ch);
      }
      return ch;
    }
    ch = new Character(user, { x: this.#spawnX(), y: 0, time: this.time, rng: this.rng });
    ch.y = ch.targetY = this.laneY(ch.look.lane);
    ch.crown = this.ranks.get(ch.id) ?? 0;
    if (this.characters.length < this.max && this.pending.length === 0) this.#place(ch);
    else {
      this.pending.push(ch);
      if (this.pending.length > this.max) this.pending.shift();
      this.#rebalance();
    }
    return ch;
  }

  #place(ch) {
    ch.t = 0;
    this.characters.push(ch);
    this.stats.spawned++;
  }

  #lru(keep = null) {
    let best = null;
    for (const c of this.characters) if (c !== keep && c.state !== 'leave' && (!best || c.lastActive < best.lastActive)) best = c;
    return best;
  }

  /**
   * Make sure (staying + waiting) never exceeds the cap; evict LRU characters as needed.
   * `keep` (a viewer who just acted) is never the victim; if nobody else can go, the
   * longest-waiting newcomer is dropped instead.
   */
  #rebalance(keep = null) {
    let staying = this.characters.filter((c) => c.state !== 'leave').length;
    while (staying + this.pending.length > this.max) {
      const victim = this.#lru(keep);
      if (!victim) {
        this.pending.shift();
        continue;
      }
      victim.leave();
      this.#puff(victim);
      this.stats.evicted++;
      staying--;
    }
  }

  #spawnX() {
    // Pick the candidate furthest from everyone already on stage.
    let best = this.clampX(this.width / 2);
    let bestD = -1;
    for (let i = 0; i < 6; i++) {
      const x = this.clampX(this.margin + this.rng() * (this.width - 2 * this.margin));
      let d = Infinity;
      for (const c of this.characters) d = Math.min(d, Math.abs(c.x - x));
      if (d > bestD) [best, bestD] = [x, d];
    }
    return best;
  }

  #puff(ch) {
    for (let i = 0; i < 6; i++) this.fx('puff', ch.x + (this.rng() - 0.5) * this.bodyW, ch.y - this.rng() * this.bodyW);
  }

  /** Nearest on-stage characters to `ch` within `radius` px (enter/leave excluded). */
  neighbors(ch, radius, n = 4) {
    const out = [];
    for (const c of this.characters) {
      if (c === ch || c.state === 'enter' || c.state === 'leave') continue;
      const d = Math.hypot(c.x - ch.x, (c.y - ch.y) * 1.5);
      if (d <= radius) out.push([d, c]);
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, n).map(([, c]) => c);
  }

  /** Run `fn` after `delay` seconds of world time (bounded; extra requests are dropped). */
  later(delay, fn) {
    if (this.timers.length >= MAX_LATER) return false;
    this.timers.push({ at: this.time + delay, fn });
    return true;
  }

  /** Spawn an effect particle (bounded pool). */
  fx(kind, x, y) {
    if (this.effects.length >= MAX_FX) return null;
    const p = this.pool.pop() ?? {};
    const r = this.rng;
    p.kind = kind;
    p.x = x;
    p.y = y;
    p.vx = (r() - 0.5) * this.pixel * (kind === 'puff' ? 10 : 4);
    p.vy = -this.pixel * (kind === 'puff' ? 3 + r() * 3 : 7 + r() * 5);
    p.ttl = kind === 'puff' ? 0.5 : kind === 'spark' ? 0.7 : 1.2;
    p.life = 0;
    this.effects.push(p);
    return p;
  }

  /** Speech bubble for `ch`, keeping at most MAX_BUBBLES on screen (oldest fades out). */
  say(ch, text, seconds) {
    ch.say(text, this.time, seconds);
    const open = this.characters.filter((c) => c.bubble && c !== ch).sort((a, b) => a.bubble.born - b.bubble.born);
    for (let i = 0; i <= open.length - MAX_BUBBLES; i++) open[i].bubble.until = Math.min(open[i].bubble.until, this.time + 0.3);
  }

  setLeaderboard(rows) {
    this.ranks = new Map((rows ?? []).map((r) => [r.userId, r.rank]));
    for (const c of [...this.characters, ...this.pending]) c.crown = this.ranks.get(c.id) ?? 0;
  }

  handle(ev) {
    return onEvent(this, ev);
  }

  combo(d) {
    return onCombo(this, d);
  }

  clear() {
    this.characters = [];
    this.pending = [];
    this.timers = [];
    this.pool.push(...this.effects);
    this.effects = [];
    this.ranks = new Map();
  }

  update(dt) {
    this.time += dt;
    // Timed interaction steps.
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= this.time);
      if (due.length) {
        this.timers = this.timers.filter((t) => t.at > this.time);
        for (const t of due) t.fn();
      }
    }
    for (const ch of this.characters) ch.update(dt, this);
    // Remove characters that finished leaving, then let waiting ones in.
    if (this.characters.some((c) => c.gone)) this.characters = this.characters.filter((c) => !c.gone);
    while (this.pending.length && this.characters.length < this.max) this.#place(this.pending.shift());
    this.#separate(dt);
    tickInteractions(this, dt);
    // Effects.
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const p = this.effects[i];
      p.life += dt;
      if (p.life >= p.ttl) {
        this.pool.push(p);
        this.effects[i] = this.effects[this.effects.length - 1];
        this.effects.pop();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'heart') p.x += Math.sin((p.life + p.ttl) * 9) * this.pixel * 0.3;
    }
  }

  /** Simple separation: characters on similar depth push each other apart horizontally. */
  #separate(dt) {
    const list = this.characters;
    const minD = this.bodyW * 0.8;
    const depth = this.bodyW * 0.6; // characters further apart in depth may overlap (front/back)
    const k = Math.min(1, dt * 6);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.state === 'enter' || a.state === 'leave') continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.state === 'enter' || b.state === 'leave') continue;
        const dx = b.x - a.x;
        if (Math.abs(dx) >= minD || Math.abs(b.y - a.y) >= depth) continue;
        const s = dx !== 0 ? Math.sign(dx) : a.id < b.id ? 1 : -1;
        const push = (minD - Math.abs(dx)) * 0.5 * k;
        a.x -= s * push;
        b.x += s * push;
        if (a.state === 'walk') a.targetX = a.x;
        if (b.state === 'walk') b.targetX = b.x;
      }
    }
    for (const c of list) c.x = this.clampX(c.x);
  }

  /** Overlap count (pairs closer than half a body on a similar depth) - used by tests. */
  overlaps() {
    let n = 0;
    const list = this.characters;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (Math.abs(list[i].x - list[j].x) < this.bodyW * 0.5 && Math.abs(list[i].y - list[j].y) < this.bodyW * 0.6) n++;
      }
    }
    return n;
  }
}

/**
 * Integer device pixels per sprite pixel: `scale` 3 at 1080 CSS px wide -> 9.
 * A short band (landscape sources) also limits the size: at most `bandHeight * 1.5` counts as width.
 */
export function pixelSize(scale, cssWidth, dpr = 1, bandHeight = Infinity) {
  return Math.max(1, Math.round(((scale * Math.min(cssWidth, bandHeight * 1.5)) / 360) * dpr));
}

/**
 * Browser glue: a <canvas>, one rAF loop, config, theme and resize handling.
 * No DOM nodes are created per frame (sprites live in detached 1x canvases).
 */
export class CharacterLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.cfg = { ...CHARACTER_DEFAULTS };
    this.world = new CharacterWorld({ max: this.cfg.max, groupDance: this.cfg.groupDance });
    this.renderer = new CharacterRenderer(canvas);
    this.raf = 0;
    this.last = 0;
    this.frames = 0;
    this.fps = 0;
    this.frameMs = 0; // EMA of update+draw cost
    this.errors = 0;
    this.fpsWindow = { t: 0, n: 0 };
    this.frame = this.frame.bind(this);
    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    this.ro?.observe(canvas);
    this.refreshTheme();
    this.resize();
    this.start();
  }

  configure(cfg = {}) {
    const next = { ...this.cfg, ...cfg };
    const scaleChanged = next.scale !== this.cfg.scale;
    this.cfg = next;
    this.canvas.hidden = !next.enabled;
    if (!next.enabled) {
      this.stop();
      this.world.clear();
      this.renderer.clear();
      return;
    }
    this.world.configure({ max: next.max, groupDance: next.groupDance });
    if (scaleChanged) this.resize();
    this.start();
  }

  get enabled() {
    return this.cfg.enabled;
  }

  refreshTheme() {
    this.renderer.setColors(readThemeColors(document.documentElement));
  }

  resize() {
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.world.resize(w, h, pixelSize(this.cfg.scale, cssW, dpr, cssH), Math.round(40 * dpr));
  }

  onEvent(ev) {
    if (this.enabled) this.world.handle(ev);
  }

  onCombo(d) {
    if (this.enabled) this.world.combo(d);
  }

  setLeaderboard(rows) {
    this.world.setLeaderboard(rows);
  }

  clear() {
    this.world.clear();
  }

  start() {
    if (this.raf || !this.cfg.enabled) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    this.stop();
    this.ro?.disconnect();
  }

  frame(now) {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const t0 = performance.now();
    try {
      this.world.update(dt);
      this.renderer.draw(this.world);
    } catch (err) {
      // Never let one bad frame kill the loop; report sparingly.
      if (this.errors++ % 300 === 0) console.warn('[characters] frame failed', err);
    }
    this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
    this.frames++;
    this.fpsWindow.n++;
    if (now - this.fpsWindow.t >= 1000) {
      this.fps = Math.round((this.fpsWindow.n * 1000) / (now - this.fpsWindow.t || 1));
      this.fpsWindow = { t: now, n: 0 };
    }
  }

  /**
   * Throughput benchmark (debug / verification only): run `n` simulation + draw
   * steps back to back without waiting for vsync. Returns ms per frame.
   */
  bench(n = 300) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      this.world.update(1 / 60);
      this.renderer.draw(this.world);
    }
    this.renderer.ctx.getImageData(0, 0, 1, 1); // force the queued draws to actually rasterize
    return (performance.now() - t0) / n;
  }

  stats() {
    const w = this.world;
    const states = {};
    for (const c of w.characters) states[c.state] = (states[c.state] ?? 0) + 1;
    return {
      enabled: this.cfg.enabled,
      running: this.raf !== 0,
      time: Math.round(w.time * 10) / 10,
      count: w.characters.length,
      pending: w.pending.length,
      max: w.max,
      pixel: w.pixel,
      states,
      bubbles: w.characters.filter((c) => c.bubble).length,
      crowns: w.characters.filter((c) => c.crown).length,
      effects: w.effects.length,
      frames: this.frames,
      fps: this.fps,
      frameMs: Math.round(this.frameMs * 100) / 100,
      errors: this.errors,
      outline: this.renderer.colors?.outline ?? null,
      who: w.characters.map((c) => ({ id: c.id, name: c.name, state: c.state, kind: c.kind, x: Math.round(c.x), y: Math.round(c.y), dir: c.dir, crown: c.crown, bubble: c.bubble?.text ?? null })),
      ...w.stats,
    };
  }
}
