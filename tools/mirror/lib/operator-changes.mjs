import { fetchChannel } from './telegram.mjs';
import { kyivDayStart } from './canonical.mjs';
import { wallToEpoch } from './ics.mjs';

/**
 * «Зміни у графіках погодинних відключень», announced on the operator's own channel before its table
 * shows them.
 *
 * Житомиробленерго posts «Зверніть увагу! Зміни у графіках погодинних відключень! … За вказівкою
 * НЕК «Укренерго» маємо зміни у ГПВ» (26 October 2026: 06:30, 20:50) and updates the table on its site
 * afterwards — 21:30 that evening, 22:00, 22:30. In between, a phone that shows the old table is shown
 * a schedule the operator has already said is out of date; three letters that evening wrote that the
 * power did not match it. `fact.pendingChange` is that gap: set from the post until the table's own stamp
 * passes it, so the app can say «таблиця ще не оновлена» for exactly as long as it is true.
 */
export const CHANGED = /зміни\s+у\s+(?:графіках\s+погодинних\s+відключень|ГПВ)/iu;

/** A change nobody confirmed is not believed after this: a table that never updated would otherwise warn all day. */
export const MAX_AGE_MS = 12 * 3600 * 1000;

/**
 * An operator's own stamp — «22:30 26.10.2026» (Житомир) or «26.10.2026 22:30» — as an instant, in ms; NaN
 * when it is neither.
 */
export function stampInstant(stamp) {
  const text = String(stamp ?? '');
  const match = /^(\d{1,2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})$/.exec(text) ?? /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return Number.NaN;
  const [hour, minute, day, month, year] = /^\d{1,2}:/.test(text)
    ? [match[1], match[2], match[3], match[4], match[5]].map(Number)
    : [match[4], match[5], match[1], match[2], match[3]].map(Number);
  const midnight = kyivDayStart(new Date(Date.UTC(year, month - 1, day, 12)));
  return wallToEpoch(midnight, hour * 60 + minute) * 1000;
}

/**
 * @param {Array<{id:number, postedAt:string, text:string}>} posts
 * @param {{ update: string|null, now?: Date }} options `update` is the table's own stamp
 * @returns {{ at: number }|null} the latest announcement (epoch seconds) the table has not answered yet
 */
export function readPendingChange(posts, { update, now = new Date() }) {
  const latest = posts
    .filter((post) => CHANGED.test(post.text ?? ''))
    .map((post) => Date.parse(post.postedAt))
    .filter((at) => Number.isFinite(at) && at <= now.getTime() + 5 * 60 * 1000 && now.getTime() - at <= MAX_AGE_MS)
    .sort((a, b) => a - b)
    .at(-1);
  if (latest === undefined) return null;
  const tableAt = stampInstant(update);
  // A table stamped after the post has taken it in; one that cannot be dated is not trusted to have.
  if (Number.isFinite(tableAt) && tableAt >= latest) return null;
  return { at: Math.floor(latest / 1000) };
}

/**
 * `snapshot` with `fact.pendingChange` set while the operator's channel has announced a change its table has
 * not caught up with. When the channel does not answer, an announcement phones already have stays until the
 * table's stamp passes it or it grows old.
 */
export async function withPendingChange(
  snapshot, region, { read = (channel) => fetchChannel(channel), now = new Date(), log = (line) => console.log(`[operator-changes] ${line}`) } = {}
) {
  const { pendingChange: _held, ...rest } = snapshot.fact ?? {};
  let pending = null;
  try {
    pending = readPendingChange(await read(region.changesTelegram.channel), { update: rest.update, now });
  } catch (error) {
    log(`${region.id}: channel failed: ${error.message}`);
    const held = region.previous?.fact?.pendingChange;
    const heldAt = (held?.at ?? 0) * 1000;
    const tableAt = stampInstant(rest.update);
    if (held && now.getTime() - heldAt <= MAX_AGE_MS && !(Number.isFinite(tableAt) && tableAt >= heldAt)) pending = held;
  }
  if (pending) log(`${region.id}: change announced at ${new Date(pending.at * 1000).toISOString()}, table stamped ${rest.update}`);
  return pending ? { ...snapshot, fact: { ...rest, pendingChange: pending } } : { ...snapshot, fact: rest };
}
