import { getJSON } from '../lib/http.mjs';
import {
  buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES
} from '../lib/canonical.mjs';

/**
 * АТ «Прикарпаттяобленерго» — the day-ahead ГПВ from `be-svitlo.oe.if.ua`, the open API behind the
 * operator's own schedule site `svitlo.oe.if.ua`.
 *
 * Access, as checked on 2026-10-01: svitlo.oe.if.ua is a Vite/React build served by CloudFront, its
 * robots.txt reads `User-agent: * / Allow: /`, and the Cloudflare challenge it used to answer with
 * — the reason this region was ever limited to an archive — is gone. be-svitlo.oe.if.ua answers 403
 * for /robots.txt, which RFC 9309 §2.3.1.3 reads as "unavailable": access allowed. The adapter makes
 * the calls the site's own page makes, no others: the POST for the queue list it sends on load, and
 * the GET its "Отримати інформацію" button sends, once per черга. On oe.if.ua, `/uk/shutdowns_table`
 * stays untouched — that is the path robots.txt there disallows.
 *
 * This file used to read the post-factum archive on oe.if.ua (`/uk/schedule_archives`, one .xlsx
 * per past day). That archive never holds today or tomorrow, the only days the app shows, so it
 * could add nothing next to this source and was dropped with it — and with it the region's
 * `archiveOnly`.
 */
const API = 'https://be-svitlo.oe.if.ua';

// Kept in step with lib/http.mjs, which does not export its own and has no POST. Headers are
// Latin-1 only, so the app's Ukrainian name stays out of it.
const USER_AGENT = 'svitlo-mirror/1.0 (+https://koly-svitlo.web.app; outage schedule mirror)';

/** Thirteen calls a run, one after another, never more than one a second. */
const SPACING_MS = 1000;

/** The same two retries, 1 s then 2 s apart, that `getJSON` gives every GET. */
const RETRIES = 2;

const HALF_HOURS = 48;

/**
 * ── WHAT THE PAYLOAD MEANS ────────────────────────────────────────────────────────────────────
 * Read off the operator's own renderer, `svitlo.oe.if.ua/assets/index.BtERFACk.js` (fetched
 * 2026-10-01, Last-Modified 25.12.2025), not assumed. `schedule-by-queue?queue=<code>` returns
 *
 *   [{ eventDate: 'DD.MM.YYYY', queues: { '<code>': [{ from: 'HH:mm', to: 'HH:mm', … }] },
 *      scheduleApprovedSince, … }]
 *
 * and the page picks the elements whose `eventDate` is today and tomorrow (`t.find(n =>
 * n.eventDate === e)`), drawing each day for the chosen черга as one of three cards:
 *
 *   queues[code] non-empty → SCHEDULE_PLANNED: the `from —— to` rows are listed under the heading
 *                            `chipPlanned.title: "Відключення"`, each with its length;
 *   queues[code] is `[]`   → NO_SCHEDULE_PLANNED: a green (`color: "success"`) light-bulb chip,
 *                            `chipNoPlanned.label: "Не застосовується"`;
 *   no element, no key     → NO_DATA: `chipNoData.label: "Інформація відсутня"`.
 *
 * So every interval is an outage window; an empty array is a day published without outages, all
 * "yes" exactly as ДТЕК publishes one; and a missing date or key is no information at all, which
 * must never become a day of light. The page's own headline says what is listed: `Відключення в
 * мережах АТ "Прикарпаттяобленерго", пов'язані з введенням графіків погодинних відключень
 * споживачів.`. The build archived by the Wayback Machine on 2025-11-07, in season, carries the same
 * three-way logic word for word.
 *
 * No non-empty response has been captured here: on 2026-10-01 all twelve queues return `[]`, which
 * the endpoint also returns for a queue that does not exist. That is why the queue list is checked
 * on every run (see `checkQueueList`), and why everything below refuses a shape it does not
 * recognise rather than reading what it can — mirror.mjs then keeps the last good copy and reports
 * the region degraded. A day the app says nothing about is recoverable; a day it reads wrongly is
 * not.
 */

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 'HH:mm' → minutes after midnight. "24:00" is accepted here; only an end may use it. */
function minutesOf(text, where) {
  const match = typeof text === 'string' ? /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/.exec(text) : null;
  if (!match) throw new Error(`${where}: ${JSON.stringify(text)} is not HH:mm`);
  return match[1] === undefined ? 1440 : Number(match[1]) * 60 + Number(match[2]);
}

