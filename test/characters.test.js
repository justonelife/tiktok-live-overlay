// Pixel viewer characters: deterministic sprites, state machine, cap/eviction,
// interactions, config validation, the spawn endpoint and the panel/overlay markup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import {
  hashString, appearanceFor, spriteGrid, paletteFor, topRow, iconGrid, ICONS,
  SPRITE_W, SPRITE_H, BODY_X, BODY_Y, FEET_ROW, BODIES, HAIR_STYLES, ACCESSORIES, POSE_NAMES, SLOT,
} from '../public/js/characters-sprite.js';
import {
  Character, CharacterWorld, REACTIONS, ENTER_DUR, LEAVE_DUR, BUBBLE_CHARS, MAX_FX, MAX_BUBBLES, CHARACTER_DEFAULTS as CLIENT_DEFAULTS,
  poseFor, truncate, pixelSize,
} from '../public/js/characters.js';
import { greet, groupDance, GREETING, GROUP_DANCE } from '../public/js/characters-interact.js';
import { validateConfigPatch, applyConfigPatch, defaultConfig, CHARACTER_DEFAULTS } from '../src/config.js';
import { sanitizeConfig } from '../src/settings.js';
import { createOverlayServer } from '../src/server.js';
import { MockGenerator } from '../src/mock.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** Seeded PRNG so simulations are reproducible. */
function seeded(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const world = (opts = {}) => new CharacterWorld({ width: 1080, height: 730, pixel: 9, margin: 40, rng: seeded(), ...opts });
const step = (w, seconds, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) w.update(dt);
};
const user = (id, name = id) => ({ id, name, avatarUrl: '' });
/** Spawn `ids` without any reaction and let them land (enter -> idle). */
function populate(w, ids) {
  for (const id of ids) w.ensure(user(id));
  step(w, ENTER_DUR + 0.1);
  return ids.map((id) => w.find(id));
}

// ---------- sprites ----------
test('hash -> same character: appearance and every sprite frame are deterministic', () => {
  assert.equal(hashString('u1001'), hashString('u1001'));
  assert.notEqual(hashString('u1001'), hashString('u1002'));
  assert.equal(hashString(''), 0x811c9dc5, 'FNV-1a offset basis');
  for (const id of ['u1001', 'linh.ng', '7234567890123456789', 'Bông Gòn 42']) {
    const a = appearanceFor(id);
    assert.deepEqual(appearanceFor(id), a, 'same appearance on every call (no Math.random)');
    for (const pose of POSE_NAMES) assert.deepEqual(spriteGrid(appearanceFor(id), pose), spriteGrid(a, pose), `${id} ${pose}`);
  }
  // A Character for the same user always looks the same.
  assert.deepEqual(new Character(user('u9'), { x: 0, y: 0, time: 0 }).look, new Character(user('u9'), { x: 500, y: 9, time: 3 }).look);
});

test('appearance space: 4 bodies, 6 hair styles, 5 accessories all reachable; ids look different', () => {
  const looks = Array.from({ length: 400 }, (_, i) => appearanceFor(`viewer${i}`));
  assert.equal(BODIES.length, 4);
  for (const [field, all] of [['body', BODIES], ['hairStyle', HAIR_STYLES], ['accessory', ACCESSORIES]]) {
    assert.deepEqual(new Set(looks.map((l) => l[field])), new Set(all), field);
  }
  const outfits = new Set(looks.map((l) => [l.body, l.skin, l.hairStyle, l.hair, l.shirt, l.accessory].join()));
  assert.ok(outfits.size >= 390, `distinct outfits: ${outfits.size}/400`);
  assert.ok(looks.every((l) => l.lane >= 0 && l.lane < 1 && l.pace >= 0 && l.pace < 1));
});

