// FIFO banner queue: one banner on screen at a time, never overlapping.
// If more than `cap` banners are waiting, the oldest (stale) ones are dropped.

export const BANNER_MS = 4000;
export const BANNER_QUEUE_CAP = 6;

export class BannerQueue {
  constructor({ cap = BANNER_QUEUE_CAP, durationMs = BANNER_MS, show = () => {}, hide = () => {} } = {}) {
    this.cap = cap;
    this.durationMs = durationMs;
    this.show = show;
    this.hide = hide;
    this.waiting = [];
    this.current = null;
    this.dropped = 0;
    this.timer = null;
  }

  /** Enqueue a banner. Returns number of stale banners dropped by this call. */
  push(item) {
    this.waiting.push(item);
    let dropped = 0;
    while (this.waiting.length > this.cap) {
      this.waiting.shift();
      dropped++;
    }
    this.dropped += dropped;
    if (this.current === null) this.next();
    return dropped;
  }

  next() {
    clearTimeout(this.timer);
    if (this.current !== null) this.hide(this.current);
    this.current = this.waiting.shift() ?? null;
    if (this.current !== null) {
      this.show(this.current);
      this.timer = setTimeout(() => this.next(), this.durationMs);
    }
  }

  clear() {
    clearTimeout(this.timer);
    if (this.current !== null) this.hide(this.current);
    this.current = null;
    this.waiting = [];
  }

  get size() {
    return this.waiting.length;
  }
}
