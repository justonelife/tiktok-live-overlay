// Event engine: raw events -> validation -> combo collapse -> stats -> outbound messages.
// Emits 'message' with { kind, data } envelopes for the WebSocket hub.

import { EventEmitter } from 'node:events';
import { parseRaw, toEvent, EventValidationError } from './normalize.js';
import { ComboTracker, DEFAULT_QUIET_MS } from './combo.js';
import { SessionStats, DEFAULT_TOP_N } from './stats.js';

const RECENT_COMMENTS = 8;

export class OverlayEngine extends EventEmitter {
  constructor({ quietMs = DEFAULT_QUIET_MS, topN = DEFAULT_TOP_N, logger = console } = {}) {
    super();
    this.logger = logger;
    this.stats = new SessionStats({ topN });
    this.recentComments = [];
    this.counters = { accepted: 0, dropped: 0, duplicates: 0, emitted: 0 };
    this.combo = new ComboTracker({
      quietMs,
      onProgress: ({ key, parsed, comboCount }) => {
        this.#send('combo', {
          key,
          user: parsed.user,
          gift: { id: parsed.gift.id, name: parsed.gift.name },
          comboCount,
          diamondTotal: parsed.gift.diamond * comboCount,
        });
      },
      onFinalize: ({ parsed, comboCount }) => this.#finalizeGift(parsed, comboCount),
    });
  }

  /**
   * Ingest one raw event. Never throws: malformed events are logged and dropped.
   * @returns {{ ok: boolean, status?: string, error?: string }}
   */
  ingest(raw) {
    let parsed;
    try {
      parsed = parseRaw(raw);
    } catch (err) {
      this.counters.dropped++;
      const msg = err instanceof EventValidationError ? err.message : 'internal error';
      if (!(err instanceof EventValidationError)) this.logger.error('[engine] unexpected parse error', err);
      else this.logger.warn?.(`[engine] dropped event: ${msg}`);
      return { ok: false, error: msg };
    }
    try {
      this.counters.accepted++;
      if (parsed.type === 'gift') {
        const status = this.combo.push(parsed);
        if (status === 'duplicate') this.counters.duplicates++;
        return { ok: true, status };
      }
      const ev = toEvent(parsed);
      if (ev.type === 'comment') {
        this.recentComments.push(ev);
        if (this.recentComments.length > RECENT_COMMENTS) this.recentComments.shift();
      }
      this.#emitEvent(ev);
      return { ok: true, status: 'emitted' };
    } catch (err) {
      this.counters.dropped++;
      this.logger.error('[engine] failed to process event', err);
      return { ok: false, error: 'internal error' };
    }
  }

  #finalizeGift(parsed, comboCount) {
    const diamondTotal = parsed.gift.diamond * comboCount;
    if (!Number.isSafeInteger(diamondTotal)) {
      this.counters.dropped++;
      this.logger.warn?.('[engine] dropped gift: diamond overflow');
      return;
    }
    const count = this.stats.bumpGiftCount(parsed.user.id, parsed.gift.id);
    this.stats.addDiamonds(parsed.user, diamondTotal, parsed.ts);
    this.#emitEvent(toEvent(parsed, { count, comboCount, diamondTotal }));
    this.#send('leaderboard', this.stats.leaderboard());
  }

  #emitEvent(ev) {
    this.counters.emitted++;
    this.#send('event', ev);
  }

  #send(kind, data) {
    this.emit('message', { kind, data });
  }

  snapshot() {
    return {
      leaderboard: this.stats.leaderboard(),
      recentComments: [...this.recentComments],
      totals: { diamonds: this.stats.totalDiamonds, gifts: this.stats.giftEvents },
    };
  }

  clear() {
    this.combo.reset();
    this.stats.reset();
    this.recentComments = [];
    this.#send('clear', {});
    this.#send('leaderboard', []);
  }

  close() {
    this.combo.reset();
  }
}