test('sprite grids: 18x20 canvas, 16x16 body, outlined, feet on FEET_ROW, every pose non-empty', () => {
  assert.equal(SPRITE_W, 18);
  assert.equal(SPRITE_H, 20);
  for (let i = 0; i < 40; i++) {
    const look = appearanceFor(`s${i}`);
    for (const pose of POSE_NAMES) {
      const g = spriteGrid(look, pose);
      assert.equal(g.length, SPRITE_W * SPRITE_H);
      const filled = g.filter((v) => v !== 0 && v !== SLOT.outline).length;
      assert.ok(filled > 60, `${look.body} ${pose}: ${filled} body pixels`);
      // Nothing body-coloured below the shoes, and the shoes sit on FEET_ROW.
      for (let y = FEET_ROW + 1; y < SPRITE_H; y++) for (let x = 0; x < SPRITE_W; x++) assert.ok(g[y * SPRITE_W + x] <= SLOT.outline);
      const feet = [...g.slice(FEET_ROW * SPRITE_W, (FEET_ROW + 1) * SPRITE_W)];
      if (!pose.startsWith('walk') && !pose.startsWith('dance')) assert.equal(feet.filter((v) => v === SLOT.shoes).length, 6, `${pose} both shoes on the floor`);
      // Every filled pixel touching transparency is outline (closed silhouette).
      for (let y = 0; y < SPRITE_H; y++) {
        for (let x = 0; x < SPRITE_W; x++) {
          const v = g[y * SPRITE_W + x];
          if (v <= SLOT.outline) continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= SPRITE_W || ny >= SPRITE_H) continue;
            assert.notEqual(g[ny * SPRITE_W + nx], 0, `${pose} hole in outline at ${nx},${ny}`);
          }
        }
      }
    }
  }
  assert.equal(BODY_X, 1);
  assert.equal(BODY_Y, 3);
  assert.ok(topRow(spriteGrid(appearanceFor('x'), 'idleA')) >= 0);
});

