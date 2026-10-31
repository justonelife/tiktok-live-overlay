// Session statistics: diamond leaderboard + per-user per-gift send counters.
// All diamond math is integer-only.

export const DEFAULT_TOP_N = 5;

export class SessionStats {
  constructor({ topN = DEFAULT_TOP_N } = {}) {
    this.topN = topN;
    this.reset();
  }

  reset() {
    this.users = new Map(); // userId -> { userId, name, avatarUrl, total, achievedSeq, achievedAt }
    this.giftCounts = new Map(); // `${userId}|${giftId}` -> n
    this.seq = 0;
    this.totalDiamonds = 0;
    this.giftEvents = 0;
  }

  /** Increment and return how many times `userId` has sent `giftId` this session (1-based). */
  bumpGiftCount(userId, giftId) {
    const key = `${userId}|${giftId}`;
    const n = (this.giftCounts.get(key) ?? 0) + 1;
    this.giftCounts.set(key, n);
    return n;
  }

  giftCount(userId, giftId) {
    return this.giftCounts.get(`${userId}|${giftId}`) ?? 0;
  }

  /**
   * Add diamonds for a user. `achievedSeq` records when the user reached their
   * current total, so equal totals rank whoever got there first.
   */
  addDiamonds(user, diamonds, ts = Date.now()) {
    if (!Number.isSafeInteger(diamonds) || diamonds < 0) throw new RangeError('diamonds must be a non-negative integer');
    const entry = this.users.get(user.id) ?? { userId: user.id, total: 0 };
    entry.name = user.name;
    entry.avatarUrl = user.avatarUrl;
    entry.total += diamonds;
    if (!Number.isSafeInteger(entry.total)) throw new RangeError('diamond total overflow');
    entry.achievedSeq = ++this.seq;
    entry.achievedAt = ts;
    this.users.set(user.id, entry);
    this.totalDiamonds += diamonds;
    this.giftEvents += 1;
    return entry;
  }

  leaderboard(n = this.topN) {
    return [...this.users.values()]
      .filter((e) => e.total > 0)
      .sort((a, b) => b.total - a.total || a.achievedSeq - b.achievedSeq)
      .slice(0, n)
      .map((e, i) => ({ rank: i + 1, userId: e.userId, name: e.name, avatarUrl: e.avatarUrl, total: e.total }));
  }
}
