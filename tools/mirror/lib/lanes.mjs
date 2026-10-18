/**
 * Which regions the Kyiv server reads this cycle.
 *
 * It runs every two minutes, so a change reaches phones sooner. A region with anything out — a
 * schedule, an operator's picture — or failing, or kept live on purpose, is read every cycle. One
 * with nothing published is read on the slow turn (run.sh: once at least five and a half minutes
 * have passed since the last one): that is the wait for a season's first table, and its operator
 * is not asked thirty times an hour for an empty page. Off the Kyiv server (GitHub's fallback, every
 * ten minutes at best) every region is read every time.
 *
 * A region can also name how politely its operator wants to be asked: `minIntervalMinutes`. Within
 * that long of the last read — success or failure, off the Kyiv server too — it is not read at all,
 * whatever else would have it read: Вінниця's address search takes a request for each підчерга, and
 * the letter to its operator promises one read in fifteen minutes.
 */
export const SLOW_TURN_SECONDS = 330;

export function readsThisCycle(region, previousRow, { slowLane = false, slowTurn = false, now = Date.now() } = {}) {
  if (region.minIntervalMinutes && previousRow?.readAt) {
    const since = now - Date.parse(previousRow.readAt);
    if (Number.isFinite(since) && since >= 0 && since < region.minIntervalMinutes * 60_000) return false;
  }
  if (!slowLane || !previousRow || region.staysLive) return true;
  if (previousRow.status === 'live' || previousRow.status === 'image' || previousRow.hasSchedule || previousRow.stale) return true;
  return slowTurn;
}