test('palette: outline colour is injected (theme-aware), icons are outlined grids', () => {
  const p = paletteFor(appearanceFor('u1'), '#2c060c');
  assert.equal(p[SLOT.outline], '#2c060c');
  assert.equal(p[SLOT.none], null);
  for (const slot of Object.values(SLOT).filter((s) => s > 0)) assert.match(p[slot], /^#[0-9a-f]{6}$/i, `slot ${slot}`);
  for (const [name, rows] of Object.entries(ICONS)) {
    const { w, h, data } = iconGrid(rows);
    assert.equal(w, rows[0].length + 2, name);
    assert.equal(h, rows.length + 2, name);
    assert.ok(data.includes(SLOT.outline) && data.includes(2), name);
  }
});

test('pixelSize is an integer >= 1 and grows with scale', () => {
  assert.equal(pixelSize(3, 1080), 9);
  assert.equal(pixelSize(1, 1080), 3);
  assert.equal(pixelSize(6, 1080), 18);
  assert.equal(pixelSize(1, 100), 1);
  for (let s = 1; s <= 6; s++) assert.ok(Number.isInteger(pixelSize(s, 390, 2)));
});

// ---------- state machine ----------
test('state machine: enter -> idle -> walk (faces walking direction) -> idle', () => {
  const w = world();
  const [c] = populate(w, ['a']);
  assert.equal(c.state, 'idle');
  c.x = 300;
  c.targetX = 700;
  c.state = 'walk';
  c.t = 0;
  c.dur = 8;
  c.dir = -1;
  w.update(0.1);
  assert.equal(c.dir, 1, 'turns right when walking right');
  assert.ok(c.x > 300);
  c.targetX = 100;
  w.update(0.1);
  assert.equal(c.dir, -1, 'turns left when walking left');
  step(w, 10);
  assert.ok(['idle', 'walk'].includes(c.state));
  // Idle characters eventually wander on their own.
  const seen = new Set();
  for (let i = 0; i < 1200; i++) {
    w.update(1 / 60);
    seen.add(c.state);
  }
  assert.ok(seen.has('walk') && seen.has('idle'), [...seen].join());
});

test('state machine: reactions, priority (no queue), cooldowns, return to idle', () => {
  const c = new Character(user('a'), { x: 500, y: 600, time: 0, rng: seeded() });
  const w = world();
  // During enter a reaction is deferred (single slot, highest priority kept).
  assert.equal(c.react('heart', 0), 'deferred');
  assert.equal(c.react('dance', 0), 'deferred');
  assert.equal(c.react('wave', 0), 'deferred');
  assert.equal(c.after.kind, 'dance');
  c.update(ENTER_DUR + 0.01, w);
  assert.equal(c.state, 'dance', 'deferred reaction plays after landing');

  const now = 10;
  const d = new Character(user('b'), { x: 500, y: 600, time: 0, rng: seeded() });
  d.update(ENTER_DUR + 0.01, w);
  assert.equal(d.state, 'idle');
  assert.equal(d.react('dance', now), 'applied');
  assert.equal(d.state, 'dance');
  assert.equal(d.react('heart', now), null, 'lower priority dropped while dancing');
  assert.equal(d.state, 'dance');
  assert.equal(d.react('celebrate', now), 'applied', 'higher priority interrupts');
  assert.equal(d.state, 'celebrate');
  assert.equal(d.react('celebrate', now + 0.1), null, 'cooldown');
  // Celebrate is long; it finishes and goes back to idle.
  w.time = now;
  for (let t = 0; t < REACTIONS.celebrate.dur + 0.05; t += 0.05) d.update(0.05, w);
  assert.equal(d.state, 'idle');
  assert.equal(d.kind, null);

  // wave then wave again inside the cooldown: dropped; after it: applied.
  assert.equal(d.react('wave', 20), 'applied');
  assert.equal(d.react('wave', 20 + REACTIONS.wave.cd - 0.1), null);
  // Same priority but the current one lasts longer: kept (extended), not queued.
  assert.equal(d.react('star', 20.1), 'extended');
  assert.equal(d.state, 'wave');

  // talk with bubble: comment text is truncated.
  d.say('x'.repeat(80), 30);
  assert.equal(Array.from(d.bubble.text).length, BUBBLE_CHARS);
  assert.ok(d.bubble.text.endsWith('…'));
  assert.equal(truncate('  ngắn  '), 'ngắn');
  assert.equal(truncate('😀'.repeat(40)).length, (BUBBLE_CHARS - 1) * 2 + 1, 'counts code points, not UTF-16 units');

  // leave: no more reactions, gone after LEAVE_DUR.
  d.leave();
  assert.equal(d.react('celebrate', 99, { force: true }), null);
  d.update(LEAVE_DUR + 0.01, w);
  assert.equal(d.gone, true);
});

test('every state maps to a valid pose; facing towards a target', () => {
  const c = new Character(user('p'), { x: 500, y: 600, time: 0, rng: seeded() });
  for (const state of ['enter', 'idle', 'walk', 'wave', 'dance', 'celebrate', 'talk', 'heart', 'star', 'leave']) {
    c.state = state;
    for (let t = 0; t < 2; t += 0.07) {
      c.t = t;
      assert.ok(POSE_NAMES.includes(poseFor(c, t * 3)), `${state} @${t}`);
    }
  }
  c.state = 'idle';
  c.kind = null;
  c.dir = 1;
  c.cooldowns = {};
  c.react('wave', 100, { face: 100 });
  assert.equal(c.dir, -1, 'turns to face x=100');
});

// ---------- world: spawn, cap, eviction ----------
test('spawn on join AND on first comment/like/gift without a join', () => {
  const w = world();
  w.handle({ type: 'comment', user: user('c1'), text: 'hi' });
  w.handle({ type: 'like', user: user('l1') });
  w.handle({ type: 'gift', user: user('g1'), gift: { id: '1', name: 'Rose', count: 1, comboCount: 1, diamondTotal: 1 } });
  w.handle({ type: 'follow', user: user('f1') });
  w.handle({ type: 'join', user: user('j1') });
  assert.deepEqual(w.characters.map((c) => c.id), ['c1', 'l1', 'g1', 'f1', 'j1']);
  assert.ok(w.characters.every((c) => c.state === 'enter'));
  w.handle({ type: 'comment', user: user('c1'), text: 'again' });
  assert.equal(w.characters.length, 5, 'no duplicate for a known user');
  step(w, ENTER_DUR + 0.05);
  assert.equal(w.find('c1').state, 'talk', 'deferred talk after landing');
  assert.equal(w.find('c1').bubble.text, 'again');
  assert.equal(w.find('g1').state, 'dance');
  assert.equal(w.ensure({ id: '' }), null);
  assert.equal(w.handle({ type: 'join' }), null);
});

test('cap: never more than max on stage; least recently active leaves (with animation) first', () => {
  const w = world({ max: 3 });
  populate(w, ['a', 'b', 'c']);
  step(w, 1);
  w.handle({ type: 'like', user: user('a') }); // a active again -> b is now the least recent
  step(w, 0.2);
  w.handle({ type: 'join', user: user('d') });
  assert.equal(w.find('b').state, 'leave', 'LRU evicted');
  assert.equal(w.characters.length, 3, 'newcomer waits while b plays its exit');
  assert.equal(w.pending.length, 1);
  step(w, LEAVE_DUR + 0.05);
  assert.deepEqual(w.characters.map((c) => c.id).sort(), ['a', 'c', 'd']);
  assert.equal(w.find('d').state, 'enter');
  assert.equal(w.find('b'), null);

  // Fuzz: random users / events / frame times; the cap is checked after every step.
  const f = world({ max: 5, rng: seeded(99) });
  const r = seeded(3);
  const types = ['join', 'comment', 'like', 'gift', 'follow', 'share'];
  for (let i = 0; i < 3000; i++) {
    const n = Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      f.handle({ type: types[Math.floor(r() * types.length)], user: user(`u${Math.floor(r() * 40)}`), text: 'yo', gift: { diamondTotal: Math.floor(r() * 500) } });
      assert.ok(f.characters.length <= 5, `cap after event (${f.characters.length})`);
    }
    f.update(r() * 0.05);
    assert.ok(f.characters.length <= 5, `cap after update (${f.characters.length})`);
    assert.ok(f.effects.length <= MAX_FX);
    assert.ok(f.timers.length <= 64);
  }
  assert.ok(f.stats.evicted > 0);
});

