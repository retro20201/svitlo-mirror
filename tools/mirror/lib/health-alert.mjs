/**
 * Tells the person who runs the mirror that a region has stopped being read — which is otherwise learnt from a
 * letter. On 29 October 2026 Полтава's page changed twice in two days («cell 00:00 of 1.1 is out of order»,
 * every cycle for two hours) and the first sign was a user writing that tomorrow's table was on the site and not
 * in the app.
 *
 * The detector is already in the served index: a region that could not be read keeps its last copy and is marked
 * `stale` with the time it first failed (`staleSince`, lib/relay.mjs). This only decides who to tell and when.
 * Once per episode, not per cycle; and not for an old one — Вінниця has been stale since 16 October and is a
 * known case, which must not ring a phone the first time this runs.
 */

/** A failure shorter than this is an operator's site having a moment; longer is worth a message. */
export const MIN_AGE_MS = 30 * 60 * 1000;
/** Past this an episode is a known state of things, not news. */
export const MAX_AGE_MS = 24 * 3600 * 1000;

const name = (row) => row.title ?? row.id;

const span = (ms) => {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 90 ? `${minutes} хв` : `${Math.round(minutes / 6) / 10} год`;
};

/**
 * @param {Array<object>} rows the served index's `regions`
 * @param {Record<string, string>} state region id → the `staleSince` already told about
 * @returns {{ messages: Array<{title: string, body: string}>, state: Record<string, string> }}
 */
export function decide(rows, state = {}, now = new Date()) {
  const messages = [];
  const next = {};
  for (const row of rows) {
    const since = row.stale && !row.notStarted ? Date.parse(row.staleSince ?? '') : NaN;
    if (Number.isFinite(since)) {
      const age = now.getTime() - since;
      const told = state[row.id] === row.staleSince;
      if (told) {
        next[row.id] = row.staleSince;
      } else if (age >= MIN_AGE_MS && age <= MAX_AGE_MS) {
        next[row.id] = row.staleSince;
        messages.push({
          title: `⚠️ Не читається: ${name(row)}`,
          body: `Уже ${span(age)}. У застосунку стара копія.`
        });
      }
    } else if (state[row.id]) {
      // The region reads whole again: said once, then forgotten.
      const was = Date.parse(state[row.id]);
      messages.push({
        title: `✅ Знову читається: ${name(row)}`,
        body: Number.isFinite(was) ? `Не читалося ${span(now.getTime() - was)}.` : 'Знову читається.'
      });
    }
  }
  return { messages, state: next };
}
