import { getJSON } from '../lib/http.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * АТ «Миколаївобленерго» — the JSON API behind the operator's own page at off.energy.mk.ua.
 * `robots.txt` there is `User-agent: * / Disallow:` (re-checked 2026-10-01).
 *
 * Everything below is read off that page's `/js/app.js` (2026-10-01), not inferred from names.
 * The page loads three queue groups and uses them very differently:
 *  - `/api/outage-queue/by-type/1` — ГАВ 1–10 and 1(Р)–10(Р); `by-type/2` — СГАВ 1–3. Both are
 *    drawn only as tiles that turn red while `enabled === 1`: a live switch with no hours, nothing
 *    a schedule can be built from.
 *  - `/api/outage-queue/by-type/3` — the ГПВ підчерги 1.1–6.2. This is the only group the hourly
 *    table is built from, crossed with `/api/schedule/time-series` (48 half-hour rows) and
 *    `/api/v2/schedule/active` (the published days). Its own `enabled` is the same kind of live
 *    switch, and the page draws it over today's table as «Поточне відключення» — see `parseSchedule`.
 * An earlier version of this adapter took type 2 for ГАВ(Р) and type 3 for СГАВ and published all
 * 35 labels; only the 12 ГПВ підчерги ever had hours, and they are the national 1.1–6.2, so they go
 * out under the national keys like every other operator's.
 *
 * The grid is natively 48 half-hours — more precise than the canonical hour cell — so pairs of
 * slots are folded with `hourStateFromHalves`, which is exactly what ДТЕК's `first`/`second` codes
 * carry. There is no weekly plan, only published days, so `preset.data` stays empty.
 */
const BASE = 'https://off.energy.mk.ua';

/**
 * The page's legend and stylesheet, verbatim: `OFF` «Заплановане відключення» (light red),
 * `SURE_OFF` «Актуальне відключення» (red), `PROBABLY_OFF` «Електропостачання можливе» (yellow),
 * `ENABLE` «Є світло» (green). Both reds are an outage the operator has put in writing — in the
 * archived January 2026 days `OFF` is the bulk of every outage block, so reading it as "maybe" (as
 * this adapter once did) turned published blackouts into shrugs. A code outside these four has no
 * colour on their own page; there is nothing to mirror, so it fails the run instead of being guessed.
 */
const SLOT_STATE = { ENABLE: 'on', OFF: 'off', SURE_OFF: 'off', PROBABLY_OFF: 'possible' };

/**
 * How old a day's newest row must be before that day is trusted to be whole. Every edit deletes
 * the day's rows and writes them back one at a time: schedule 123 (29.01.2026) came back as ids
 * 176296–176727 in place of 172407–172838, and in 4 of the 18 archived series `created_at` ticks
 * over a second mid-series (15.01, 21.01, 29.01, 02.02). Rows go in by type — every `OFF`, then
 * `PROBABLY_OFF`, then `SURE_OFF` — and on 17.02.2026 109 of the 110 `SURE_OFF` half-hours had no
 * other row, so that day cut before its first `SURE_OFF` row shows 47 hour cells of published
 * outage as light while passing every other check here. Cloudflare serves `active` well past its
 * `max-age=22` (age 51 on 2026-10-01), so a cut copy can outlive the write by a minute; two minutes
 * covers that and clock drift. Reading twice would not help: both reads get the same cached copy.
 * `created_at` is true UTC — Laravel serialises it exactly as it does `from`, which is an exact
 * Kyiv midnight.
 */
const SETTLE_MS = 2 * 60 * 1000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `"HH:MM:00"` for half-hour `index` of a day, 0–47; 48 wraps to the `"00:00:00"` the API ends on. */
function halfHour(index) {
  return `${String(Math.floor(index / 2) % 24).padStart(2, '0')}:${index % 2 ? '30' : '00'}:00`;
}

/** The wall-clock half-hour `date` falls in, in Kyiv, 0–47 — the clock the 48 slots run on. */
function kyivHalfHour(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 2 + (Number(parts.minute) >= 30 ? 1 : 0);
}