test('lowering max applies immediately; a returning viewer is revived, not duplicated', () => {
  const w = world({ max: 6 });
  populate(w, ['a', 'b', 'c', 'd', 'e', 'f']);
  w.configure({ max: 2 });
  assert.equal(w.characters.length, 2);
  assert.equal(w.max, 2);
  w.handle({ type: 'join', user: user('g') });
  const leaving = w.characters.find((c) => c.state === 'leave');
  assert.ok(leaving);
  w.handle({ type: 'comment', user: user(leaving.id), text: 'still here' });
  assert.notEqual(leaving.state, 'leave', 'revived');
  assert.equal(w.characters.filter((c) => c.id === leaving.id).length, 1);
  step(w, 2);
  assert.ok(w.characters.length <= 2);
});

test('review fixes: chatty viewer at max=1 does not evict itself; landscape band keeps depth lanes', () => {
  const w = world({ max: 1 });
  const [a] = populate(w, ['a']);
  w.handle({ type: 'join', user: user('b') }); // a leaves, b waits
  assert.equal(a.state, 'leave');
  w.handle({ type: 'comment', user: user('a'), text: 'đừng đi' }); // a comes back
  assert.notEqual(a.state, 'leave', 'revived and not re-evicted');
  assert.equal(w.pending.length, 0, 'the waiting newcomer is dropped instead');
  step(w, 2);
  assert.deepEqual(w.characters.map((c) => c.id), ['a']);

  // 1920x1080 landscape source: band 410 px tall, pixel size limited by the band height.
  const px = pixelSize(3, 1920, 1, 410);
  assert.equal(px, 5);
  const l = world({ width: 1920, height: 410, pixel: px });
  assert.ok(l.maxY - l.minY > 100, `depth range ${l.minY}..${l.maxY}`);
  assert.equal(pixelSize(3, 1080, 1, 730), 9, 'portrait 1080x1920 unchanged');
});

