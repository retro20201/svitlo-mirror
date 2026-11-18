import { kyivDayStart } from './canonical.mjs';
import { pageOf, readEmergency } from './dtek-emergency.mjs';
import { scheduleOf } from '../sources/cek.mjs';
import { regionById } from '../regions.mjs';

/**
 * ЦЕК's hours for the queues ДТЕК lists under its own Дніпро region.
 *
 * ДТЕК Дніпровські електромережі's page names twenty-four queues: its own «Черга 1.1» … «Черга 6.2», and «ЦЕК 1.1» … «ЦЕК 6.2»
 * (GPV1001.1 … GPV1006.2) — the subscribers of ПрАТ «ПЕЕМ «ЦЕК», another operator, who reach those names by the address search or
 * by picking them. For those twelve ДТЕК publishes a weekly template of «можливо» and never a day's table, so the app drew them a
 * forecast, and with possible outages hidden, «Вимкнень не заплановано» — while their light was off by ЦЕК's own table (a letter,
 * 13 November 2026: «ЦЕК 5.2», 23:48, the cut of 23:30 under way).
 *
 * ЦЕК's table is what the region `cek` is read from (sources/cek.mjs, the channel @cek_info). Here the same hours are put into ДТЕК's
 * region under ДТЕК's names for them, so whoever chose «ЦЕК 5.2» under «Дніпро» sees ЦЕК's 5.2 without choosing anything again.
 *
 * And ЦЕК's emergency orders, for those queues alone: `fact.queueEmergency` — `{ queues, days, note? }`. The region's own flag
 * (`fact.emergency`) stays ДТЕК's: it warns every phone in the region, with an alert to all who asked for one, and ЦЕК's people are
 * a few in a hundred of them. On 14 November 2026 ЦЕК declared emergency outages for Дніпро twice (12:19–14:46, 20:02–21:35) with
 * ДТЕК saying nothing: the region `cek` had the warning, «ЦЕК 5.2» under «Дніпро» had its hours drawn as if they held. The field
 * names the queues that have an operator of their own, and the days that operator's order is on — none, when there is none: an app
 * that knows the field reads those queues' warning from it and not from the region's flag; one that does not, reads as before.
 *
 * A channel that cannot be read leaves the snapshot as ДТЕК gave it — a forecast, as before — and never fails the region; an
 * order the served copy already had stays on it meanwhile.
 */

/** ДТЕК's name for one of ЦЕК's queues: «ЦЕК 5.2». */
const CEK_NAME = /^ЦЕК\s+(\d+)\.(\d+)$/u;

/** ЦЕК's queue key → ДТЕК's key for it in this snapshot, by the names ДТЕК gives: `GPV5.2` → `GPV1005.2`. */
export function cekTargets(snapshot) {
  const targets = new Map();
  for (const [key, name] of Object.entries(snapshot?.preset?.sch_names ?? {})) {
    const match = CEK_NAME.exec(String(name).trim());
    if (match) targets.set(`GPV${match[1]}.${match[2]}`, key);
  }
  return targets;
}

/**
 * `cekFact`: day epoch → queue → the 24 hour states, as sources/cek.mjs's `scheduleOf` gives it. Days before `today` are left out;
 * a day ДТЕК has no table for yet gets one with ЦЕК's queues alone (ДТЕК's own queues then read as before: a forecast).
 */
export function mergeCekQueues(snapshot, cekFact, { today = kyivDayStart() } = {}) {
  const targets = cekTargets(snapshot);
  if (!targets.size) return snapshot;
  const held = snapshot.fact?.data;
  const data = held && !Array.isArray(held) ? { ...held } : {};
  let merged = 0;
  for (const [day, queues] of Object.entries(cekFact ?? {})) {
    if (Number(day) < today) continue;
    const rows = {};
    for (const [queue, hours] of Object.entries(queues ?? {})) {
      const target = targets.get(queue);
      if (target && hours && Object.keys(hours).length === 24) rows[target] = hours;
    }
    if (!Object.keys(rows).length) continue;
    data[day] = { ...(data[day] ?? {}), ...rows };
    merged++;
  }
  return merged ? { ...snapshot, fact: { ...(snapshot.fact ?? {}), data } } : snapshot;
}

/**
 * ЦЕК's emergency order as ДТЕК's region carries it: ДТЕК's keys for ЦЕК's queues, and today while the order is on.
 *
 * Read off the same posts by the rules the region `cek` is read by (its `emergencyTelegram`: how long an order with no end is
 * believed, and Павлоград's own orders left out), so the two never say different things. `note`: whom the post addressed, when it
 * named a city — «для споживачів м. Дніпро».
 *
 * @returns {{ queues: string[], days: number[], note?: string, since?: string } | null} null for a snapshot with none of ЦЕК's queues
 */
export function cekEmergency(snapshot, posts, { now = new Date(), signal = regionById('cek')?.emergencyTelegram } = {}) {
  const queues = [...cekTargets(snapshot).values()].sort();
  if (!queues.length) return null;
  const hours = signal?.maxAgeHours;
  const reading = readEmergency(posts, { now, area: 'own', maxAgeMs: hours ? hours * 3600 * 1000 : undefined, skip: signal?.skip ?? null });
  if (!reading.active) return { queues, days: [] };
  return { queues, days: [kyivDayStart(now)], ...(reading.note ? { note: reading.note } : {}), since: reading.since };
}

/** The order the served copy had, for a cycle the channel did not answer in: today's and later, or nothing. */
function heldEmergency(snapshot, previous, today) {
  const held = previous?.fact?.queueEmergency;
  const days = Array.isArray(held?.days) ? held.days.map(Number).filter((day) => day >= today) : [];
  if (!days.length || !Array.isArray(held.queues)) return snapshot;
  return { ...snapshot, fact: { ...(snapshot.fact ?? {}), queueEmergency: { ...held, days } } };
}

/**
 * @param {object} snapshot ДТЕК's region as its adapter read it
 * @param {{ read?: Function, now?: Date, log?: Function, previous?: object|null }} options `previous`: the copy being served
 */
export async function withCekQueues(
  snapshot, { read = () => pageOf('cek_info'), now = new Date(), log = (line) => console.log(`[cek-in-dnipro] ${line}`), previous = null } = {}
) {
  if (!cekTargets(snapshot).size) return snapshot;
  // From the day `now` is in: the reader's own floor is yesterday by the real clock, which a test of another day is not near.
  const today = kyivDayStart(now);
  try {
    const posts = await read();
    const merged = mergeCekQueues(snapshot, scheduleOf(posts, { since: today }).fact, { today });
    const { since, ...order } = cekEmergency(snapshot, posts, { now });
    if (since) log(`ЦЕК's emergency order since ${since}${order.note ? ` (${order.note})` : ''}`);
    return { ...merged, fact: { ...(merged.fact ?? {}), queueEmergency: order } };
  } catch (error) {
    log(`ЦЕК's hours were not read: ${error.message}`);
    return heldEmergency(snapshot, previous, today);
  }
}
