// Particle bursts: rose petals, gold sparkles, falling gift icons.
// Pure DOM + Web Animations API, animating transform/opacity only.
// Live particle count is hard-capped to keep OBS frame times stable.

import { tierFor, particleCount } from './tiers.js';

export const MAX_LIVE_PARTICLES = 160;

// Falling icons per theme (system emoji font, no image assets).
const ICONS = {
  temple: ['🌹', '🪷', '✨', '🏮', '🌸'],
  neon: ['💎', '⚡', '✨', '💜', '🔷'],
  tet: ['🧧', '🏮', '🌼', '✨', '🎆'],
};

const rnd = (a, b) => a + Math.random() * (b - a);

export class Particles {
  constructor(layer) {
    this.layer = layer;
    this.live = 0;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Burst for a finalized gift worth `diamondTotal` diamonds. Returns particles spawned. */
  burst(diamondTotal) {
    const tier = tierFor(diamondTotal);
    let n = particleCount(diamondTotal);
    if (this.reduced) n = Math.ceil(n / 4);
    n = Math.min(n, MAX_LIVE_PARTICLES - this.live);
    if (n <= 0) return 0;

    const { width: w, height: h } = this.layer.getBoundingClientRect();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const kind =
        tier === 'petals' ? 'petal' : tier === 'sparkle' ? (i % 3 ? 'spark' : 'petal') : tier === 'rain' ? (i % 2 ? 'icon' : 'spark') : ['petal', 'spark', 'icon'][i % 3];
      frag.appendChild(this.#spawn(kind, w, h, i));
    }
    this.layer.appendChild(frag);
    return n;
  }

  #spawn(kind, w, h, i) {
    const el = document.createElement('i');
    el.className = `p p--${kind}${i % 2 ? ' alt' : ''}`;
    if (kind === 'icon') {
      const set = ICONS[document.documentElement.dataset.theme] ?? ICONS.temple;
      el.textContent = set[i % set.length];
    }
    this.live++;

    let frames;
    let duration;
    if (kind === 'spark') {
      // Radial burst from upper-center.
      const cx = w * 0.5;
      const cy = h * 0.3;
      const ang = rnd(0, Math.PI * 2);
      const dist = rnd(0.12, 0.42) * Math.min(w, h);
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist;
      frames = [
        { transform: `translate(${cx}px, ${cy}px) scale(0.4) rotate(0deg)`, opacity: 0 },
        { transform: `translate(${cx + dx * 0.6}px, ${cy + dy * 0.6}px) scale(1.2) rotate(90deg)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${cx + dx}px, ${cy + dy + h * 0.08}px) scale(0.3) rotate(220deg)`, opacity: 0 },
      ];
      duration = rnd(900, 1600);
    } else {
      // Falling petals / icons with sideways drift and spin.
      const x0 = rnd(0, w);
      const drift = rnd(-0.18, 0.18) * w;
      const spin = rnd(-540, 540);
      frames = [
        { transform: `translate(${x0}px, ${-0.05 * h}px) rotate(0deg)`, opacity: 0 },
        { transform: `translate(${x0 + drift * 0.3}px, ${0.1 * h}px) rotate(${spin * 0.2}deg)`, opacity: 1, offset: 0.12 },
        { transform: `translate(${x0 + drift}px, ${rnd(0.75, 1.02) * h}px) rotate(${spin}deg)`, opacity: 0 },
      ];
      duration = rnd(2400, 4200);
    }
    const anim = el.animate(frames, { duration, delay: rnd(0, 450), easing: 'cubic-bezier(.25,.6,.4,1)', fill: 'both' });
    anim.onfinish = anim.oncancel = () => {
      el.remove();
      this.live--;
    };
    return el;
  }

  clear() {
    for (const a of this.layer.getAnimations({ subtree: true })) a.cancel();
    this.layer.replaceChildren();
    this.live = 0;
  }
}
