// Mock TikTok LIVE event generator. Produces a seeded, randomized stream of
// raw events: comments, likes, joins, follows, shares and gifts - including
// multi-count streaks (with and without a trailing repeatEnd, so both the
// explicit-end path and the 1500ms quiet-window path are exercised) and a
// small pool of repeat gifters (so per-user "Nth time" counters climb).

export const GIFT_CATALOG = Object.freeze([
  { id: '5655', name: 'Rose', diamond: 1, streakable: true, weight: 30 },
  { id: '5269', name: 'TikTok', diamond: 1, streakable: true, weight: 14 },
  { id: '5487', name: 'Finger Heart', diamond: 5, streakable: true, weight: 16 },
  { id: '5658', name: 'Perfume', diamond: 20, streakable: true, weight: 10 },
  { id: '5879', name: 'Doughnut', diamond: 30, streakable: true, weight: 8 },
  { id: '6427', name: 'Hat and Mustache', diamond: 99, streakable: true, weight: 6 },
  { id: '6267', name: 'Corgi', diamond: 299, streakable: false, weight: 4 },
  { id: '11046', name: 'Galaxy', diamond: 1000, streakable: false, weight: 2 },
  { id: '6369', name: 'Lion', diamond: 29999, streakable: false, weight: 1 },
]);

export const MOCK_USERS = Object.freeze([
  { id: 'u1001', name: 'Linh Nguyen', weight: 9 },
  { id: 'u1002', name: 'Minh Tran', weight: 7 },
  { id: 'u1003', name: 'Hoa Le', weight: 6 },
  { id: 'u1004', name: 'BaoPham', weight: 4 },
  { id: 'u1005', name: 'golden_lotus', weight: 4 },
  { id: 'u1006', name: 'Sky Walker', weight: 3 },
  { id: 'u1007', name: 'Mai Anh', weight: 3 },
  { id: 'u1008', name: 'tuan.dev', weight: 2 },
  { id: 'u1009', name: 'Quynh', weight: 2 },
  { id: 'u1010', name: 'NightOwl', weight: 1 },
  { id: 'u1011', name: 'Khoa Vo', weight: 1 },
  { id: 'u1012', name: 'Thu Ha', weight: 1 },
]);

const COMMENTS = [
  'Hello from Saigon!',
  'Chào cả nhà 👋',
  'Beautiful stream tonight',
  'Hay quá!',
  'What song is this?',
  'Love the overlay ✨',
  'Xin chào từ Hà Nội',
  'GG',
  'Can you say hi to my mom?',
  'Đẹp quá trời',
  'First time here, followed!',
  '🔥🔥🔥',
];

// Extra fake viewers for POST /api/characters/spawn (pixel character preview).
const VIEWER_NAMES = [
  'Bông Gòn', 'Cá Viên', 'Mít Tơ', 'Su Kem', 'Bắp Rang', 'Trà Sữa', 'Mochi', 'Kẹo Dẻo', 'Ốc Nhỏ', 'Gấu Trúc',
  'pixel.kid', 'retro_fan', 'Cún Con', 'Bánh Bao', 'Sóc Nâu', 'Mây Xanh', 'Hạt Tiêu', 'Đậu Đỏ', 'NamCa', 'Táo Đỏ',
];
const VIEWER_LINES = ['Xin chào mọi người!', 'Hi hi 👋', 'Mình mới vào nè', 'Dễ thương quá', 'Chào chủ phòng!', 'Wow pixel 😍'];

/** Small deterministic PRNG (mulberry32). */
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