test('stage: margins respected, separation pushes overlapping characters apart', () => {
  const w = world();
  const chars = populate(w, ['a', 'b', 'c', 'd']);
  for (const c of chars) {
    c.x = c.targetX = 540;
    c.y = c.targetY = 600;
  }
  assert.ok(w.overlaps() > 0);
  step(w, 1.5);
  assert.equal(w.overlaps(), 0, 'no overlapping pairs after separation');
  // Pushed against the wall: body stays inside the 40px margin.
  for (const c of chars) {
    c.x = -500;
  }
  w.update(1 / 60);
  for (const c of w.characters) assert.ok(c.x - w.bodyW / 2 >= 40 && c.x + w.bodyW / 2 <= 1080 - 40, `x=${c.x}`);
  for (const c of w.characters) assert.ok(c.y >= w.minY && c.y <= w.maxY);
});

// ---------- interactions ----------
test('gift: giver dances (big gift celebrates); neighbours turn and wave / send hearts', () => {
  const w = world();
  const [a, b, c, far] = populate(w, ['a', 'b', 'c', 'far']);
  Object.assign(a, { x: 500, targetX: 500, y: 600, targetY: 600, dir: 1 });
  Object.assign(b, { x: 360, targetX: 360, y: 600, targetY: 600, dir: -1 });
  Object.assign(c, { x: 660, targetX: 660, y: 610, targetY: 610, dir: 1 });
  Object.assign(far, { x: 1000, targetX: 1000, y: 700, targetY: 700 });
  w.characters.forEach((ch) => (ch.greetAt = Infinity)); // isolate from random greetings
  w.handle({ type: 'gift', user: user('a'), gift: { id: '1', diamondTotal: 5 } });
  assert.equal(a.state, 'dance');
  step(w, 0.6);
  assert.ok(['wave', 'heart'].includes(b.state), b.state);
  assert.ok(['wave', 'heart'].includes(c.state), c.state);
  assert.equal(b.dir, 1, 'b turned right towards the giver');
  assert.equal(c.dir, -1, 'c turned left towards the giver');

  step(w, 4);
  w.handle({ type: 'gift', user: user('a'), gift: { id: '2', diamondTotal: 299 } });
  assert.equal(a.state, 'celebrate');
  assert.ok(w.effects.some((p) => p.kind === 'spark'));
});

test('comment: bubble on the speaker, neighbours nod (short talk); like -> hearts; follow -> stars', () => {
  const w = world();
  const [a, b, c] = populate(w, ['a', 'b', 'c']);
  Object.assign(a, { x: 500, targetX: 500, y: 600, targetY: 600 });
  Object.assign(b, { x: 380, targetX: 380, y: 600, targetY: 600 });
  Object.assign(c, { x: 620, targetX: 620, y: 600, targetY: 600 });
  w.characters.forEach((ch) => (ch.greetAt = Infinity));
  w.handle({ type: 'comment', user: user('a'), text: 'Xin chào cả nhà!' });
  assert.equal(a.state, 'talk');
  assert.equal(a.bubble.text, 'Xin chào cả nhà!');
  step(w, 0.6);
  assert.deepEqual([b.state, b.kind, b.bubble], ['talk', 'nod', null]);
  assert.equal(c.kind, 'nod');
  step(w, 5);
  assert.equal(a.bubble, null, 'bubble expires');

  // At most MAX_BUBBLES bubbles stay: the oldest one fades out quickly.
  const many = world();
  const talkers = populate(many, ['t1', 't2', 't3', 't4', 't5']);
  talkers.forEach((t, i) => {
    many.handle({ type: 'comment', user: user(t.id), text: `line ${i}` });
    many.update(0.05);
  });
  step(many, 0.4);
  assert.deepEqual(talkers.map((t) => Boolean(t.bubble)), [false, false, true, true, true]);
  assert.equal(MAX_BUBBLES, 3);

  w.handle({ type: 'like', user: user('b') });
  assert.equal(b.state, 'heart');
  step(w, 0.2);
  assert.ok(w.effects.some((p) => p.kind === 'heart'));
  step(w, 3);
  w.handle({ type: 'follow', user: user('c') });
  assert.equal(c.state, 'star');
  step(w, 0.6);
  assert.ok(w.effects.some((p) => p.kind === 'star'));
  assert.ok(['star', 'idle', 'walk'].includes(a.state));
});

