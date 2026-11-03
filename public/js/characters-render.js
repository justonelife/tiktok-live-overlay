// Canvas 2D renderer for the pixel characters. Sprites are painted once per
// (character, pose, theme) onto tiny detached 1x canvases and drawn scaled
// up with imageSmoothingEnabled = false, so they stay razor sharp at any
// integer size. Outline / shadow / bubble / crown colours come from the
// active theme's CSS custom properties (themes.css), never hardcoded.

import { SPRITE_W, SPRITE_H, FEET_ROW, spriteGrid, paletteFor, topRow, iconGrid, ICONS } from './characters-sprite.js';
import { poseFor, motionFor } from './characters.js';

/** Theme colours for the character layer, read from CSS variables on `root`. */
export function readThemeColors(root) {
  const cs = getComputedStyle(root);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    outline: v('--panel-bg-2', '#1a1a1a'),
    shadow: v('--panel-bg-2', '#000000'),
    bubbleBg: v('--panel-bg', '#222222'),
    bubbleBorder: v('--panel-border', '#ffffff'),
    bubbleText: v('--text', '#ffffff'),
    nameText: v('--text', '#ffffff'),
    crown: [v('--rank-1', '#f2c94c'), v('--rank-2', '#d9d9d9'), v('--rank-3', '#d7905a'), v('--accent', '#f2c94c')],
    gem: v('--particle-1', '#c2183b'),
    heart: v('--particle-3', '#ff8fa3'),
    star: v('--rank-1', '#f2c94c'),
    spark: v('--particle-2', '#f6d27a'),
    puff: v('--text-muted', '#cccccc'),
    font: v('--font-body', 'system-ui, sans-serif'),
  };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); // detached, never inserted into the DOM
  c.width = w;
  c.height = h;
  return c;
}

function paint(data, w, h, palette) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  for (let i = 0; i < data.length; i++) {
    const color = palette[data[i]];
    if (!color) continue;
    g.fillStyle = color;
    g.fillRect(i % w, Math.floor(i / w), 1, 1);
  }
  return c;
}