/**
 * One interval → `[dayOffset, startMinute, endMinute]` pieces on the day it is listed under (0)
 * and, when it runs past midnight, the next (1).
 *
 * The operator's page measures an interval with `to.add(+to.isBefore(from), "day")`: an end earlier
 * than the start is on the following day. So "22:00–00:00" is two hours ending at midnight,
 * "22:00–02:00" carries two hours into the next day, and "24:00" — which their time parser rolls to
 * the next midnight — is the same instant as an "00:00" end. From equal to to is the one interval
 * their page cannot measure (it prints "0 хв"); whether that means nothing or a whole day is a
 * guess either way, so it is refused.
 */
function piecesOf(interval, where) {
  if (!isRecord(interval)) throw new Error(`${where}: interval is not an object`);
  checkStatus(interval, where);
  const from = minutesOf(interval.from, `${where} from`);
  const to = minutesOf(interval.to, `${where} to`);
  if (from === 1440) throw new Error(`${where}: an outage cannot start at 24:00`);
  if (from === to) throw new Error(`${where}: ${interval.from}–${interval.to} has no length`);
  if (to > from) return [[0, from, to]];
  return to === 0 ? [[0, from, 1440]] : [[0, from, 1440], [1, 0, to]];
}

/**
 * `status` is not read by the operator's page at all — every interval is listed under
 * "Відключення", whatever it carries. The public client projects built against this API during the
 * 2025–26 season only ever recorded `1`, and the one that names other values
 * (BogdanGrushetsky/telegram-outage-bot, `OUTAGE_STATUS = { SCHEDULED: 1, NO_OUTAGE: 0 }`) reads
 * `0` as no outage at all — the opposite of what the operator's page shows for the same window.
 * With the two readings on offer contradicting each other, any middle ground would be a guess, and
 * "можливо" in particular is never announced by the app. So absent or the number 1 is the outage
 * their page lists, and anything else — "1" as a string included — stops the run until someone
 * has seen what it means.
 */
function checkStatus(interval, where) {
  if (interval.status !== undefined && interval.status !== 1) {
    throw new Error(`${where}: unknown status ${JSON.stringify(interval.status)}`);
  }
}

/** 'DD.MM.YYYY' → 'YYYY-MM-DD', refusing anything that is not a real calendar day. */
function isoDay(eventDate, where) {
  const match = typeof eventDate === 'string' ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(eventDate) : null;
  const [day, month, year] = match ? match.slice(1).map(Number) : [];
  // Date.UTC rolls 31.02 over into March; comparing the parts back catches it.
  const at = match ? new Date(Date.UTC(year, month - 1, day, 12)) : null;
  if (!at || at.getUTCDate() !== day || at.getUTCMonth() !== month - 1 || at.getUTCFullYear() !== year) {
    throw new Error(`${where}: eventDate ${JSON.stringify(eventDate)} is not DD.MM.YYYY`);
  }
  return at.toISOString().slice(0, 10);
}

/**
 * The calendar day after `iso`, by date arithmetic rather than by adding 24 hours: 25.10.2026 is
 * 25 hours long in Kyiv, and "now + 24 h" taken in its first hour is still the 25th.
 */
function nextDay(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1, 12)).toISOString().slice(0, 10);
}