/**
 * `time_series_id` → slot 0..47. Served on 2026-10-01 as ids 1–48, `"00:00:00"`–`"00:30:00"`
 * through `"23:30:00"`–`"00:00:00"`. The page draws its rows straight from this list, so anything
 * other than the 48 contiguous half-hours of a wall-clock day would shift every cell under it.
 */
function slotsById(timeSeries) {
  if (!Array.isArray(timeSeries) || timeSeries.length !== 48) {
    throw new Error(`mykolaiv: time-series has ${Array.isArray(timeSeries) ? timeSeries.length : typeof timeSeries} slots, expected 48`);
  }
  const slots = new Map();
  [...timeSeries]
    .sort((a, b) => String(a?.start).localeCompare(String(b?.start)))
    .forEach((slot, index) => {
      if (slot?.start !== halfHour(index) || slot?.end !== halfHour(index + 1)) {
        throw new Error(`mykolaiv: slot ${index} is ${slot?.start}–${slot?.end}, expected ${halfHour(index)}–${halfHour(index + 1)}`);
      }
      if (slot.id === undefined || slots.has(String(slot.id))) throw new Error(`mykolaiv: slot id ${slot.id} missing or repeated`);
      slots.set(String(slot.id), index);
    });
  return slots;
}

/**
 * Operator queue id → `GPV1.1`…, taken from the names the API gives, never from the ids. On
 * 2026-10-01 the ids were 14–17, 19–22 and 24–27 (18 and 23 are gaps), and the assignments behind
 * them changed that day — nothing promises the ids stay put. Exactly the national twelve or nothing:
 * a thirteenth name, or one missing, means a scheme this adapter has not seen.
 *
 * Also returns the codes whose `enabled` is 1 — switched off right now (see `parseSchedule`). Only
 * the numbers 0 and 1 have ever been served, live and in all 16 archived lists; any other value is
 * a flag this adapter cannot read, and reading it either way would be guessing whether people have light.
 */
function codesById(queues) {
  if (!Array.isArray(queues)) throw new Error(`mykolaiv: ГПВ queue list is ${typeof queues}, expected an array`);
  const codes = new Map();
  const live = new Set();
  for (const queue of queues) {
    const label = typeof queue?.name === 'string' ? queue.name.trim() : null;
    if (queue?.type_id !== 3 || !NATIONAL_QUEUES.includes(label) || queue.id === undefined) {
      throw new Error(`mykolaiv: unexpected ГПВ queue ${JSON.stringify(queue)}`);
    }
    if (codes.has(String(queue.id)) || [...codes.values()].includes(`GPV${label}`)) {
      throw new Error(`mykolaiv: ГПВ queue ${label} (id ${queue.id}) listed twice`);
    }
    if (queue.enabled !== 0 && queue.enabled !== 1) {
      throw new Error(`mykolaiv: ГПВ queue ${label} has enabled ${JSON.stringify(queue.enabled)}, expected 0 or 1`);
    }
    codes.set(String(queue.id), `GPV${label}`);
    if (queue.enabled === 1) live.add(`GPV${label}`);
  }
  if (codes.size !== NATIONAL_QUEUES.length) {
    throw new Error(`mykolaiv: ${codes.size} ГПВ queues, expected ${NATIONAL_QUEUES.length}`);
  }
  return { codes, live };
}

/**
 * The Kyiv day a published schedule covers. The page labels each one by the local date of `from`;
 * every archived payload (15 of them, 29.12.2025–22.02.2026) has `from` at exactly Kyiv midnight,
 * written in UTC — `"2026-01-28T22:00:00.000000Z"` is 29.01. Anything else is refused rather than
 * rounded: on 26.10.2026 a midnight computed with the summer offset would land at 23:00 on the 25th
 * and file the next day's outages under the wrong date. The 48 slots themselves are wall-clock, as
 * are the canonical 24 hour rows, so the 25-hour 25.10 needs no other handling.
 */
