// Procedural pixel-art sprites for the viewer characters. No image assets:
// every sprite is a small grid of palette slots built in code, then painted
// onto a tiny 1x canvas and scaled up with nearest-neighbour by the renderer.
//
// Appearance is deterministic: hash(user id) -> seed -> PRNG -> picks. The
// same viewer always gets the same body, skin, hair, clothes and accessory.
// Pure module (no DOM at import time) so Node tests can use it.

/** Sprite canvas: a 16x16 body placed at (BODY_X, BODY_Y) with room for hats and the outline. */
export const SPRITE_W = 18;
export const SPRITE_H = 20;
export const BODY_X = 1;
export const BODY_Y = 3;
/** Row of the shoes in sprite coordinates (feet line = bottom of this row). */
export const FEET_ROW = BODY_Y + 14;

/** FNV-1a 32-bit over UTF-16 code units. */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32), same as src/mock.js. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Body archetypes, in 16x16 body coordinates. Legs: rows y..y+h-1, last row = shoes.
export const ARCHETYPES = Object.freeze({
  classic: { head: { x: 4, y: 1, w: 8, h: 7 }, torso: { x: 5, y: 8, w: 6, h: 4 }, arms: { l: 4, r: 11, y: 8, len: 3 }, legs: { y: 12, h: 3, l: 5, r: 9, w: 2 } },
  stocky: { head: { x: 4, y: 1, w: 8, h: 7 }, torso: { x: 4, y: 8, w: 8, h: 4 }, arms: { l: 3, r: 12, y: 8, len: 3 }, legs: { y: 12, h: 3, l: 5, r: 9, w: 2 } },
  tall: { head: { x: 5, y: 1, w: 6, h: 6 }, torso: { x: 5, y: 7, w: 6, h: 4 }, arms: { l: 4, r: 11, y: 7, len: 4 }, legs: { y: 11, h: 4, l: 5, r: 9, w: 2 } },
  chibi: { head: { x: 3, y: 1, w: 10, h: 8 }, torso: { x: 5, y: 9, w: 6, h: 3 }, arms: { l: 4, r: 11, y: 9, len: 2 }, legs: { y: 12, h: 3, l: 5, r: 9, w: 2 } },
});
export const BODIES = Object.freeze(Object.keys(ARCHETYPES));
export const HAIR_STYLES = Object.freeze(['short', 'spiky', 'long', 'bangs', 'bun', 'mohawk']);
export const ACCESSORIES = Object.freeze(['cap', 'nonla', 'headphones', 'glasses', 'catears']);

export const SKINS = Object.freeze(['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffe0bd']);
export const HAIR_COLORS = Object.freeze(['#2b1d14', '#4a2c1a', '#8b5a2b', '#d6b370', '#e8e8e8', '#c0392b', '#7d3cff', '#1e90ff', '#ff6fae', '#151515']);
export const SHIRTS = Object.freeze(['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ff6b9d', '#ecf0f1', '#34495e']);
export const PANTS = Object.freeze(['#2c3e50', '#34495e', '#5d4037', '#1f3a93', '#4b4b4b', '#6d214f']);
export const SHOES = Object.freeze(['#222222', '#6b3e26', '#f5f5f5', '#b03a2e']);
export const ACC_COLORS = Object.freeze(['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#8338ec', '#ffbe0b', '#fb5607', '#06d6a0']);

/** Palette slots used in sprite grids. 0 = transparent. */
export const SLOT = Object.freeze({
  none: 0, outline: 1, skin: 2, skinShade: 3, hair: 4, hairShade: 5, shirt: 6, shirtShade: 7,
  pants: 8, shoes: 9, eye: 10, mouth: 11, blush: 12, acc: 13, accShade: 14, white: 15,
});

/**
 * Deterministic appearance for a user id.
 * @returns {{key:string, seed:number, body:string, skin:string, hairStyle:string, hair:string, shirt:string,
 *   pants:string, shoes:string, accessory:string, accColor:string, blush:boolean, lane:number, pace:number}}
 */