export class CharacterRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = null;
    this.sprites = new Map(); // `${id}|${pose}` -> canvas
    this.tops = new Map(); // look.key -> first content row
    this.icons = {};
    this.order = []; // reused draw-order array
    this.bubbleBoxes = []; // reused per frame
    this.nameBoxes = []; // label rects drawn this frame (collision avoidance)
    this.nameQueue = []; // characters whose label is painted after all sprites
    this.nameWidths = new Map(); // `${font}|${name}` -> px
    this.frame = 0;
  }

  setColors(colors) {
    this.colors = colors;
    this.blank = false;
    this.sprites.clear();
    this.nameWidths.clear();
    const o = colors.outline;
    const icon = (rows, main, second = main) => {
      const { w, h, data } = iconGrid(rows);
      return { img: paint(data, w, h, [null, o, main, second]), w, h };
    };
    this.icons = {
      heart: icon(ICONS.heart, colors.heart),
      star: icon(ICONS.star, colors.star),
      spark: icon(ICONS.spark, colors.spark, colors.star),
      puff: icon(ICONS.puff, colors.puff),
      crowns: colors.crown.map((c) => icon(ICONS.crown, c, colors.gem)),
    };
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.sprites.clear();
    this.blank = true;
  }

  sprite(ch, pose) {
    const key = `${ch.id}|${pose}`;
    let img = this.sprites.get(key);
    if (!img) {
      img = paint(spriteGrid(ch.look, pose), SPRITE_W, SPRITE_H, paletteFor(ch.look, this.colors.outline));
      this.sprites.set(key, img);
    }
    return img;
  }

  top(look) {
    let t = this.tops.get(look.key);
    if (t === undefined) {
      t = topRow(spriteGrid(look, 'idleA'));
      this.tops.set(look.key, t);
    }
    return t;
  }

  #prune(world) {
    const ids = new Set(world.characters.map((c) => c.id));
    for (const key of this.sprites.keys()) if (!ids.has(key.slice(0, key.lastIndexOf('|')))) this.sprites.delete(key);
    if (this.tops.size > 256) this.tops.clear();
    if (this.nameWidths.size > 256) this.nameWidths.clear();
  }

  draw(world) {
    const { ctx, colors } = this;
    if (!colors) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // Empty stage: clear once, then skip the work until something appears.
    const empty = world.characters.length === 0 && world.effects.length === 0;
    if (empty && this.blank) return;
    this.blank = empty;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    if (++this.frame % 240 === 0) this.#prune(world);

    const px = world.pixel;
    const order = this.order;
    order.length = 0;
    for (const c of world.characters) order.push(c);
    order.sort((a, b) => a.y - b.y); // back to front

    const fontPx = Math.max(11, Math.min(28, Math.round(px * 2.2)));
    const nameFont = `700 ${fontPx}px ${colors.font}`;
    this.nameBoxes.length = 0; // fresh label layout every frame
    const nameQueue = this.nameQueue;
    nameQueue.length = 0;

    for (const ch of order) {
      const m = motionFor(ch, world);
      const x = Math.round(ch.x);
      const feet = Math.round(ch.y);
      const s = m.scale;
      const w = Math.round(SPRITE_W * px * s);
      const h = Math.round(SPRITE_H * px * s);
      const top = Math.round(feet + m.dy - (FEET_ROW + 1) * px * s);
      const left = Math.round(x - (SPRITE_W / 2) * px * s);

      // Pixel shadow (shrinks while airborne).
      const air = Math.min(1, -m.dy / (8 * px));
      if (ch.state !== 'enter' || air < 1) {
        const sw = Math.round(10 * px * (1 - 0.5 * air));
        ctx.globalAlpha = 0.35 * m.alpha;
        ctx.fillStyle = colors.shadow;
        ctx.fillRect(x - (sw >> 1), feet - px, sw, px * 2);
        ctx.fillRect(x - (sw >> 1) + px, feet - px * 2, sw - 2 * px, px * 4);
      }

      ctx.globalAlpha = m.alpha;
      const img = this.sprite(ch, poseFor(ch, world.time));
      if (ch.dir < 0) {
        ctx.setTransform(-1, 0, 0, 1, 2 * x, 0);
        ctx.drawImage(img, left, top, w, h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      } else ctx.drawImage(img, left, top, w, h);

      // Leaderboard crown above the head (and above any hat).
      const headTop = top + this.top(ch.look) * px * s;
      ch._headTop = headTop;
      if (ch.crown && ch.state !== 'leave') {
        const crown = this.icons.crowns[Math.min(ch.crown, 4) - 1];
        const cw = crown.w * px;
        const chh = crown.h * px;
        ctx.drawImage(crown.img, x - (cw >> 1), headTop - chh + px, cw, chh);
        ch._headTop = headTop - chh + px;
      }

      // Name tags are collected here and painted after every sprite, so a
      // character standing in front can never hide somebody else's label.
      if (ch.state !== 'leave' && ch.state !== 'enter') nameQueue.push(ch);
    }
    ctx.globalAlpha = 1;

    // 1) Name tags, front-most first (the closest label wins a clash).
    for (let i = nameQueue.length - 1; i >= 0; i--) {
      const ch = nameQueue[i];
      const x = Math.round(ch.x);
      const feet = Math.round(ch.y);
      const name = ch.name.length > 14 ? `${Array.from(ch.name).slice(0, 13).join('')}…` : ch.name;
      const nameKey = `${nameFont}|${name}`;
      let nw = this.nameWidths.get(nameKey);
      if (nw === undefined) {
        ctx.font = nameFont;
        nw = Math.ceil(ctx.measureText(name).width);
        this.nameWidths.set(nameKey, nw);
      }
      const nh = Math.round(fontPx * 1.3);
      const ny = Math.round(feet + px * 1.2);
      const nx = Math.round(x - nw / 2);
      const clash = this.nameBoxes.some((b) => nx < b.x + b.w && nx + nw > b.x && ny < b.y + b.h && ny + nh > b.y);
      if (clash) continue;
      this.nameBoxes.push({ x: nx, y: ny, w: nw, h: nh });
      ctx.globalAlpha = 0.92;
      ctx.font = nameFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, Math.round(fontPx / 5));
      ctx.lineJoin = 'round';
      ctx.strokeStyle = colors.outline;
      ctx.strokeText(name, x, ny);
      ctx.fillStyle = colors.nameText;
      ctx.fillText(name, x, ny);
    }
    ctx.globalAlpha = 1;

    // 2) Speech bubbles on top of every character and label, front-most last.
    this.bubbleBoxes.length = 0;
    for (const ch of order) if (ch.bubble && ch.state !== 'leave') this.#bubble(ch, world, W);

    // Effect particles.
    for (const p of world.effects) {
      const icon = this.icons[p.kind];
      if (!icon) continue;
      const u = Math.max(2, Math.round(px * (p.kind === 'puff' ? 0.8 : 0.6)));
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.ttl);
      ctx.drawImage(icon.img, Math.round(p.x - (icon.w * u) / 2), Math.round(p.y - (icon.h * u) / 2), icon.w * u, icon.h * u);
    }
    ctx.globalAlpha = 1;
  }

  #bubble(ch, world, W) {
    const { ctx, colors } = this;
    const px = world.pixel;
    const fs = Math.max(12, Math.min(32, Math.round(px * 2.4)));
    const font = `700 ${fs}px ${colors.font}`;
    const key = `${font}|${ch.bubble.text}`;
    let tw = this.nameWidths.get(key);
    if (tw === undefined) {
      ctx.font = font;
      tw = Math.ceil(ctx.measureText(ch.bubble.text).width);
      this.nameWidths.set(key, tw);
    }
    const u = Math.max(2, Math.round(px / 3)); // bubble "pixel"
    const pad = Math.round(fs * 0.6);
    const bw = Math.round((tw + pad * 2) / u) * u;
    const bh = Math.round((fs + pad * 1.2) / u) * u;
    const x = Math.round(ch.x);
    let bx = Math.round(x - bw / 2);
    bx = Math.max(u, Math.min(W - bw - u, bx));
    let by = Math.round((ch._headTop ?? ch.y - 18 * px) - bh - 3 * u);
    // Never cover an already-placed bubble or a name tag drawn this frame:
    // step upwards until the slot is free.
    for (let tries = 0; tries < 5; tries++) {
      const hit =
        this.bubbleBoxes.find((b) => bx < b.x + b.w && bx + bw > b.x && by < b.y + b.h && by + bh > b.y) ||
        this.nameBoxes.find((b) => bx < b.x + b.w && bx + bw > b.x && by < b.y + b.h && by + bh > b.y);
      if (!hit) break;
      by = hit.y - bh - u;
    }
    by = Math.max(u, by);
    this.bubbleBoxes.push({ x: bx, y: by, w: bw, h: bh });

    const left = ch.bubble.until - world.time;
    const age = world.time - ch.bubble.born;
    ctx.globalAlpha = Math.max(0, Math.min(1, left / 0.3, age / 0.12));
    const tx = Math.max(bx + 3 * u, Math.min(bx + bw - 3 * u, x));
    // Border (stepped corners) + tail.
    ctx.fillStyle = colors.bubbleBorder;
    ctx.fillRect(bx + u, by, bw - 2 * u, bh);
    ctx.fillRect(bx, by + u, bw, bh - 2 * u);
    ctx.fillRect(tx - 2 * u, by + bh - u, 4 * u, 2 * u);
    ctx.fillRect(tx - u, by + bh + u, 2 * u, u);
    // Fill.
    ctx.fillStyle = colors.bubbleBg;
    ctx.fillRect(bx + 2 * u, by + u, bw - 4 * u, bh - 2 * u);
    ctx.fillRect(bx + u, by + 2 * u, bw - 2 * u, bh - 4 * u);
    ctx.fillRect(tx - u, by + bh - u, 2 * u, u);
    // Text.
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.bubbleText;
    ctx.fillText(ch.bubble.text, bx + bw / 2, by + bh / 2 + 1);
    ctx.globalAlpha = 1;
  }
}