function dayOf(item) {
  const at = typeof item?.from === 'string' ? Date.parse(item.from) : NaN;
  if (Number.isNaN(at)) throw new Error(`mykolaiv: schedule ${item?.id} has no usable "from" (${JSON.stringify(item?.from)})`);
  const epoch = kyivDayStart(new Date(at));
  if (epoch * 1000 !== at) throw new Error(`mykolaiv: schedule ${item.id} starts at ${item.from}, not at a Kyiv midnight`);
  return epoch;
}

/**
 * Turns the three payloads into the queue list and the published days.
 *
 * @param {object} input
 * @param {unknown} input.timeSeries  `/api/schedule/time-series`
 * @param {unknown} input.queues      `/api/outage-queue/by-type/3`
 * @param {unknown} input.active      `/api/v2/schedule/active`
 * @param {Date}    [input.now]
 */
export function parseSchedule({ timeSeries, queues, active, now = new Date() }) {
  const slots = slotsById(timeSeries);
  const { codes, live } = codesById(queues);
  if (!Array.isArray(active)) throw new Error(`mykolaiv: active schedule is ${typeof active}, expected an array`);

  // Out of season `active` is `[]` (as on 2026-10-01) and the page then invents an empty today.
  // That is the page's convenience, not the operator's statement, so no day is made up here.
  // Only today and tomorrow are kept: the API drops a day at midnight, but a cached response or a
  // skewed clock must not let yesterday's table stand in for today's.
  const today = kyivDayStart(now);
  const tomorrow = kyivDayStart(new Date((today + 36 * 3600) * 1000));

  // The page files every schedule under its date and concatenates the series of any two that share
  // one, in payload order; the same is done here so the overlap rule below sees the same sequence.
  const seriesByDay = new Map();
  const withheld = new Set();
  for (const item of active) {
    const day = dayOf(item);
    // A schedule with no rows. Never seen in the archive, but the operator stores only cells that
    // are not «Є світло» (02.01.2026 named 2 of the 12 підчерги, in 11 rows), so a day saved all
    // green, or a date created before its grid is filled in, arrives exactly like this — and the
    // page, which reads `null` the same way, draws it all green. It may equally be the instant
    // between the delete and the re-insert every edit does, and one response cannot tell the two
    // apart. So that date alone is left out: no day is invented, none is turned into "Світло є",
    // and the other day keeps updating. Failing the run instead, as this adapter once did, froze
    // tomorrow's revisions behind an empty today for as long as it stayed in `active`.
    if (item.series === null || (Array.isArray(item.series) && item.series.length === 0)) {
      withheld.add(day);
      continue;
    }
    if (!Array.isArray(item.series)) {
      throw new Error(`mykolaiv: schedule ${item.id} (${item.from}) has series ${JSON.stringify(item.series)}, expected an array`);
    }
    seriesByDay.set(day, [...(seriesByDay.get(day) ?? []), ...item.series]);
  }

  // The page's «Поточне відключення»: `initTable` makes today's current row blink for every
  // підчерга whose `enabled` is 1, whatever the plan says for that half-hour, and the address
  // lookup words the same flag «відбулося знеструмлення через застосування ГПВ». In the 14 archived
  // pairs of queue list and schedule (29.12.2025–22.02.2026) a current `OFF`/`SURE_OFF` cell never
  // had the flag down, but nine times it stood over a planned maybe or over nothing at all — on
  // 02.02.2026 at 22:30, 5.1 was planned off until 22:00, maybe until 22:30 and then light, with
  // the flag still up. Mirroring the plan alone told those people light was on while the
  // operator's page said it was off. So the half-hour holding `now` is made off for a flagged
  // queue — only that one, since the flag carries no end, and only on a day the operator published:
  // on any other day one off cell would make every cell around it read as "Світло є".
  // Deliberate cost: each time this moves `fact`, mirror.mjs sends the region a silent push — when
  // the flag first lands on a planned light or maybe, once a half-hour while it stays (the half-hour
  // just gone falls back to its plan), and when it lifts. The first of those is the case pushes are
  // for: alerts armed for "light at 22:30" while it is still dark.
  const nowSlot = kyivHalfHour(now);

  const fact = {};
  for (const [day, series] of seriesByDay) {
    // operator type per queue code, 48 slots each; a slot nobody mentions is `ENABLE`, as on the page
    const grid = {};
    let newest = -Infinity;
    for (const entry of series) {
      const code = codes.get(String(entry?.outage_queue_id));
      const slot = slots.get(String(entry?.time_series_id));
      // The page silently drops entries it cannot place, which would show a real outage as "Є
      // світло". Every archived entry named a ГПВ підчерга and a known slot, so a stranger means
      // the lists and the grid have come apart.
      if (code === undefined) throw new Error(`mykolaiv: series entry ${entry?.id} names queue ${entry?.outage_queue_id}, not a ГПВ підчерга`);
      if (slot === undefined) throw new Error(`mykolaiv: series entry ${entry.id} names unknown slot ${entry.time_series_id}`);
      if (!Object.hasOwn(SLOT_STATE, entry.type)) throw new Error(`mykolaiv: series entry ${entry.id} has unknown type ${JSON.stringify(entry.type)}`);
      const written = typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : NaN;
      if (Number.isNaN(written)) throw new Error(`mykolaiv: series entry ${entry.id} has no usable created_at (${JSON.stringify(entry.created_at)})`);
      newest = Math.max(newest, written);

      // The page's own overlap rule (`initTable`): later entries overwrite earlier ones, except that
      // nothing overwrites `SURE_OFF`. Overlaps are real — 15.01.2026 lists 4.1's 17:30 and 18:00
      // slots twice, `OFF` then `SURE_OFF`.
      const types = (grid[code] ??= Array(48).fill('ENABLE'));
      if (types[slot] !== 'SURE_OFF') types[slot] = entry.type;
    }

    // Dropped only after it was checked: a malformed row is a changed API whichever day it sits in.
    if (day !== today && day !== tomorrow) continue;
    // A same-date schedule with no rows makes the whole date unknown, not just its own part of it.
    if (withheld.has(day)) continue;
    if (now.getTime() - newest < SETTLE_MS) {
      throw new Error(
        `mykolaiv: the day from ${new Date(day * 1000).toISOString()} was written at ` +
        `${new Date(newest).toISOString()}, under ${SETTLE_MS / 60000} min ago — the operator may still be writing it`
      );
    }

    // Every підчерга gets the day, including those the series never mentions: the operator published
    // this date, and on 02.01.2026 it named only 3.2 and 5.1 — the other ten were simply not off.
    fact[day] = {};
    for (const code of Object.keys(queueNames(NATIONAL_QUEUES))) {
      const halves = (grid[code] ?? Array(48).fill('ENABLE')).map((type) => SLOT_STATE[type]);
      if (day === today && live.has(code)) halves[nowSlot] = 'off';
      const hours = {};
      for (let hour = 1; hour <= 24; hour++) {
        hours[String(hour)] = hourStateFromHalves(halves[(hour - 1) * 2], halves[(hour - 1) * 2 + 1]);
      }
      fact[day][code] = hours;
    }
  }

  return { queues: queueNames(NATIONAL_QUEUES), fact };
}

export async function fetchRegion(region) {
  // The page's own order — queues, then slots, then the schedule — one request at a time and a
  // second apart: this is a regional operator's server, and it is busiest exactly when the grid is.
  const queues = await getJSON(`${BASE}/api/outage-queue/by-type/3`);
  await pause(1000);
  const timeSeries = await getJSON(`${BASE}/api/schedule/time-series`);
  await pause(1000);
  const active = await getJSON(`${BASE}/api/v2/schedule/active`);

  const parsed = parseSchedule({ timeSeries, queues, active });

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: parsed.queues,
    fact: parsed.fact,
    todayEpoch: kyivDayStart(),
    update: null,
    source: 'mykolaiv'
  });
}