export function appearanceFor(id) {
  const seed = hashString(id);
  const r = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  return {
    key: seed.toString(36),
    seed,
    body: pick(BODIES),
    skin: pick(SKINS),
    hairStyle: pick(HAIR_STYLES),
    hair: pick(HAIR_COLORS),
    shirt: pick(SHIRTS),
    pants: pick(PANTS),
    shoes: pick(SHOES),
    accessory: pick(ACCESSORIES),
    accColor: pick(ACC_COLORS),
    blush: r() < 0.45,
    lane: r(), // preferred depth on the stage, 0 = back, 1 = front
    pace: r(), // walking speed factor
  };
}

// Pose = body shift + arm/leg/face variants. Frames are picked by the state machine.
export const POSES = Object.freeze({
  idleA: {},
  idleB: { dy: 1 },
  blink: { eyes: 'closed' },
  walkA: { legs: 'stepA' },
  walkM: { dy: 1 },
  walkB: { legs: 'stepB' },
  waveA: { armR: 'up', mouth: 'smile' },
  waveB: { armR: 'wave', mouth: 'smile' },
  danceA: { armL: 'up', legs: 'stepA', mouth: 'smile', eyes: 'closed' },
  danceB: { armR: 'up', legs: 'stepB', dy: 1, mouth: 'smile', eyes: 'closed' },
  cheer: { armL: 'up', armR: 'up', mouth: 'open', eyes: 'closed' },
  talkA: { mouth: 'open', armR: 'out' },
  talkB: { mouth: 'smile' },
  heart: { armL: 'out', armR: 'out', mouth: 'smile', eyes: 'closed' },
});
export const POSE_NAMES = Object.freeze(Object.keys(POSES));

/**
 * Build the slot grid (Uint8Array SPRITE_W*SPRITE_H, row-major) for `look` in `poseName`.
 * Pure and deterministic. Sprites face right; the renderer mirrors them.
 */
