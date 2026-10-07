import { getJSON } from '../lib/http.mjs';
import { buildSnapshot, displayStamp, halvesFromHours, hourStateFromHalves, kyivDayStart, stampTime } from '../lib/canonical.mjs';

/**
 * YASNO — ДТЕК's own supplier for Київ and Дніпро — publishes the same day tables as ДТЕК's sites,
 * as plain JSON with no bot wall: `planned-outages` (today and tomorrow, per group) and
 * `probable-outages` (the weekly plan). Checked 2026-10-07 from Kyiv: all 60 Kyiv groups for both
 * days and all 84 Дніпро plan days matched the `outage-data-ua` mirror exactly.
 *
 * It is read beside that mirror, not instead of it (see `combine`): two independent copies of one
 * operator's data, so either can be late or down without the app noticing. It covers only Київ
 * (region 25, ДТЕК Київські електромережі 902) and Дніпро (region 3, ДнЕМ 301; ЦЕК 303 publishes
 * the identical tables). Київська область and Одеса are not YASNO's.
 *
 * Slots are minutes from Kyiv midnight. `Definite` is a cut in the day tables and a likely cut in
 * the weekly plan; `NotPlanned` is light. Any other type, or a boundary off the half-hour grid,
 * fails the read: a changed API must not turn into a guessed schedule.
 */
const BASE = 'https://app.yasno.ua/api/blackout-service/public/shutdowns';

/** Days YASNO marks as published. `NoOutages` is not taken as a clear day: before ДТЕК publishes,
 *  a quiet answer and an absent one look alike, and the app never invents a green day. */
const PUBLISHED = new Set(['ScheduleApplies']);

/** One day's slots → 48 half-hours, `dark` for `Definite`. */
export function slotsToHalves(slots, dark) {
  const halves = Array(48).fill('on');
  for (const slot of slots ?? []) {
    const { start, end, type } = slot ?? {};
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || start >= end
        || start % 30 || end % 30) {
      throw new Error(`yasno slot off the half-hour grid: ${JSON.stringify(slot)}`);
    }
    if (type === 'NotPlanned') continue;
    if (type !== 'Definite') throw new Error(`unknown yasno slot type "${type}"`);
    for (let minute = start; minute < end; minute += 30) halves[minute / 30] = dark;
  }
  return halves;
}

function hoursFromHalves(halves) {
  const hours = {};
  for (let hour = 1; hour <= 24; hour++) {
    hours[String(hour)] = hourStateFromHalves(halves[(hour - 1) * 2], halves[(hour - 1) * 2 + 1]);
  }
  return hours;
}

const queueKey = (group) => `GPV${group}`;

/**
 * `planned-outages` → `{ fact, update, emergency }`: day epoch → queue → hour → state, for the days
 * YASNO marks as applying. `emergency` lists the days it reports as `EmergencyShutdowns`, when the
 * plan is suspended — logged for now, not shown.
 */
export function factFromPlanned(payload, keep = () => true) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('yasno planned: not an object');
  const fact = {};
  const emergency = new Set();
  let update = null;
  for (const [group, entry] of Object.entries(payload)) {
    const key = queueKey(group);
    if (!keep(key)) continue;
    if (entry?.updatedOn && (!update || Date.parse(entry.updatedOn) > Date.parse(update))) update = entry.updatedOn;
    for (const dayKey of ['today', 'tomorrow']) {
      const day = entry?.[dayKey];
      if (!day?.date) continue;
      const epoch = kyivDayStart(new Date(day.date));
      if (day.status === 'EmergencyShutdowns') emergency.add(epoch);
      if (!PUBLISHED.has(day.status)) continue;
      (fact[epoch] ??= {})[key] = hoursFromHalves(slotsToHalves(day.slots, 'off'));
    }
  }
  return { fact, update, emergency: [...emergency] };
}

/** `probable-outages` → preset: queue → weekday 1 (Monday) … 7 → hour → state. YASNO counts 0–6. */
export function presetFromProbable(payload, { regionId, dsoId }, keep = () => true) {
  const groups = payload?.[String(regionId)]?.dsos?.[String(dsoId)]?.groups;
  if (!groups || typeof groups !== 'object') throw new Error(`yasno probable: no groups for ${regionId}/${dsoId}`);
  const preset = {};
  for (const [group, entry] of Object.entries(groups)) {
    const key = queueKey(group);
    if (!keep(key)) continue;
    const week = {};
    for (const [weekday, slots] of Object.entries(entry?.slots ?? {})) {
      const index = Number(weekday);
      if (!Number.isInteger(index) || index < 0 || index > 6) throw new Error(`yasno probable: weekday "${weekday}"`);
      week[String(index + 1)] = hoursFromHalves(slotsToHalves(slots, 'possible'));
    }
    if (Object.keys(week).length) preset[key] = week;
  }
  return preset;
}

