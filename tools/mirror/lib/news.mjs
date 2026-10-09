/**
 * Schedule news for the people who switched it on: «Зʼявився графік на завтра», «Графік на завтра
 * змінено», «Оперативні зміни в графіку», a picture day, «Аварійні відключення».
 *
 * Unlike the silent `region-*` push (notify.mjs) these are visible alerts, because only a visible
 * alert reaches a phone where the app was force-quit, Low Power Mode is on, Background App Refresh
 * is off or it is ten at night — the ordinary state of a phone during blackouts. They go to opt-in
 * topics only: `q_<region>_<queue>`, `s_<region>` for a day published as a picture, `e_<region>`.
 *
 * Pure: no files, no network, the clock passed in. send-news.mjs feeds it the files being served,
 * read by lib/news-observe.mjs, and a ledger, and does the sending.
 *
 * The baseline is the ledger of what people were told (or what was adopted without telling them),
 * never the previous fetch. Comparing fetch to fetch is what turns an operator's flap — a day that
 * vanishes for ten minutes and comes back as it was — into two alerts; against the ledger it is
 * nothing. Only definite outages count, today only from the next full hour, and a change must be
 * read twice, 90 s apart, before anyone hears of it.
 */

import { createHash } from 'node:crypto';
import { kyivDayStart, kyivTomorrowStart } from './canonical.mjs';
import { SLOW_TURN_SECONDS } from './lanes.mjs';
import { REGIONS } from '../regions.mjs';

// --- Topics. Byte for byte what the app subscribes to (OutagePushSubscriber.swift); the shared
// vectors in news.test.mjs are the same table its tests use.

/**
 * A queue id as an FCM topic part: `[A-Za-z0-9]` kept, `.` → `-`, every other UTF-8 byte → `%HH`.
 * `-`, `_` and `%` are escaped too, so the encoding is injective — Тернопіль's queue labels are
 * free strings, and two of them must never share a topic.
 */