export function spriteGrid(look, poseName = 'idleA') {
  const pose = POSES[poseName] ?? POSES.idleA;
  const A = ARCHETYPES[look.body] ?? ARCHETYPES.classic;
  const g = new Uint8Array(SPRITE_W * SPRITE_H);
  const put = (x, y, slot) => {
    const gx = x + BODY_X;
    const gy = y + BODY_Y;
    if (gx >= 0 && gx < SPRITE_W && gy >= 0 && gy < SPRITE_H) g[gy * SPRITE_W + gx] = slot;
  };
  const rect = (x, y, w, h, slot) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, slot);
  };
  const S = SLOT;
  const dy = pose.dy ?? 0;
  const { head: H, torso: T, arms: AR, legs: L } = A;
  const hx = H.x;
  const hy = H.y + dy;
  const hw = H.w;
  const hh = H.h;

  // Legs (not shifted by dy, so breathing/bobbing keeps the feet planted).
  for (const [side, lx] of [['l', L.l], ['r', L.r]]) {
    const lift = (pose.legs === 'stepA' && side === 'r') || (pose.legs === 'stepB' && side === 'l') ? 1 : 0;
    const shoeRow = L.y + L.h - 1 - lift;
    rect(lx, L.y, L.w, shoeRow - L.y, S.pants);
    rect(lx, shoeRow, L.w + 1, 1, S.shoes); // +1 = toe, sprites face right
  }

  // Long hair falls behind the body.
  if (look.hairStyle === 'long') {
    rect(hx - 1, hy + 1, 1, hh, S.hair);
    rect(hx + hw, hy + 1, 1, hh, S.hairShade);
  }

  // Torso: shirt, shaded right edge, waist row in pants colour, little neck notch.
  rect(T.x, T.y + dy, T.w, T.h, S.shirt);
  rect(T.x + T.w - 1, T.y + dy, 1, T.h - 1, S.shirtShade);
  rect(T.x, T.y + dy + T.h - 1, T.w, 1, S.pants);
  put(T.x + (T.w >> 1) - 1, T.y + dy, S.skinShade);
  put(T.x + (T.w >> 1), T.y + dy, S.skinShade);

  // Head with rounded corners.
  rect(hx, hy, hw, hh, S.skin);
  rect(hx + hw - 1, hy + 1, 1, hh - 2, S.skinShade);
  for (const [x, y] of [[hx, hy], [hx + hw - 1, hy], [hx, hy + hh - 1], [hx + hw - 1, hy + hh - 1]]) put(x, y, S.none);

  // Face.
  const ey = hy + (hh >> 1);
  const e1 = hx + (hw >> 2);
  const e2 = hx + hw - 1 - (hw >> 2);
  if (pose.eyes === 'closed') {
    put(e1, ey + 1, S.eye);
    put(e2, ey + 1, S.eye);
  } else {
    rect(e1, ey, 1, 2, S.eye);
    rect(e2, ey, 1, 2, S.eye);
  }
  if (look.blush) {
    put(e1 - 1, ey + 2, S.blush);
    put(e2 + 1, ey + 2, S.blush);
  }
  const mx = hx + (hw >> 1) - 1;
  const my = ey + 2;
  if (pose.mouth === 'open') rect(mx, my, 2, hh >= 8 ? 2 : 1, S.mouth);
  else if (pose.mouth === 'smile') rect(mx, my, 2, 1, S.blush);

  // Front hair.
  const top = () => {
    rect(hx, hy, hw, 2, S.hair);
    put(hx + hw - 1, hy, S.hairShade);
    put(hx, hy + 2, S.hair);
    put(hx + hw - 1, hy + 2, S.hairShade);
  };
  switch (look.hairStyle) {
    case 'spiky':
      top();
      for (let x = hx; x < hx + hw; x += 2) put(x, hy - 1, S.hair);
      break;
    case 'long':
      top();
      rect(hx, hy + 2, 1, hh - 3, S.hair);
      rect(hx + hw - 1, hy + 2, 1, hh - 3, S.hairShade);
      break;
    case 'bangs':
      rect(hx, hy, hw, 3, S.hair);
      put(hx + (hw >> 1) - 1, hy + 2, S.skin);
      put(hx + (hw >> 1), hy + 2, S.skin);
      rect(hx, hy + 3, 1, 2, S.hair);
      rect(hx + hw - 1, hy + 3, 1, 2, S.hairShade);
      break;
    case 'bun':
      top();
      rect(hx + (hw >> 1) - 2, hy - 2, 4, 2, S.hair);
      put(hx + (hw >> 1) + 1, hy - 2, S.hairShade);
      break;
    case 'mohawk':
      rect(hx + 1, hy, hw - 2, 1, S.hairShade);
      rect(hx + (hw >> 1) - 1, hy - 2, 2, 4, S.hair);
      break;
    default:
      top();
  }

  // Accessory.
  const cx = hx + (hw >> 1);
  switch (look.accessory) {
    case 'cap':
      rect(hx, hy - 1, hw, 2, S.acc);
      put(cx - 1, hy - 1, S.white);
      rect(hx + hw - 2, hy + 1, 4, 1, S.accShade); // brim points forward
      break;
    case 'nonla': // Vietnamese conical hat
      rect(cx - 1, hy - 3, 2, 1, S.acc);
      rect(cx - 3, hy - 2, 6, 1, S.acc);
      rect(cx - 5, hy - 1, 10, 1, S.acc);
      for (let x = cx - 4; x < cx + 5; x += 3) put(x, hy - 1, S.accShade);
      rect(cx - 7, hy, 14, 1, S.accShade);
      break;
    case 'headphones':
      rect(hx, hy - 1, hw, 1, S.accShade);
      rect(hx - 1, hy, 1, 2, S.accShade);
      rect(hx + hw, hy, 1, 2, S.accShade);
      rect(hx - 1, hy + 2, 1, 3, S.acc);
      rect(hx + hw, hy + 2, 1, 3, S.acc);
      break;
    case 'glasses':
      rect(e1 - 1, ey, 2, 2, S.accShade);
      rect(e2, ey, 2, 2, S.accShade);
      rect(e1 + 1, ey, e2 - e1 - 1, 1, S.accShade);
      put(e1 - 1, ey, S.white);
      put(e2, ey, S.white);
      put(hx, ey, S.acc);
      put(hx + hw - 1, ey, S.acc);
      break;
    case 'catears':
      put(hx + 1, hy - 2, S.hair);
      rect(hx, hy - 1, 3, 1, S.hair);
      put(hx + 1, hy - 1, S.blush);
      put(hx + hw - 2, hy - 2, S.hair);
      rect(hx + hw - 3, hy - 1, 3, 1, S.hair);
      put(hx + hw - 2, hy - 1, S.blush);
      break;
    default:
      break;
  }

  // Arms last so raised arms draw over the head edge.
  for (const side of [-1, 1]) {
    const c = side > 0 ? AR.r : AR.l;
    const y0 = AR.y + dy;
    const mode = (side > 0 ? pose.armR : pose.armL) ?? 'down';
    if (mode === 'down') {
      put(c, y0, S.shirt);
      rect(c, y0 + 1, 1, AR.len - 1, S.skin);
    } else if (mode === 'out') {
      put(c, y0, S.shirt);
      put(c + side, y0, S.skin);
      put(c + 2 * side, y0, S.skin);
    } else {
      const ux = side > 0 ? Math.max(c + 1, hx + hw) : Math.min(c - 1, hx - 1);
      rect(Math.min(c, ux), y0, Math.abs(ux - c) + 1, 1, S.shirt);
      put(ux, y0 - 1, S.shirt);
      put(ux, y0 - 2, S.skin);
      if (mode === 'wave') put(ux + side, y0 - 3, S.skin);
      else put(ux, y0 - 3, S.skin);
    }
  }

  return outline(g, SPRITE_W, SPRITE_H);
}