/** Never held up by YASNO: one retry, ten seconds a read, both reads at once. */
const READ = { retries: 1, timeoutMs: 10_000 };

/**
 * Both YASNO reads for a region → `{ fact, preset, update, emergency }`. The weekly plan is a
 * bonus: a failed plan read leaves it empty rather than discarding the day tables.
 */
export async function fetchYasno(region, get = getJSON) {
  const { regionId, dsoId } = region.yasno;
  const keep = region.queuePattern ? (key) => region.queuePattern.test(key) : () => true;
  const [planned, probable] = await Promise.all([
    get(`${BASE}/regions/${regionId}/dsos/${dsoId}/planned-outages`, READ),
    get(`${BASE}/probable-outages?regionId=${regionId}&dsoId=${dsoId}`, READ).catch(() => null)
  ]);
  const { fact, update, emergency } = factFromPlanned(planned, keep);
  let preset = {};
  try {
    if (probable) preset = presetFromProbable(probable, region.yasno, keep);
  } catch {
    // An unreadable plan is no plan.
  }
  return { fact, preset, update, emergency };
}

const sameDay = (a, b) => {
  if (!a || !b) return false;
  const keys = Object.keys(a).sort();
  if (keys.join() !== Object.keys(b).sort().join()) return false;
  return keys.every((queue) => halvesFromHours(a[queue]).join() === halvesFromHours(b[queue]).join());
};

/** Only the queues both copies carry, so a table's extra rows are not read as a disagreement. */
const common = (day, other) => Object.fromEntries(Object.entries(day).filter(([queue]) => queue in other));

/** `day`'s queues in `order` first, the rest sorted, so equal tables are equal JSON too. */
function ordered(day, order) {
  const keys = [...order.filter((key) => key in day), ...Object.keys(day).filter((key) => !order.includes(key)).sort()];
  return Object.fromEntries(keys.map((key) => [key, day[key]]));
}

/** A whole week for every one of `queues` that marks something, or it is no plan for the region. */
function usablePlan(plan, queues) {
  if (!queues.length || !queues.every((queue) => queue in plan)) return false;
  const whole = (week) => ['1', '2', '3', '4', '5', '6', '7'].every((weekday) => Object.keys(week?.[weekday] ?? {}).length === 24);
  if (!queues.every((queue) => whole(plan[queue]))) return false;
  // An all-clear plan says nothing — the green week shape() drops from ДТЕК's own (dtek.mjs).
  return Object.values(plan).some((week) => Object.values(week).some((day) => Object.values(day).some((state) => state !== 'yes')));
}

/**
 * The served snapshot from the outage-data-ua copy (`upstream`) and YASNO's (`yasno`).
 *
 * Decided from the two copies alone, never from what was served last time: judged against its own
 * output the choice flipped every cycle while the copies disagreed, waking every phone each time.
 * Day by day, a day only one copy has comes from it — usually the one that saw ДТЕК publish first.
 * When both have it and differ, YASNO's is taken only if its stamp is later than ДТЕК's own on the
 * other copy; a tie keeps outage-data-ua, as before.
 *
 * The weekly plan stays ДТЕК's own where it marks anything. YASNO's stands in only when it covers
 * every queue and marks something: for Київ (7 жовтня 2026) it holds groups 1.1–6.1 alone, in the
 * old six-queue rhythm that matches none of today's tables, so it is left out.
 */