export const encQueue = (queue) => [...Buffer.from(queue, 'utf8')].map((b) =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ? String.fromCharCode(b)
  : b === 0x2e ? '-' : '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
export const newsTopic = (region, queue) => `q_${region}_${encQueue(queue)}`;   // q_poltava_GPV3-1
export const sheetTopic = (region) => `s_${region}`;
export const emergencyTopic = (region) => `e_${region}`;

// --- Masks: a day as 48 half-hour bits, bit i = slot i (00:00–00:30 is slot 0), kept as the 12 hex
// chars lib/news-observe.mjs reads them into.

const ALL = (1n << 48n) - 1n;
const bits = (value) => BigInt(`0x${value}`);

export function popcount(mask) {
  let count = 0;
  for (let rest = mask; rest; rest >>= 1n) count += Number(rest & 1n);
  return count;
}

// --- The Kyiv clock. `hourCycle: 'h23'`, never `hour12: false`: under Node 20's ICU the latter
// writes midnight as "24" (lib/canonical.mjs, kyivDayStart).

const KYIV_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

/** Kyiv wall clock. On 25 жовтня both 00:30Z and 01:30Z read 03:30 — slots are wall-clock rows. */
export function kyivClock(now = new Date()) {
  const parts = KYIV_CLOCK.formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return { hour: get('hour'), minute: get('minute') };
}

/**
 * The first slot of `day` that still matters: all of tomorrow; today from the next full hour (48,
 * nothing, at 23:xx). Anything inside the current hour is left out on purpose — Миколаїв's live
 * flag and Чернігів's folds darken the half-hour under way, and that is no news. Other days: null.
 */
export function windowStart(day, now = new Date()) {
  if (day === kyivTomorrowStart(now)) return 0;
  if (day === kyivDayStart(now)) return 2 * (kyivClock(now).hour + 1);
  return null;
}

const windowMask = (start) => ALL ^ ((1n << BigInt(start)) - 1n);

// --- Deciding.

/** Two fresh reads at least this far apart before anyone hears of a change. */
export const SETTLE_MS = 90_000;
/** "Nothing any more" is the claim a flap fakes best: three reads over four minutes. */
export const CANCEL_SETTLE_READS = 3;
export const CANCEL_SETTLE_MS = 4 * 60_000;
/**
 * A region unread for longer than this has been away — the server down, the source failing, a
 * GitHub relay — and on its return today is adopted without a word: whatever changed meanwhile is
 * old news, and telling it now would be telling it late and in a burst. The slowest normal reader
 * is the slow lane (lib/lanes.mjs), once SLOW_TURN_SECONDS have passed, on the next two-minute
 * tick: about every six minutes. Three of those is under 23 minutes, so the 30-minute floor holds
 * for every lane; the formula keeps the gap above three slow reads should the slow turn grow.
 */
const CYCLE_SECONDS = 120;
export const GAP_MS = Math.max(30 * 60_000, 3 * (SLOW_TURN_SECONDS + CYCLE_SECONDS) * 1000);
/** At most one alert per queue-day in this long; the latest settled state goes out after it. */
export const RATE_GAP_MS = 15 * 60_000;
export const MAX_SENDS = 5;
export const MAX_SHEET_SENDS = 3;
/** Only the first three of a queue-day ring; four and five arrive quietly. */
export const SOUNDED_SENDS = 3;
/** A table read off a picture people were just told about is the same news, not a new one. */
export const PICTURE_HOLD_MS = 3 * 3600_000;
/** A send that keeps failing is given up after this many tries, or this long after it settled. */
export const MAX_ATTEMPTS = 3;
export const GIVE_UP_MS = 90 * 60_000;
/** More due than this in one cycle is a bug or a broken source, not news. */
export const BREAKER = 180;

const SHEET = '#sheet';
const EMERGENCY = '#emergency';

export const emptyLedger = () => ({ v: 1, savedAt: null, regions: {}, entries: {} });

const newEntry = () => ({
  base: null, told: false, sends: 0, lastSentAt: null, pending: null, inflight: null, attempts: 0
});

/** `region|queue|day`; `#` never occurs in a queue id, because Тернопіль's adapter splits on it. */
const keyOf = (region, queue, day) => `${region}|${queue}|${day}`;
export function parseKey(key) {
  const first = key.indexOf('|');
  const last = key.lastIndexOf('|');
  return { region: key.slice(0, first), queue: key.slice(first + 1, last), day: Number(key.slice(last + 1)) };
}

const adopt = (entry, value) => Object.assign(entry, { base: value, pending: null, attempts: 0 });

/** Counts this read toward settling `value`; true once it has settled. */
function settle(entry, value, at, { reads = 2, ms = SETTLE_MS } = {}) {
  if (entry.pending?.mask === value) entry.pending.seen++;
  else Object.assign(entry, { pending: { mask: value, firstSeen: at, seen: 1 }, attempts: 0 });
  return entry.pending.seen >= reads && at - entry.pending.firstSeen >= ms;
}

/**
 * The ledger after this cycle's fresh reads, the events now due, and a line per decision.
 *
 * Kind comes from whether the ledger has an entry, not from whether anyone was told: a day adopted
 * silently at bootstrap that then changes is «змінено», never «зʼявився».
 */
export function decide({ ledger: input, observations, now = new Date(), fingerprint, freshIds = [], known = REGIONS.map((region) => region.id) }) {
  const ledger = structuredClone(input ?? emptyLedger());
  ledger.regions ??= {};
  ledger.entries ??= {};
  const { entries } = ledger;
  const at = now.getTime();
  const today = kyivDayStart(now);
  const tomorrow = kyivTomorrowStart(now);
  let due = [];
  const log = [];
  const entry = (key) => (entries[key] ??= newEntry());
  const held = (key, kind, why) => {
    log.push({ key, kind, outcome: `held(${why})` });
    return null;
  };
  const adopted = (key, kind, target, value, why) => {
    adopt(target, value);
    log.push({ key, kind, outcome: `adopted(${why})` });
    return null;
  };
  // Only after a failed send: an event that merely waited out its settle is not stale.
  const gaveUp = (target) =>
    target.attempts > 0 && (target.attempts >= MAX_ATTEMPTS || at - target.pending.firstSeen > GIVE_UP_MS);

  const queueEvent = (seen, { key, queue, day, value }, current) => {
    const window = windowMask(windowStart(day, now));
    const mask = bits(value);
    let kind;
    if (!current || current.base === null) {
      kind = 'published';
    } else {
      const base = bits(current.base);
      // Nothing that still matters moved: past slots drifting, the half-hour under way.
      if (((mask ^ base) & window) === 0n) {
        adopt(current, value);
        return null;
      }
      kind = (mask & window) === 0n ? 'cancelled' : 'revised';
    }
    const target = entry(key);
    const settled = kind === 'cancelled'
      ? settle(target, value, at, { reads: CANCEL_SETTLE_READS, ms: CANCEL_SETTLE_MS })
      : settle(target, value, at);
    if (!settled) return held(key, kind, 'settle');
    if (gaveUp(target)) return adopted(key, kind, target, value, 'gave-up');

    if (kind === 'published' && (mask & window) === 0n) {
      // A day without outages for this queue. Today that is never news; tomorrow it is only when
      // outages are on — elsewhere in the region that day, or for this queue today. Out of season
      // Полтава's daily «не прогнозується» and Telegram's 'on' padding would otherwise ring.
      if (day !== tomorrow) return adopted(key, kind, target, value, 'quiet-gate');
      const elsewhere = Object.entries(seen.days[day].masks).some(([other, m]) => other !== queue && bits(m) !== 0n);
      const todayMask = seen.days[today]?.masks[queue] ?? entries[keyOf(seen.region, queue, today)]?.base;
      if (!elsewhere && !(todayMask != null && bits(todayMask) !== 0n)) return adopted(key, kind, target, value, 'quiet-gate');
    }
    if (kind === 'published') {
      // The picture of this day went out; now it reads as a table. Within three hours that is the
      // same news; after, the table counts as a change to what people were shown — for a queue it
      // darkens. One it leaves clear stays «зʼявився … не заплановано», gated as above: «скасовано»
      // would cancel outages no one ever told it of.
      const picture = entries[keyOf(seen.region, SHEET, day)];
      if (picture?.lastSentAt != null) {
        if (at - picture.lastSentAt < PICTURE_HOLD_MS) return adopted(key, kind, target, value, 'picture');
        if ((mask & window) !== 0n) kind = 'revised';
      }
    }
    if (target.sends >= MAX_SENDS) return adopted(key, kind, target, value, 'cap');
    if (target.lastSentAt != null && at - target.lastSentAt < RATE_GAP_MS) return held(key, kind, 'gap15');
    return {
      key, type: 'queue', region: seen.region, queue, day, kind, mask: value, base: target.base,
      quiet: seen.days[day].state === 'quiet', regionTitle: seen.title, queueName: seen.names[queue] ?? queue,
      sends: target.sends
    };
  };

  const sheetEvent = (seen, { key, day, value, isRevision }, current) => {
    if (current && current.base === value) {
      current.pending = null;
      return null;
    }
    const toldTable = Object.entries(entries).some(([other, e]) => {
      const parsed = parseKey(other);
      return parsed.region === seen.region && parsed.day === day && !parsed.queue.startsWith('#') && e.told;
    });
    const kind = (current && current.base !== null) || toldTable || isRevision ? 'sheet-revised' : 'sheet-published';
    const target = entry(key);
    if (!settle(target, value, at)) return held(key, kind, 'settle');
    if (gaveUp(target)) return adopted(key, kind, target, value, 'gave-up');
    if (target.sends >= MAX_SHEET_SENDS) return adopted(key, kind, target, value, 'cap');
    if (target.lastSentAt != null && at - target.lastSentAt < RATE_GAP_MS) return held(key, kind, 'gap15');
    return { key, type: 'sheet', region: seen.region, day, kind, mask: value, base: target.base, regionTitle: seen.title, sends: target.sends };
  };

  // Once per region-day: never repeated, and no "ended" — YASNO's flag is not that precise.
  const emergencyEvent = (seen, { key, day, value }, current) => {
    if (current?.base != null) {
      current.pending = null;
      return null;
    }
    const target = entry(key);
    if (!settle(target, value, at)) return held(key, 'emergency', 'settle');
    if (gaveUp(target)) return adopted(key, 'emergency', target, value, 'gave-up');
    return { key, type: 'emergency', region: seen.region, day, kind: 'emergency', mask: value, base: null, regionTitle: seen.title, sends: target.sends };
  };

  for (const region of freshIds) {
    const seen = observations[region];
    if (!seen) continue;
    const state = ledger.regions[region];

    const items = [];
    for (const [day, { masks }] of Object.entries(seen.days)) {
      for (const [queue, mask] of Object.entries(masks)) items.push({ type: 'queue', key: keyOf(region, queue, day), queue, day: Number(day), value: mask });
    }
    for (const [day, sheet] of Object.entries(seen.sheets)) {
      items.push({ type: 'sheet', key: keyOf(region, SHEET, day), day: Number(day), value: sheet.key, isRevision: sheet.isRevision });
    }
    for (const day of seen.emergency) items.push({ type: 'emergency', key: keyOf(region, EMERGENCY, day), day, value: '1' });
    // Observed on one side of midnight and decided on the other: only today and tomorrow are news.
    const current = items.filter((item) => item.day === today || item.day === tomorrow);
    const observed = new Set(current.map((item) => item.key));

    // 1. Bootstrap, a lost or corrupt ledger, or new adapter code: what is out now is taken as
    // known. A change of our own code is not the operator's news.
    const rebaseline = !state || state.fp !== fingerprint;
    // 2. Back after a gap: today is adopted, tomorrow is still news.
    const gap = !rebaseline && at - state.lastFreshAt > GAP_MS;

    for (const item of current) {
      const prior = entries[item.key];
      if (rebaseline) {
        Object.assign(adopt(entry(item.key), item.value), { told: false });
        log.push({ key: item.key, kind: '-', outcome: 'adopted(rebaseline)' });
        continue;
      }
      if (gap && (item.day === today || item.type === 'emergency')) {
        if (prior?.base !== item.value) log.push({ key: item.key, kind: '-', outcome: 'adopted(gap)' });
        adopt(entry(item.key), item.value);
        continue;
      }
      const event = item.type === 'queue' ? queueEvent(seen, item, prior)
        : item.type === 'sheet' ? sheetEvent(seen, item, prior)
        : emergencyEvent(seen, item, prior);
      if (event) due.push(event);
    }

    // Absent now: untouched but for what was settling. A vanished day never fires, and one that
    // comes back as it was finds its base and fires nothing either.
    for (const key of Object.keys(entries)) {
      if (parseKey(key).region === region && !observed.has(key)) entries[key].pending = null;
    }
    ledger.regions[region] = { fp: fingerprint, lastFreshAt: at };
  }

  // A burst this size is a broken parser or a renamed queue scheme, not a hundred and eighty pieces
  // of news. Nothing goes out, in either mode; it is all taken as known, and the file says so.
  let breaker = null;
  if (due.length > BREAKER) {
    breaker = { at, count: due.length, sample: due.slice(0, 10).map((event) => event.key) };
    for (const event of due) adopted(event.key, event.kind, entries[event.key], event.mask, 'breaker');
    ledger.breakerAt = at;
    due = [];
  }

  // Past days and regions no longer offered.
  const offered = new Set(known);
  for (const key of Object.keys(entries)) {
    const { region, day } = parseKey(key);
    if (!(day >= today) || !offered.has(region)) delete entries[key];
  }
  for (const region of Object.keys(ledger.regions)) if (!offered.has(region)) delete ledger.regions[region];

  return { ledger, due, log, breaker };
}

// --- After the send: what the ledger records. Shared by both modes, so turning `on` after a
// shadow week finds the same ledger a live week would have left.

export function recordSent(ledger, event, at) {
  const target = (ledger.entries[event.key] ??= newEntry());
  Object.assign(target, {
    base: event.mask, told: true, sends: target.sends + 1, lastSentAt: at, pending: null, inflight: null, attempts: 0
  });
}

export function recordAdopted(ledger, event) {
  const target = (ledger.entries[event.key] ??= newEntry());
  Object.assign(target, { base: event.mask, pending: null, inflight: null, attempts: 0 });
}

/** A retryable failure: the settled state stays pending, so the next cycle decides again. */
export function recordFailed(ledger, event) {
  const target = (ledger.entries[event.key] ??= newEntry());
  target.inflight = null;
  target.attempts += 1;
  return target.attempts;
}

/**
 * Sends a killed run left in flight are counted as sent. At most once: a lost banner is better
 * than a repeated one, and the silent push still re-arms the phone's own reminders.
 */
export function assumeInflightSent(ledger) {
  const keys = [];
  for (const [key, target] of Object.entries(ledger.entries ?? {})) {
    if (!target.inflight) continue;
    Object.assign(target, {
      base: target.inflight.mask, told: true, sends: target.sends + 1, lastSentAt: target.inflight.at,
      pending: null, inflight: null, attempts: 0
    });
    keys.push(key);
  }
  return keys;
}

// --- Texts. Ukrainian, in the app's own words; dates from these tables, not from ICU.

const WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/** «пт, 10 жовтня». Noon of a Kyiv day is that same calendar day in UTC, whatever the offset. */
export function dayLabel(day) {
  const noon = new Date((day + 12 * 3600) * 1000);
  return `${WEEKDAYS[noon.getUTCDay()]}, ${noon.getUTCDate()} ${MONTHS[noon.getUTCMonth()]}`;
}

const capital = (text) => text[0].toUpperCase() + text.slice(1);
const clock = (slot) => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;

/** `[start, end)` slot runs of a mask. Slot 48 is 24:00 — wall-clock rows, the 25-hour day too. */
export function runs(mask) {
  const found = [];
  let start = null;
  for (let slot = 0; slot <= 48; slot++) {
    const off = slot < 48 && ((mask >> BigInt(slot)) & 1n) === 1n;
    if (off && start === null) start = slot;
    if (!off && start !== null) {
      found.push([start, slot]);
      start = null;
    }
  }
  return found;
}

function intervals(mask) {
  const all = runs(mask);
  const shown = all.slice(0, 3).map(([from, to]) => `${clock(from)}–${clock(to)}`).join(', ');
  return all.length > 3 ? `${shown} і ще ${all.length - 3}` : shown;
}

/** Half-hours as «8 год 30 хв», «12 год», «30 хв». */
export function duration(slots) {
  const hours = Math.floor(slots / 2);
  if (!hours) return '30 хв';
  return slots % 2 ? `${hours} год 30 хв` : `${hours} год`;
}

/** Dark half-hours now against before: «на 1 год більше», «на 30 хв менше», or the same total. */
function delta(after, before) {
  if (after === before) return 'час змінився';
  return after > before ? `на ${duration(after - before)} більше` : `на ${duration(before - after)} менше`;
}

/**
 * `{ title, subtitle, body }`, or null when the day is no longer today or tomorrow. The label is
 * settled at send time, not decision time: a change decided at 23:59 and sent at 00:01 is today's.
 */
export function render(event, now = new Date()) {
  const today = kyivDayStart(now);
  const tomorrow = kyivTomorrowStart(now);
  const when = event.day === tomorrow ? 'tomorrow' : event.day === today ? 'today' : null;
  if (!when) return null;
  const date = dayLabel(event.day);

  if (event.type === 'emergency') {
    return when === 'today'
      ? { title: 'Аварійні відключення', subtitle: event.regionTitle, body: 'Оператор вимикає світло понад графік. Сьогодні графік може не виконуватися.' }
      : { title: 'Аварійні відключення завтра', subtitle: event.regionTitle, body: `Оператор попередив про відключення понад графік на ${date}.` };
  }
  if (event.type === 'sheet') {
    return event.kind === 'sheet-published'
      ? {
          title: when === 'today' ? 'Зʼявився графік на сьогодні' : 'Зʼявився графік на завтра',
          subtitle: event.regionTitle,
          body: `Оператор опублікував графік на ${date} картинкою — відкрийте, щоб знайти свою чергу.`
        }
      : {
          title: when === 'today' ? 'Графік на сьогодні оновлено' : 'Графік на завтра оновлено',
          subtitle: event.regionTitle,
          body: 'Оператор опублікував нову версію графіка картинкою — відкрийте, щоб перевірити свою чергу.'
        };
  }

  const window = windowMask(windowStart(event.day, now));
  const mask = bits(event.mask) & window;
  const off = popcount(mask);
  const before = event.base == null ? null : popcount(bits(event.base) & window);
  const subtitle = `${event.regionTitle} · ${event.queueName}`;

  if (when === 'today') {
    const title = event.kind === 'published' ? 'Зʼявився графік на сьогодні' : 'Оперативні зміни в графіку';
    if (!off) return { title, subtitle, body: 'Далі сьогодні вимкнень не заплановано.' };
    const note = event.kind === 'published' ? `разом ${duration(off)}` : before === null ? null : delta(off, before);
    return { title, subtitle, body: `Далі сьогодні без світла ${intervals(mask)}${note ? ` (${note})` : ''}.` };
  }

  // «Скасовано» only where there were outages to cancel; a clear queue with nothing before it is
  // the gated «не заплановано», whatever the kind.
  if (event.kind === 'published' || (!off && !before)) {
    if (off) return { title: 'Зʼявився графік на завтра', subtitle, body: `${capital(date)}: без світла ${intervals(mask)} (разом ${duration(off)}).` };
    return event.quiet
      ? { title: 'Графік на завтра: без вимкнень', subtitle, body: `${capital(date)}: оператор не прогнозує вимкнень за графіком.` }
      : { title: 'Зʼявився графік на завтра', subtitle, body: `${capital(date)}: вимкнень для вашої черги не заплановано.` };
  }
  if (!off) return { title: 'Вимкнення на завтра скасовано', subtitle, body: `${capital(date)}: за оновленим графіком вимкнень не заплановано.` };
  const total = `разом ${duration(off)}${before === null ? '' : `, ${delta(off, before)}`}`;
  return { title: 'Графік на завтра змінено', subtitle, body: `${capital(date)}, тепер: без світла ${intervals(mask)} (${total}).` };
}

// --- The FCM message.

function collapseId(event) {
  if (event.type === 'sheet') return `n.${event.region}.s.${event.day}`;
  if (event.type === 'emergency') return `n.${event.region}.e.${event.day}`;
  const id = `n.${event.region}.${event.queue}.${event.day}`;
  // APNs takes at most 64 bytes, and a header is no place for a free-text Тернопіль label.
  return Buffer.byteLength(id) <= 64 && /^[\x21-\x7e]+$/.test(id)
    ? id
    : `n.${createHash('sha1').update(id).digest('hex').slice(0, 24)}`;
}

/** Kyiv 22:30–07:00: delivered to the list without a sound. */
export function isNight(now = new Date()) {
  const { hour, minute } = kyivClock(now);
  const minutes = hour * 60 + minute;
  return minutes >= 22 * 60 + 30 || minutes < 7 * 60;
}

/**
 * The FCM v1 request. Every `data` value is a string, as FCM requires. A banner on the phone is
 * replaced, not stacked (collapse-id), and is dropped by APNs once its day is over (expiration).
 */
export function buildMessage(event, text, now = new Date()) {
  const { region, day } = event;
  const queue = event.type === 'queue' ? event.queue : null;
  const topic = event.topic ?? (queue !== null ? newsTopic(region, queue)
    : event.type === 'sheet' ? sheetTopic(region) : emergencyTopic(region));
  const link = `svitlo://day?region=${encodeURIComponent(region)}` +
    `${queue !== null ? `&queue=${encodeURIComponent(queue)}` : ''}&day=${day}`;
  const level = isNight(now) ? 'passive'
    : event.type === 'emergency' ? 'time-sensitive'
    : (event.sends ?? 0) < SOUNDED_SENDS ? 'active' : 'passive';
  return {
    message: {
      topic,
      data: {
        type: 'news',
        kind: event.kind,
        region,
        ...(queue !== null ? { queue } : {}),
        day: String(day),
        campaign: `news_${event.kind}`,
        deep_link: link
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
          'apns-collapse-id': collapseId(event),
          'apns-expiration': String(kyivTomorrowStart(new Date(day * 1000)))
        },
        payload: {
          aps: {
            alert: { title: text.title, subtitle: text.subtitle, body: text.body },
            ...(level === 'passive' ? {} : { sound: 'default' }),
            'thread-id': `${region}.${day}`,
            'content-available': 1,
            'interruption-level': level
          }
        }
      }
    }
  };
}
