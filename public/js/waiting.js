// "Đang chờ quà tặng…" hint shown on an empty overlay. Pure logic, shared with tests.
// Once anything has flowed the hint is gone for good (sticky), and ?demo=1 hides it always.

/**
 * @param {{ demo?: boolean, seenActivity?: boolean, leaderboardSize?: number, commentCount?: number }} s
 * @returns {boolean} whether the waiting hint should be visible
 */
export function waitingHintVisible({ demo = false, seenActivity = false, leaderboardSize = 0, commentCount = 0 } = {}) {
  return !demo && !seenActivity && leaderboardSize === 0 && commentCount === 0;
}

/** Does this server message mean real activity has started? */
export function isActivity(msg) {
  const d = msg?.data;
  switch (msg?.kind) {
    case 'event':
    case 'combo':
      return true;
    case 'leaderboard':
      return Array.isArray(d) && d.length > 0;
    case 'hello':
      return d?.activity === true || (Array.isArray(d?.leaderboard) && d.leaderboard.length > 0) || (Array.isArray(d?.recentComments) && d.recentComments.length > 0);
    default:
      return false;
  }
}

/** Read the demo flag from a query string: /overlay?demo=1 */
export function isDemo(search) {
  const v = new URLSearchParams(search).get('demo');
  return v === '1' || v === 'true';
}