test('join: newcomer waves after landing and a neighbour waves back', () => {
  const w = world();
  const [old] = populate(w, ['old']);
  Object.assign(old, { x: 500, targetX: 500, y: 600, targetY: 600, greetAt: Infinity });
  w.handle({ type: 'join', user: user('new') });
  const n = w.find('new');
  Object.assign(n, { x: 600, targetX: 600, y: 600, targetY: 600, greetAt: Infinity });
  step(w, ENTER_DUR + 0.2);
  assert.equal(n.state, 'wave');
  assert.equal(old.state, 'wave');
  assert.equal(old.dir, 1, 'faces the newcomer');
});

test('greeting: two nearby characters wave facing each other with "hello" bubbles', () => {
  const w = world();
  const [a, b] = populate(w, ['a', 'b']);
  Object.assign(a, { x: 450, y: 600, dir: -1 });
  Object.assign(b, { x: 560, y: 600, dir: 1 });
  greet(w, a, b);
  assert.deepEqual([a.state, b.state], ['wave', 'wave']);
  assert.deepEqual([a.dir, b.dir], [1, -1]);
  assert.ok(a.bubble);
  step(w, 0.5);
  assert.ok(b.bubble);
  assert.equal(w.stats.greetings, 1);
  assert.ok(a.greetAt > w.time && b.greetAt > w.time, 'cooldown');

  // And the random tick finds such pairs by itself (rng forced to "always").
  const t = world({ rng: () => 0 });
  const [c, d] = populate(t, ['c', 'd']);
  Object.assign(c, { x: 450, targetX: 450, y: 600, targetY: 600, greetAt: 0 });
  Object.assign(d, { x: 520, targetX: 520, y: 600, targetY: 600, greetAt: 0 });
  step(t, GREETING.every + 0.05);
  assert.equal(t.stats.greetings, 1);
});

test('group dance: everyone hops in sync every 25-40 s; can be turned off', () => {
  const w = world();
  populate(w, ['a', 'b', 'c']);
  assert.ok(w.groupTimer >= GROUP_DANCE.min && w.groupTimer <= GROUP_DANCE.max);
  assert.equal(groupDance(w), 3);
  assert.ok(w.characters.every((c) => c.state === 'dance' && c.sync));
  const poses = new Set(w.characters.map((c) => poseFor(c, w.time)));
  assert.equal(poses.size, 1, 'same frame at the same time');

  const on = world();
  populate(on, ['a', 'b']);
  step(on, GROUP_DANCE.max + 0.5, 1 / 30);
  assert.ok(on.stats.groupDances >= 1, 'happens on its own within 40 s');

  const off = world({ groupDance: false });
  populate(off, ['a', 'b']);
  step(off, GROUP_DANCE.max * 2, 1 / 30);
  assert.equal(off.stats.groupDances, 0);
});

test('leaderboard: top gifters wear a crown; changes update it', () => {
  const w = world();
  populate(w, ['a', 'b', 'c']);
  w.setLeaderboard([{ rank: 1, userId: 'b' }, { rank: 2, userId: 'a' }]);
  assert.deepEqual(w.characters.map((c) => [c.id, c.crown]), [['a', 2], ['b', 1], ['c', 0]]);
  w.setLeaderboard([{ rank: 1, userId: 'c' }]);
  assert.deepEqual(w.characters.map((c) => c.crown), [0, 0, 1]);
  w.handle({ type: 'join', user: user('d') });
  w.setLeaderboard([{ rank: 1, userId: 'd' }]);
  assert.equal(w.find('d').crown, 1);
  w.handle({ type: 'join', user: user('e') });
  w.setLeaderboard([{ rank: 3, userId: 'zz' }]);
  w.ranks.set('late', 2);
  w.handle({ type: 'join', user: user('late') });
  assert.equal(w.find('late').crown, 2, 'spawned characters pick up their rank');
  w.clear();
  assert.equal(w.characters.length, 0);
});

