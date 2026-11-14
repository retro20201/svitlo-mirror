import { kyivDayStart } from './canonical.mjs';
import { pageOf } from './dtek-emergency.mjs';
import { scheduleOf } from '../sources/cek.mjs';

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
 * Only the hours. The region's emergency flag stays ДТЕК's own: ЦЕК's orders are in the region `cek`. A channel that cannot be read
 * leaves the snapshot as ДТЕК gave it — a forecast, as before — and never fails the region.
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

export async function withCekQueues(
  snapshot, { read = () => pageOf('cek_info'), now = new Date(), log = (line) => console.log(`[cek-in-dnipro] ${line}`) } = {}
) {
  if (!cekTargets(snapshot).size) return snapshot;
  try {
    // From the day `now` is in: the reader's own floor is yesterday by the real clock, which a test of another day is not near.
    const today = kyivDayStart(now);
    return mergeCekQueues(snapshot, scheduleOf(await read(), { since: today }).fact, { today });
  } catch (error) {
    log(`ЦЕК's hours were not read: ${error.message}`);
    return snapshot;
  }
}