export function combine({ upstream, yasno, previous, region, now = new Date(), log = () => {} }) {
  if (!yasno) return holdServed({ upstream, previous, now });
  const yasnoAt = Date.parse(yasno.update ?? '') || 0;

  if (!upstream) return overlay({ yasno, yasnoAt, previous, region, now });

  const upstreamAt = stampTime(upstream.fact?.update) || 0;
  const order = Object.keys(upstream.preset?.sch_names ?? {});
  const upstreamDays = Array.isArray(upstream.fact?.data) ? {} : (upstream.fact?.data ?? {});
  const days = { ...upstreamDays };
  let tookYasno = false;
  for (const [epoch, yasnoDay] of Object.entries(yasno.fact)) {
    const upstreamDay = upstreamDays[epoch];
    if (!upstreamDay) {
      days[epoch] = ordered(yasnoDay, order);
      tookYasno = true;
      log(`${region.id}: ${epoch} only in yasno`);
      continue;
    }
    if (sameDay(common(upstreamDay, yasnoDay), common(yasnoDay, upstreamDay))) continue;
    if (yasnoAt > upstreamAt) {
      days[epoch] = ordered({ ...upstreamDay, ...yasnoDay }, Object.keys(upstreamDay));
      tookYasno = true;
      log(`${region.id}: ${epoch} differs, yasno's is newer`);
    } else {
      log(`${region.id}: ${epoch} differs, outage-data-ua's is newer`);
    }
  }

  const preset = { ...(upstream.preset ?? {}) };
  if (!Object.keys(preset.data ?? {}).length && usablePlan(yasno.preset, order)) {
    preset.data = ordered(yasno.preset, order);
  }

  return {
    ...upstream,
    fact: {
      ...upstream.fact,
      data: Object.keys(days).length ? days : [],
      // The stamp of the copy a shown day came from, so «Оновлено» never predates it.
      ...(tookYasno && yasnoAt > upstreamAt ? { update: displayStamp(yasno.update) } : {})
    },
    preset
  };
}

/**
 * YASNO did not answer this time. A day only it had, or its newer table of a day, is still what
 * phones have — the served copy stands in for it until outage-data-ua catches up, instead of the
 * day vanishing for one cycle and coming back the next (two wake-ups each way, as Суми once did).
 * Only served days from today on, and only against an older outage-data-ua stamp.
 */
function holdServed({ upstream, previous, now }) {
  if (!upstream || !previous) return upstream;
  const servedDays = Array.isArray(previous.fact?.data) ? {} : (previous.fact?.data ?? {});
  const upstreamDays = Array.isArray(upstream.fact?.data) ? {} : (upstream.fact?.data ?? {});
  const servedAt = stampTime(previous.fact?.update) || 0;
  const upstreamAt = stampTime(upstream.fact?.update) || 0;
  const today = kyivDayStart(now);
  const days = { ...upstreamDays };
  let held = false;
  for (const [epoch, day] of Object.entries(servedDays)) {
    if (Number(epoch) < today) continue;
    const theirs = upstreamDays[epoch];
    if (!theirs || (servedAt > upstreamAt && !sameDay(common(theirs, day), common(day, theirs)))) {
      days[epoch] = theirs ? { ...theirs, ...day } : day;
      held = true;
    }
  }
  if (!held) return upstream;
  return {
    ...upstream,
    fact: { ...upstream.fact, data: days, ...(servedAt > upstreamAt ? { update: previous.fact.update } : {}) }
  };
}

/**
 * outage-data-ua is down: what phones have, refreshed where YASNO is newer. YASNO carries only some
 * of a region's queues (Дніпро: 1.1–6.2 of 24), so the region is not rebuilt from it — the other
 * queues' days and the weekly plan stay as they were, and an older YASNO day never replaces a
 * newer one phones already have.
 */
function overlay({ yasno, yasnoAt, previous, region, now }) {
  const today = kyivDayStart(now);
  if (!previous) {
    const queues = [...new Set(Object.values(yasno.fact).flatMap(Object.keys))].sort();
    return buildSnapshot({
      regionId: region.id,
      title: region.title,
      queues: Object.fromEntries(queues.map((key) => [key, `Черга ${key.slice(3)}`])),
      preset: usablePlan(yasno.preset, queues) ? yasno.preset : {},
      fact: yasno.fact,
      todayEpoch: today,
      update: yasno.update,
      source: 'yasno'
    });
  }
  const servedAt = stampTime(previous.fact?.update) || 0;
  const order = Object.keys(previous.preset?.sch_names ?? {});
  const days = Object.fromEntries(
    Object.entries(Array.isArray(previous.fact?.data) ? {} : (previous.fact?.data ?? {}))
      .filter(([epoch]) => Number(epoch) >= today)
  );
  let tookYasno = false;
  for (const [epoch, day] of Object.entries(yasno.fact)) {
    if (Number(epoch) < today) continue;
    if (days[epoch] && !(yasnoAt > servedAt)) continue;
    days[epoch] = ordered({ ...(days[epoch] ?? {}), ...day }, days[epoch] ? Object.keys(days[epoch]) : order);
    tookYasno = true;
  }
  const { mirroredAt, ...kept } = previous;
  return {
    ...kept,
    lastUpdated: now.toISOString(),
    fact: {
      ...previous.fact,
      data: Object.keys(days).length ? days : [],
      today,
      ...(tookYasno && yasnoAt > servedAt ? { update: displayStamp(yasno.update) } : {})
    }
  };
}