/** Today in Europe/Kyiv as 'YYYY-MM-DD' — en-CA formats dates in exactly that order. */
function kyivToday(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

/** Midday UTC is the same calendar day in Kyiv whatever the offset; `kyivDayStart` does the rest. */
const epochOf = (iso) => kyivDayStart(new Date(`${iso}T12:00:00Z`));

/**
 * `scheduleApprovedSince` as their page prints it, "DD.MM.YYYY HH:mm" (the bundle's own
 * `ddMMyyyyHHmmss` format), turned into something that sorts. Anything else sorts first and is used
 * only when nothing better is there — the stamp is shown verbatim, never interpreted.
 */
function stampRank(stamp) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(stamp);
  return match ? `${match[3]}${match[2]}${match[1]}${match[4]}${match[5]}` : '';
}

/**
 * Validates one element in full — every queue in it, not only the one asked for, because a shape
 * that has moved anywhere is a payload that cannot be trusted — and returns what this черга needs.
 */
function readElement(element, code, where) {
  if (!isRecord(element)) throw new Error(`${where}: element is not an object`);
  const day = isoDay(element.eventDate, where);
  if (!isRecord(element.queues)) throw new Error(`${where}: queues is not an object`);
  for (const [key, intervals] of Object.entries(element.queues)) {
    if (!Array.isArray(intervals)) throw new Error(`${where} queue ${key}: not an array`);
    intervals.forEach((interval, index) => piecesOf(interval, `${where} queue ${key}[${index}]`));
  }
  const stamp = element.scheduleApprovedSince;
  if (stamp !== undefined && stamp !== null && typeof stamp !== 'string') {
    throw new Error(`${where}: scheduleApprovedSince is a ${typeof stamp}`);
  }
  // `queues: {}` is their page's NO_DATA and stays "no information". Keys without the черга asked
  // for are something else: their page looks the card up by the very code it took from the queue
  // list, so an answer keyed any other way ("GPV1.1", "1.1 ") means the scheme moved under it.
  // Read as NO_DATA, a season of outages would pass for the off-season with nothing marked
  // degraded — the failure `checkQueueList` exists to prevent, one level down.
  const keys = Object.keys(element.queues);
  if (keys.length && !Object.hasOwn(element.queues, code)) {
    throw new Error(`${where}: the answer for ${code} lists only ${JSON.stringify(keys)}`);
  }
  return {
    day,
    intervals: Object.hasOwn(element.queues, code) ? element.queues[code] : undefined,
    stamp: stamp?.trim() || null
  };
}

