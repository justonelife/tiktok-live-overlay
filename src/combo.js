// Gift streak (combo) tracker.
//
// TikTok sends streakable gifts repeatedly with a growing cumulative
// `repeatCount`, then a final event with `repeatEnd: true`. We collapse each
// streak (keyed by userId + giftId) into exactly ONE finalized gift, emitted
// when the streak ends or after `quietMs` without updates.

export const DEFAULT_QUIET_MS = 1500;
const DUP_WINDOW_MS = 10_000;
const MSG_ID_MEMORY = 2000;

export class ComboTracker {
  /**
   * @param {object} opts
   * @param {(final: {parsed, comboCount:number}) => void} opts.onFinalize
   * @param {(progress: {key, parsed, comboCount:number}) => void} [opts.onProgress]
   * @param {number} [opts.quietMs]
   * @param {() => number} [opts.now]
   */
  constructor({ onFinalize, onProgress = () => {}, quietMs = DEFAULT_QUIET_MS, now = Date.now }) {
    this.onFinalize = onFinalize;
    this.onProgress = onProgress;
    this.quietMs = quietMs;
    this.now = now;
    this.pending = new Map(); // key -> { parsed, comboCount, timer }
    this.finalized = new Map(); // key -> { comboCount, at } for late repeatEnd dedupe
    this.seenMsgIds = new Set();
  }

  static keyOf(parsed) {
    return `${parsed.user.id}|${parsed.gift.id}`;
  }

  /** Feed a parsed gift. Returns 'pending' | 'finalized' | 'duplicate'. */
  push(parsed) {
    if (parsed.msgId) {
      if (this.seenMsgIds.has(parsed.msgId)) return 'duplicate';
      this.seenMsgIds.add(parsed.msgId);
      if (this.seenMsgIds.size > MSG_ID_MEMORY) {
        this.seenMsgIds.delete(this.seenMsgIds.values().next().value);
      }
    }

    const key = ComboTracker.keyOf(parsed);
    const g = parsed.gift;
    const cur = this.pending.get(key);

    if (!cur) {
      // A trailing repeatEnd for a streak we already finalized (quiet window
      // fired first) carries the same cumulative count: drop it.
      const done = this.finalized.get(key);
      if (
        done &&
        g.repeatEnd &&
        g.repeatCount <= done.comboCount &&
        this.now() - done.at < DUP_WINDOW_MS
      ) {
        this.finalized.delete(key);
        return 'duplicate';
      }
      if (!g.streakable) {
        this.#emit(key, parsed, g.repeatCount);
        return 'finalized';
      }
      const entry = { parsed, comboCount: g.repeatCount, timer: null };
      this.pending.set(key, entry);
      if (g.repeatEnd) {
        this.#finish(key);
        return 'finalized';
      }
      this.onProgress({ key, parsed, comboCount: entry.comboCount });
      this.#arm(key);
      return 'pending';
    }

    // Existing streak. repeatCount is cumulative upstream; if a source sends
    // repeatCount 1 each time (no cumulative info) treat it as +1.
    cur.comboCount = g.repeatCount > cur.comboCount ? g.repeatCount : cur.comboCount + (g.repeatCount === 1 ? 1 : 0);
    cur.parsed = parsed;
    if (g.repeatEnd) {
      this.#finish(key);
      return 'finalized';
    }
    this.onProgress({ key, parsed: cur.parsed, comboCount: cur.comboCount });
    this.#arm(key);
    return 'pending';
  }

  #arm(key) {
    const entry = this.pending.get(key);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.#finish(key), this.quietMs);
    entry.timer.unref?.();
  }

  #finish(key) {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    this.#emit(key, entry.parsed, entry.comboCount);
  }

  #emit(key, parsed, comboCount) {
    if (parsed.gift.streakable) this.finalized.set(key, { comboCount, at: this.now() });
    if (this.finalized.size > 500) this.finalized.delete(this.finalized.keys().next().value);
    this.onFinalize({ parsed, comboCount });
  }

  /** Finalize every pending streak now (used on shutdown / clear). */
  flushAll() {
    for (const key of [...this.pending.keys()]) this.#finish(key);
  }

  /** Drop all pending streaks without emitting. */
  reset() {
    for (const e of this.pending.values()) clearTimeout(e.timer);
    this.pending.clear();
    this.finalized.clear();
    this.seenMsgIds.clear();
  }
}