function pickWeighted(rand, items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

const userOf = ({ id, name }) => ({ id, name, avatarUrl: '' });

export class MockGenerator {
  /**
   * @param {object} opts
   * @param {(raw: object) => void} opts.emit   sink for raw events
   * @param {number} [opts.rate]                average events per second (0.2..50)
   * @param {number} [opts.seed]
   */
  constructor({ emit, rate = 2, seed = Date.now() }) {
    this.emit = emit;
    this.rate = MockGenerator.clampRate(rate);
    this.rand = mulberry32(seed);
    this.timer = null;
    this.streakTimers = new Set();
    this.msgSeq = 0;
    this.viewerSeq = 0;
    this.viewerTag = Math.floor(this.rand() * 36 ** 3).toString(36); // per-run tag: ids never repeat in a session
  }

  static clampRate(rate) {
    const r = Number(rate);
    return Number.isFinite(r) ? Math.min(50, Math.max(0.2, r)) : 2;
  }

  get running() {
    return this.timer !== null;
  }

  start(rate) {
    if (rate !== undefined) this.rate = MockGenerator.clampRate(rate);
    this.stop();
    const loop = () => {
      this.tick();
      // Poisson-ish jitter around the target rate.
      const mean = 1000 / this.rate;
      this.timer = setTimeout(loop, mean * (0.4 + this.rand() * 1.2));
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, 50);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.streakTimers) clearTimeout(t);
    this.streakTimers.clear();
  }

  #msgId() {
    return `mock${++this.msgSeq}`;
  }

  #later(fn, ms) {
    const t = setTimeout(() => {
      this.streakTimers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.streakTimers.add(t);
  }

  /** The first `n` mock users join, staggered (so a crowd of characters is on stage right away). */
  greet(n = 8) {
    MOCK_USERS.slice(0, n).forEach((u, i) => this.#later(() => this.emit({ type: 'join', user: userOf(u) }), 120 + i * 260));
  }

  /**
   * `count` brand-new fake viewers join now; with `chat`, about half say something a moment later.
   * @returns {{id: string, name: string}[]}
   */
  viewers(count, { chat = true } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const n = Math.floor(this.rand() * 1e6);
      const user = { id: `v${this.viewerTag}_${(++this.viewerSeq).toString(36)}`, name: `${VIEWER_NAMES[n % VIEWER_NAMES.length]} ${n % 100}`, avatarUrl: '' };
      this.emit({ type: 'join', user });
      if (chat && this.rand() < 0.5) {
        const text = VIEWER_LINES[Math.floor(this.rand() * VIEWER_LINES.length)];
        this.#later(() => this.emit({ type: 'comment', user, text }), 1400 + this.rand() * 1600);
      }
      out.push(user);
    }
    return out;
  }

  /** Emit one randomly chosen action. */
  tick() {
    const r = this.rand();
    const user = userOf(pickWeighted(this.rand, MOCK_USERS));
    if (r < 0.34) this.gift(user);
    else if (r < 0.7) {
      this.emit({ type: 'comment', user, text: COMMENTS[Math.floor(this.rand() * COMMENTS.length)] });
    } else if (r < 0.86) this.emit({ type: 'like', user });
    else if (r < 0.93) this.emit({ type: 'join', user });
    else if (r < 0.97) this.emit({ type: 'follow', user });
    else this.emit({ type: 'share', user });
  }

  /** Emit a gift; streakable gifts play out as a streak over time. */
  gift(user, gift = pickWeighted(this.rand, GIFT_CATALOG)) {
    const base = { id: gift.id, name: gift.name, diamond: gift.diamond, streakable: gift.streakable };
    if (!gift.streakable) {
      this.emit({ type: 'gift', msgId: this.#msgId(), user, gift: { ...base, repeatCount: 1, repeatEnd: true } });
      return;
    }
    const total = 1 + Math.floor(this.rand() ** 2 * 24); // mostly small, sometimes long streaks
    const sendEnd = this.rand() < 0.7; // 30% rely on the quiet window instead
    let n = 0;
    const step = () => {
      n++;
      this.emit({ type: 'gift', msgId: this.#msgId(), user, gift: { ...base, repeatCount: n, repeatEnd: false } });
      if (n < total) {
        this.#later(step, 180 + this.rand() * 220);
      } else if (sendEnd) {
        this.#later(() => {
          this.emit({ type: 'gift', msgId: this.#msgId(), user, gift: { ...base, repeatCount: n, repeatEnd: true } });
        }, 300);
      }
    };
    step();
  }
}