/** Add a 1px outline (slot 1) around every filled region. */
function outline(g, w, h) {
  const src = g.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i] !== 0) continue;
      if ((x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w])) g[i] = SLOT.outline;
    }
  }
  return g;
}

/** First non-empty row of a grid (for placing crowns and bubbles above the head). */
export function topRow(grid, w = SPRITE_W) {
  for (let i = 0; i < grid.length; i++) if (grid[i]) return Math.floor(i / w);
  return 0;
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => c(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Slot -> CSS colour for `look`. `outlineColor` comes from the active theme. */
export function paletteFor(look, outlineColor) {
  let acc = look.accColor;
  let accShade = shade(look.accColor, 0.7);
  if (look.accessory === 'nonla') [acc, accShade] = ['#e9c46a', '#b8893a'];
  if (look.accessory === 'headphones') accShade = '#2b2b33';
  if (look.accessory === 'glasses') accShade = '#151515';
  const p = [];
  p[SLOT.none] = null;
  p[SLOT.outline] = outlineColor;
  p[SLOT.skin] = look.skin;
  p[SLOT.skinShade] = shade(look.skin, 0.85);
  p[SLOT.hair] = look.hair;
  p[SLOT.hairShade] = shade(look.hair, 0.75);
  p[SLOT.shirt] = look.shirt;
  p[SLOT.shirtShade] = shade(look.shirt, 0.78);
  p[SLOT.pants] = look.pants;
  p[SLOT.shoes] = look.shoes;
  p[SLOT.eye] = '#1a1220';
  p[SLOT.mouth] = '#5a1020';
  p[SLOT.blush] = '#ff8a9a';
  p[SLOT.acc] = acc;
  p[SLOT.accShade] = accShade;
  p[SLOT.white] = '#ffffff';
  return p;
}

// Small effect icons: '#' = main colour (slot 2), 'o' = second colour (slot 3).
export const ICONS = Object.freeze({
  heart: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
  star: ['...#...', '..###..', '#######', '.#####.', '.##.##.', '.#...#.'],
  crown: ['#..#..#', '##.#.##', '#######', '##ooo##'],
  spark: ['.#.', '#o#', '.#.'],
  puff: ['##', '##'],
});

/** Icon rows -> outlined slot grid { w, h, data }. */
export function iconGrid(rows) {
  const w = rows[0].length + 2;
  const h = rows.length + 2;
  const data = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] !== '.') data[(y + 1) * w + x + 1] = row[x] === 'o' ? 3 : 2;
  });
  return { w, h, data: outline(data, w, h) };
}