// ---------- config ----------
test('config: characters defaults, validation and partial merge', () => {
  assert.deepEqual(defaultConfig().characters, { enabled: true, max: 12, scale: 3, groupDance: true });
  assert.deepEqual(CLIENT_DEFAULTS, CHARACTER_DEFAULTS, 'client and server defaults agree');
  assert.deepEqual(validateConfigPatch({ characters: { max: 8 } }), { characters: { max: 8 } });
  for (const bad of [
    { characters: { max: 0 } }, { characters: { max: 21 } }, { characters: { max: 2.5 } }, { characters: { scale: 7 } },
    { characters: { scale: 0 } }, { characters: { enabled: 'yes' } }, { characters: { groupDance: 1 } },
    { characters: { evil: true } }, { characters: null }, { characters: [] }, { characters: 'on' },
  ]) {
    assert.throws(() => validateConfigPatch(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  const cfg = defaultConfig();
  applyConfigPatch(cfg, validateConfigPatch({ characters: { max: 4 }, theme: 'neon' }));
  assert.deepEqual(cfg.characters, { enabled: true, max: 4, scale: 3, groupDance: true });
  applyConfigPatch(cfg, validateConfigPatch({ characters: { enabled: false } }));
  assert.deepEqual(cfg.characters, { enabled: false, max: 4, scale: 3, groupDance: true });
  // Settings file with a partial / bad characters block.
  assert.deepEqual(sanitizeConfig({ characters: { scale: 5 } }).config.characters, { enabled: true, max: 12, scale: 5, groupDance: true });
  const { config, problems } = sanitizeConfig({ characters: { max: 99 } });
  assert.deepEqual(config.characters, CHARACTER_DEFAULTS);
  assert.equal(problems.length, 1);
});

// ---------- server ----------
let app;
let base;
before(async () => {
  app = createOverlayServer({ mock: false, logger: { log() {}, warn() {}, error() {} } });
  base = await app.listen(0);
});
after(() => app.close());
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST /api/characters/spawn: joins fake viewers over WS, validates count', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const msgs = [];
  ws.on('message', (b) => msgs.push(JSON.parse(b)));
  await new Promise((r) => ws.once('open', r));
  const res = await post('/api/characters/spawn', { count: 4 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.spawned.length, 4);
  assert.equal(new Set(body.spawned.map((u) => u.id)).size, 4);
  const end = Date.now() + 2000;
  while (msgs.filter((m) => m.kind === 'event' && m.data.type === 'join').length < 4 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  const joins = msgs.filter((m) => m.kind === 'event' && m.data.type === 'join').map((m) => m.data.user.id);
  assert.deepEqual(joins, body.spawned.map((u) => u.id));
  assert.equal((await (await post('/api/characters/spawn', {})).json()).spawned.length, 3, 'default count 3');
  for (const count of [0, 21, -1, 2.5, '3', null]) assert.equal((await post('/api/characters/spawn', { count })).status, 400, String(count));
  ws.close();
  app.mockGen.stop(); // drop pending follow-up comments
});

test('POST /api/config characters: merged, broadcast, reported in /health; bad values 400', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const msgs = [];
  ws.on('message', (b) => msgs.push(JSON.parse(b)));
  await new Promise((r) => ws.once('open', r));
  const r = await post('/api/config', { characters: { max: 7, groupDance: false } });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).config.characters, { enabled: true, max: 7, scale: 3, groupDance: false });
  const end = Date.now() + 2000;
  while (!msgs.some((m) => m.kind === 'config') && Date.now() < end) await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(msgs.find((m) => m.kind === 'config').data.characters, { enabled: true, max: 7, scale: 3, groupDance: false });
  assert.equal(msgs[0].kind, 'hello');
  assert.ok(msgs[0].data.config.characters, 'hello carries characters config');
  assert.equal((await post('/api/config', { characters: { max: 50 } })).status, 400);
  assert.equal((await post('/api/config', { characters: { scale: 3, hack: 1 } })).status, 400);
  assert.equal((await (await fetch(base + '/health')).json()).config.characters.max, 7);
  ws.close();
});