function hoursFromHalves(slots) {
  const hours = {};
  for (let hour = 1; hour <= 24; hour++) {
    hours[String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
  }
  return hours;
}

/**
 * `{ '<code>': <schedule-by-queue response> }` → canonical `fact` and the operator's update stamp.
 * Exported so the whole mapping can be tested against fixtures without touching the network.
 *
 * Only today and tomorrow in Kyiv are kept — the two days the operator's own page shows. An older
 * element is a stale record, a later one something their page never displays.
 */
export function factFromQueues(responses, now = new Date()) {
  const today = kyivToday(now);
  const shown = [today, nextDay(today)];

  /** day → queue key → 48 half-hour states */
  const halves = {};
  /** `${day}|${key}` for every day the operator actually published for that черга */
  const published = new Set();
  const stamps = [];

  for (const [code, payload] of Object.entries(responses)) {
    if (!Array.isArray(payload)) throw new Error(`queue ${code}: response is not an array`);
    const key = `GPV${code}`;
    const seen = new Map();

    payload.forEach((element, index) => {
      const where = `queue ${code} [${index}]`;
      const { day, intervals, stamp } = readElement(element, code, where);

      // Their page shows the first element for a date and never a second. Two that agree are
      // harmless; two that differ leave no way to know which is in force.
      const fingerprint = JSON.stringify(intervals ?? null);
      if (seen.has(day)) {
        if (seen.get(day) !== fingerprint) {
          throw new Error(`${where}: two different schedules for ${element.eventDate}`);
        }
        return;
      }
      seen.set(day, fingerprint);
      if (intervals === undefined) return;

      published.add(`${day}|${key}`);
      if (shown.includes(day) && stamp) stamps.push(stamp);
      (halves[day] ??= {})[key] ??= Array(HALF_HOURS).fill('on');

      for (const interval of intervals) {
        for (const [offset, start, end] of piecesOf(interval, where)) {
          const target = offset ? nextDay(day) : day;
          const slots = ((halves[target] ??= {})[key] ??= Array(HALF_HOURS).fill('on'));
          // A half hour dark for any part of it is reported dark. The operator's grid has always
          // been whole half hours (the archived sheets have 48 columns), but if a quarter ever
          // appears, ending a warning early costs a fridge and starting it early a charged phone.
          for (let slot = Math.floor(start / 30); slot < Math.ceil(end / 30); slot++) slots[slot] = 'off';
        }
      }
    });
  }

  const fact = {};
  for (const day of shown) {
    const byQueue = {};
    for (const code of Object.keys(responses)) {
      const key = `GPV${code}`;
      // A night outage carried over from the evening before lands on a day only if that day was
      // itself published for the черга. Creating the day from the carry-over alone would declare
      // the rest of it light, when all that is known is its first hours.
      if (published.has(`${day}|${key}`)) byQueue[key] = hoursFromHalves(halves[day][key]);
    }
    if (Object.keys(byQueue).length) fact[epochOf(day)] = byQueue;
  }

  const update = stamps.reduce(
    (best, stamp) => (best === null || stampRank(stamp) > stampRank(best) ? stamp : best),
    null
  );
  return { fact, update };
}

/**
 * Throws unless the operator's own list names exactly the national 1.1–6.2.
 *
 * `schedule-by-queue` answers `[]` for a queue that does not exist just as it does for a quiet
 * day, so an empty answer means something only while the code asked about is one the operator
 * still lists. Should the scheme ever change, every query here would go quietly empty and the
 * region would look out of season; failing instead marks it degraded, where someone will look.
 * The codes are compared as sent, untrimmed: their page queries with the code verbatim, so "1.1 "
 * is a черга this adapter would never be asking about.
 */
export function checkQueueList(list) {
  if (!Array.isArray(list)) throw new Error('gpv-queue-list: response is not an array');
  const codes = list.map((item, index) => {
    if (!isRecord(item) || typeof item.code !== 'string') {
      throw new Error(`gpv-queue-list [${index}]: no string code`);
    }
    return item.code;
  });
  const missing = NATIONAL_QUEUES.filter((code) => !codes.includes(code));
  const extra = codes.filter((code) => !NATIONAL_QUEUES.includes(code));
  if (missing.length || extra.length || codes.length !== NATIONAL_QUEUES.length) {
    throw new Error(
      `gpv-queue-list changed: missing [${missing}], unexpected [${extra}], ${codes.length} codes`
    );
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Their page sends this one as a bodiless POST; `getJSON` cannot, hence the direct call. It is the
 * first of the thirteen and gates the rest, so it gets the retries `getJSON` gives every GET: one
 * dropped connection here would otherwise mark the whole region degraded for a run that every GET
 * after it would have survived.
 */
async function postJSON(url) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'uk-UA,uk;q=0.9', accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await pause(SPACING_MS * (attempt + 1));
    }
  }
  throw lastError;
}

export async function fetchRegion(region) {
  checkQueueList(await postJSON(`${API}/gpv-queue-list`));

  const responses = {};
  for (const code of NATIONAL_QUEUES) {
    await pause(SPACING_MS);
    responses[code] = await getJSON(`${API}/schedule-by-queue?queue=${encodeURIComponent(code)}`);
  }

  const now = new Date();
  const { fact, update } = factFromQueues(responses, now);

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    // The list was just checked to be exactly these, so out of season, with nothing published,
    // people can still find which черга they are on before restrictions resume.
    queues: queueNames(NATIONAL_QUEUES),
    fact,
    todayEpoch: kyivDayStart(now),
    update,
    source: 'ivano-frankivsk'
  });
}