test('mock generator: greet() joins a crowd, viewers() makes unique viewers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const g = new MockGenerator({ emit: (e) => events.push(e), seed: 1 });
  g.greet(8);
  t.mock.timers.tick(5000);
  const joins = events.filter((e) => e.type === 'join');
  assert.equal(joins.length, 8);
  assert.ok(joins.length >= 6 && joins.length <= 10, '6-10 characters for the preview');
  const v = g.viewers(10);
  assert.equal(new Set(v.map((u) => u.id)).size, 10);
  const many = new Set(Array.from({ length: 50 }, () => g.viewers(20)).flat().map((u) => u.id));
  assert.equal(many.size, 1000, 'no id collisions');
  const quiet = [];
  const q = new MockGenerator({ emit: (e) => quiet.push(e), seed: 2 });
  q.viewers(10, { chat: false });
  t.mock.timers.tick(10_000);
  assert.ok(quiet.every((e) => e.type === 'join'), 'no fake chat while a real room is connected');
  t.mock.timers.tick(5000);
  assert.ok(events.some((e) => e.type === 'comment' && v.some((u) => u.id === e.user.id)), 'some viewers say hi');
  g.stop();
});

// ---------- markup / assets ----------
test('overlay: canvas between particles and banner, z-order, OBS-safe, no external assets', () => {
  const html = read('../public/overlay.html');
  const css = read('../public/css/overlay.css');
  assert.match(html, /id="particles"[\s\S]*<canvas id="characters" class="chars" aria-hidden="true"><\/canvas>[\s\S]*id="banner"/);
  const z = (sel) => Number(new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*z-index:\\s*(\\d+)`).exec(css)?.[1]);
  assert.ok(z('.particles') < z('.chars'), 'characters above particles');
  assert.match(css, /\.banner,\s*\.board,\s*\.combo,\s*\.ticker\s*\{\s*z-index:\s*3/);
  assert.ok(z('.chars') < 3);
  assert.match(css, /\.chars\s*\{[^}]*bottom:\s*12%[^}]*height:\s*38%[^}]*pointer-events:\s*none[^}]*image-rendering:\s*pixelated/);
  for (const f of ['characters.js', 'characters-sprite.js', 'characters-render.js', 'characters-interact.js']) {
    const src = read(`../public/js/${f}`);
    assert.doesNotMatch(src, /https?:\/\/|url\(|['\"`][^'\"`]*\.(png|gif|webp|jpe?g|svg)['\"`]|new Image|fetch\(|@font-face|import\s*\(/, `${f} uses no external assets`);
  }
  const render = read('../public/js/characters-render.js');
  assert.match(render, /imageSmoothingEnabled = false/);
  assert.equal((read('../public/js/characters.js').match(/requestAnimationFrame\(/g) ?? []).length, 2, 'one loop: start + self re-schedule');
  assert.match(read('../public/js/characters.js'), /cancelAnimationFrame/);
  assert.match(read('../public/js/overlay.js'), /pagehide/);
  const pkg = JSON.parse(read('../package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['express', 'tiktok-live-connector', 'ws'], 'no new npm packages');
});

test('panel: "Nhân vật pixel" section with switch, sliders, group-dance switch and spawn button', () => {
  const html = read('../public/panel.html').replace(/<!--[\s\S]*?-->/g, '');
  const js = read('../public/js/panel.js');
  const sec = html.slice(html.indexOf('id="chars"'), html.indexOf('id="advanced"'));
  assert.match(sec, /Nhân vật pixel<\/h2>/);
  assert.match(sec, /<label class="switch"><input type="checkbox" id="chars-enabled" \/>/);
  assert.match(sec, /<label class="switch"><input type="checkbox" id="chars-group" \/>/);
  assert.match(sec, /<input type="range" id="chars-max" min="1" max="20" step="1"/);
  assert.match(sec, /<input type="range" id="chars-scale" min="1" max="6" step="1"/);
  assert.match(sec, /<label for="chars-max">/);
  assert.match(sec, /<label for="chars-scale">/);
  assert.match(sec, /id="chars-spawn"[^>]*>👾 Bắn thử nhân vật<\/button>/);
  assert.match(js, /setConfig\(\{ characters: \{ enabled:/);
  assert.match(js, /setConfig\(\{ characters: \{ groupDance:/);
  assert.match(js, /api\('\/characters\/spawn', \{ count: 3 \}\)/);
});
