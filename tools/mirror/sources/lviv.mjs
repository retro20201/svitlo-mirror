import { getJSON } from '../lib/http.mjs';
import {
  buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES
} from '../lib/canonical.mjs';

/**
 * ПрАТ «Львівобленерго» — the sentences the operator prints under its own schedule picture.
 *
 * `poweron.loe.lviv.ua` is a React page over an open API Platform install at `api.loe.lviv.ua`.
 * Its `photo-grafic` menu holds three items: Today (238), Tomorrow (256) and an archive (241). The
 * page shows each slot as a PNG of the grid followed by `rawHtml` — and since 30.10.2025 that
 * rawHtml is the whole schedule in words, one sentence per група: "Група 4.2. Електроенергії
 * немає з 16:00 до 17:30." That text is the source here; the picture is never read.
 *
 * Only the two slots are fetched, by id, about 250 bytes each and served `no-cache` (Cloudflare
 * reports them DYNAMIC, so every poll reaches the origin). The menu listing carries the same two
 * plus the 728-item archive — about 2 MB, cached at the edge for two hours — and a live run never
 * needs it; it was read once, on 01.10.2026, to learn every sentence shape the parser accepts.
 * robots.txt on poweron and loe.lviv.ua is `Disallow:` with nothing after it; the API host has
 * none (404).
 *
 * Львів runs the national 1.1–6.2 scheme: every one of the 520 text items in the archive names
 * exactly those twelve groups, in that order. There is no weekly plan, so `preset.data` stays
 * empty. The address → група lookup lives on yet another host, `power-api.loe.lviv.ua`
 * (`pw_cities`, `pw_accounts`); it is for an address dictionary, not for this adapter.
 */
const API = 'https://api.loe.lviv.ua/api';

/**
 * The two slots the page shows, with the name each still has to carry.
 *
 * The page itself picks them by position (`menuItems[0]` and `[2]` of the listing), which is
 * exactly what an ordering change would break silently. Fetching by id and then checking the name
 * turns a reshuffled menu into an error instead of tomorrow's hours filed under today. The slot
 * says nothing about the day, though: which day a text describes is read from the text alone.
 */
const SLOTS = [
  { id: 238, name: 'Today' },
  { id: 256, name: 'Tomorrow' }
];

/**
 * The only wording the page has ever shown *instead of* a schedule: "Отримано вказівку НЕК
 * «Укренерго» про відміну застосування ГПВ на 20.11.2024 …", seen in five archived slots in
 * November 2024. Their page renders `description` in place of both the picture and the text, so a
 * slot carrying it publishes no schedule, whatever its rawHtml still holds.
 */
const CANCELLED = /відмін\p{L}*\s+застосування\s+ГПВ/u;

/**
 * How the days a note is about are read. Its own stamp is left out: those five notes end
 * "Інформація станом на 18:32 20.11.2024", the hour they were written, and one posted in the
 * evening about tomorrow would carry today's date there. A date spelled any other way than
 * d.m.yyyy is not seen, so a note whose only date is written differently names no day and still
 * fails the run.
 */
const NOTE_STAMP = /станом на \d{1,2}:\d{2} \d{1,2}\.\d{1,2}\.\d{4}/g;
const NOTE_DATE = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g;

/**
 * Every line shape found across all 520 text items (30.10.2025 → 01.07.2026), and nothing else.
 *
 * Two headers, then one sentence per група: either "Електроенергія є." or "Електроенергії немає"
 * followed by one to five "з HH:MM до HH:MM" joined by ", ". Times are always two-digit and fall on
 * :00 or :30; the end of the day is written "24:00" (1 262 times), never "23:59". Anything outside
 * these shapes is a format we have not seen, and it fails the run rather than being guessed at.
 */
const DAY_LINE = /^Графік погодинних відключень на (\d{2})\.(\d{2})\.(\d{4})$/;
const STAMP_LINE = /^Інформація станом на (\d{2}):(\d{2}) (\d{2})\.(\d{2})\.(\d{4})$/;
const GROUP_ON = /^Група ([1-6]\.[12])\. Електроенергія є\.$/;
const WINDOW = String.raw`з (\d{2}):(\d{2}) до (\d{2}):(\d{2})`;
const GROUP_OFF = new RegExp(String.raw`^Група ([1-6]\.[12])\. Електроенергії немає (${WINDOW}(?:, ${WINDOW})*)\.$`);
const INTERVAL = new RegExp(WINDOW, 'g');

const DAY_MS = 86_400_000;

/**
 * A slot fetched on its own comes back as the bare item; the same API answers a collection as a
 * bare list or as `hydra:member` depending on the Accept header. All three are taken, and the item
 * is picked by id rather than by position.
 */
export function itemFrom(payload, id) {
  const candidates = Array.isArray(payload) ? payload
    : Array.isArray(payload?.['hydra:member']) ? payload['hydra:member']
      : [payload];
  const item = candidates.find((candidate) => candidate?.id === id);
  if (!item) throw new Error(`menu item ${id} is missing from the response`);
  return item;
}

/** A text field of a slot; absent and null read as empty, any other type is a changed API. */
function field(item, key) {
  const value = item[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`menu item ${item.id}: ${key} is ${typeof value}`);
  return value.trim();
}

/**
 * A slot → its schedule text, or null when the operator's page shows no schedule for it.
 *
 * Their page draws a slot only when `description` is empty and `imageUrl` is set, and then puts
 * rawHtml under the picture (`rawMobileHtml` is never read by it, and always matched anyway). Of
 * the combinations that leaves, three have been seen:
 *  - everything empty — between seasons; both slots looked like this on 01.10.2026;
 *  - the Укренерго cancellation note above — no ГПВ that day;
 *  - picture and text together — all 520 text items since 30.10.2025.
 * Anything else throws. A picture with no text is what this operator published until October 2025
 * (203 archived slots), and a schedule we cannot read must not reach the app as a day with no
 * outages; failing keeps the last good copy, which usually already holds today, published
 * yesterday as tomorrow. Text without a picture is something their page would not show at all.
 *
 * The one exception is a note that names days and never `today` (Kyiv day number): it cannot be
 * standing where today's schedule should be, so it gives no day and the other slot is still read.
 * Throwing for it would also throw away that other slot — and on 34 evenings in the archive today
 * was revised after tomorrow had gone up (10.04.2026: 2.1 and 3.2 gained 23:00–24:00 at 22:19), so
 * a "tomorrow comes later" note in the Tomorrow slot would have kept every such revision off the
 * app, which would have gone on promising light in those hours.
 */
export function scheduleText(item, slot, today) {
  if (!item || typeof item !== 'object') throw new Error(`menu item ${slot.id} is not an object`);
  if (item.id !== slot.id || item.name !== slot.name) {
    throw new Error(`menu item ${slot.id} is now ${JSON.stringify(item.name)}, expected "${slot.name}"`);
  }

  const note = field(item, 'description');
  const image = field(item, 'imageUrl');
  const text = field(item, 'rawHtml');

  if (note) {
    if (CANCELLED.test(note)) return null;
    const days = noteDays(note);
    if (today !== undefined && days.length && !days.includes(today)) return null;
    throw new Error(`${slot.name} shows a note instead of a schedule: ${JSON.stringify(note.slice(0, 120))}`);
  }
  if (!text && !image) return null;
  if (!text) throw new Error(`${slot.name} is published only as a picture`);
  if (!image) throw new Error(`${slot.name} has text but no picture, so their page does not show it`);
  return text;
}

/**
 * Markup → one string per line. Every item wraps its lines in `<p>`, and the headers in `<b>` as
 * well; one stray `</br>` was seen (item 540). Entities never appeared, so only the no-break space
 * an editor might insert is decoded — any other entity leaves the line unmatched and the run fails.
 */
function textLines(rawHtml) {
  return rawHtml
    .replace(/<\/?br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** `dd.mm.yyyy` as a day count, refusing dates that do not exist (`Date.UTC` rolls 31.02 over). */
function dayNumber(day, month, year) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    const pad = (n) => String(n).padStart(2, '0');
    throw new Error(`${pad(day)}.${pad(month)}.${year} is not a date`);
  }
  return date.getTime() / DAY_MS;
}

/** Today in Kyiv as the same day count, so "tomorrow" is one date on rather than 24 hours on. */
function kyivDayNumber(now) {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const [year, month, day] = iso.split('-').map(Number);
  return dayNumber(day, month, year);
}

/** The day numbers a note is about, its stamp excluded; an impossible date throws. */
function noteDays(note) {
  return [...note.replace(NOTE_STAMP, '').matchAll(NOTE_DATE)]
    .map(([, day, month, year]) => dayNumber(Number(day), Number(month), Number(year)));
}

/**
 * The day a text describes, from its own "Графік погодинних відключень на" line.
 *
 * Never from the slot it sits in: on 10.04.2026 the operator revised that day's schedule at 22:19,
 * forty minutes after posting 11.04's. Nor from the item's name: "Графік передано 17:05
 * 01.07.2026" holds a text stamped 17:29, and in 719 of the archive's 728 names the minutes are
 * just the hour again on a 12-hour clock.
 */
export function scheduleDay(rawHtml) {
  const lines = textLines(rawHtml).filter((line) => DAY_LINE.test(line));
  if (lines.length !== 1) throw new Error(`expected one "Графік … на" line, found ${lines.length}`);
  const [, day, month, year] = DAY_LINE.exec(lines[0]);
  return {
    text: `${day}.${month}.${year}`,
    number: dayNumber(Number(day), Number(month), Number(year))
  };
}

/** Minutes since midnight, throwing for a time that cannot exist; `24:00` only as an end. */
function minutes(hour, minute, { end = false } = {}) {
  const h = Number(hour);
  const m = Number(minute);
  if (m > 59 || h > 24 || (h === 24 && (!end || m !== 0))) {
    throw new Error(`${hour}:${minute} is not a time`);
  }
  return h * 60 + m;
}

/**
 * One "з … до …" list → 48 half-hour states.
 *
 * Boundaries round outward, so a window touching a half-hour darkens all of it: promising light
 * inside a declared outage is the failure that costs a fridge. An end of "00:00" after a later
 * start is midnight at the close of the day — one of the spellings the Telegram operators have
 * shipped (lib/telegram.mjs); this one has written "24:00" every time so far. The only
 * "з 00:00 до 00:00" ever seen is item 540, a form never filled in: every група at 00:00–00:00,
 * dated 12.08.2024 and posted fourteen months later. Read as an outage it would black out the
 * whole oblast for a day, so a window that does not move forward throws instead.
 */
function slotsFromIntervals(list) {
  const slots = Array(48).fill('on');
  for (const [, h1, m1, h2, m2] of list.matchAll(INTERVAL)) {
    const from = minutes(h1, m1);
    let to = minutes(h2, m2, { end: true });
    if (to === 0 && from > 0) to = 24 * 60;
    if (to <= from) throw new Error(`"з ${h1}:${m1} до ${h2}:${m2}" does not move forward`);
    for (let slot = Math.floor(from / 30); slot < Math.ceil(to / 30); slot++) slots[slot] = 'off';
  }
  return slots;
}

/**
 * A slot's text → its day, the operator's stamp and every група's 48 half-hours. Throws on any line
 * it does not recognise, a група missing or named twice, and a stamp that does not sit on the day
 * or the day before it — which is where all 519 real stamps sat.
 */
export function parseScheduleText(rawHtml) {
  const day = scheduleDay(rawHtml);
  let stamp = null;
  const halves = {};

  for (const line of textLines(rawHtml)) {
    if (DAY_LINE.test(line)) continue;

    const stamped = STAMP_LINE.exec(line);
    if (stamped) {
      if (stamp) throw new Error('two "Інформація станом на" lines');
      const [, hour, minute, d, m, y] = stamped;
      const number = dayNumber(Number(d), Number(m), Number(y));
      stamp = {
        text: `${hour}:${minute} ${d}.${m}.${y}`,
        at: number * 1440 + minutes(hour, minute),
        day: number
      };
      continue;
    }

    const on = GROUP_ON.exec(line);
    const off = on ? null : GROUP_OFF.exec(line);
    const label = (on ?? off)?.[1];
    if (!label) throw new Error(`unrecognised line: ${JSON.stringify(line)}`);
    if (halves[`GPV${label}`]) throw new Error(`група ${label} is listed twice`);
    halves[`GPV${label}`] = off ? slotsFromIntervals(off[2]) : Array(48).fill('on');
  }

  if (!stamp) throw new Error('no "Інформація станом на" line');
  const lead = day.number - stamp.day;
  if (lead < 0 || lead > 1) throw new Error(`schedule for ${day.text} stamped ${stamp.text}`);
  const missing = NATIONAL_QUEUES.filter((label) => !halves[`GPV${label}`]);
  if (missing.length) throw new Error(`no sentence for група ${missing.join(', ')}`);

  return { day, stamp, halves };
}

/**
 * The two slots → canonical `fact` and the newest stamp among the days kept.
 *
 * Only today and tomorrow (Kyiv) are kept. An older text is a slot nobody has cleared yet — just
 * after midnight Today still shows yesterday — and is skipped before its sentences are read. A
 * text dated further ahead than tomorrow has never been seen and could only be a mistyped date, so
 * it throws rather than vanish. When both slots describe the same day, the later stamp wins.
 */
export function factFromItems(items, now = new Date()) {
  const today = kyivDayNumber(now);
  const kept = new Map();

  SLOTS.forEach((slot, index) => {
    const text = scheduleText(items[index], slot, today);
    if (text === null) return;

    const lead = scheduleDay(text).number - today;
    if (lead < 0) return;
    if (lead > 1) throw new Error(`${slot.name} holds a schedule ${lead} days ahead`);

    const parsed = parseScheduleText(text);
    const held = kept.get(parsed.day.number);
    if (held && held.stamp.at === parsed.stamp.at &&
        JSON.stringify(held.halves) !== JSON.stringify(parsed.halves)) {
      throw new Error(`two schedules for ${parsed.day.text}, both stamped ${parsed.stamp.text}`);
    }
    if (!held || parsed.stamp.at > held.stamp.at) kept.set(parsed.day.number, parsed);
  });

  const fact = {};
  let update = null;
  for (const parsed of [...kept.values()].sort((a, b) => a.day.number - b.day.number)) {
    // Midday UTC is the same calendar day in Kyiv at either offset, so this lands on the day's own
    // midnight even on 25.10.2026, when the clocks go back.
    const epoch = kyivDayStart(new Date(parsed.day.number * DAY_MS + 12 * 3_600_000));
    fact[epoch] = {};
    for (const [queue, slots] of Object.entries(parsed.halves)) {
      const hours = {};
      for (let hour = 1; hour <= 24; hour++) {
        hours[String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
      }
      fact[epoch][queue] = hours;
    }
    if (!update || parsed.stamp.at > update.at) update = parsed.stamp;
  }

  return { fact, update: update?.text ?? null };
}

/** Split out from `fetchRegion` so the whole snapshot can be built from captured slots offline. */
export function snapshotFromItems(region, items, now = new Date()) {
  const { fact, update } = factFromItems(items, now);
  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    // Named even when no slot holds a schedule: the scheme is fixed, and a snapshot without queues
    // would be published as degraded rather than as a quiet season.
    queues: queueNames(NATIONAL_QUEUES),
    fact,
    todayEpoch: kyivDayStart(now),
    update,
    source: 'lviv'
  });
}

export async function fetchRegion(region) {
  const items = [];
  for (const slot of SLOTS) {
    // A second apart: two small requests every poll, against an origin that bypasses its cache.
    if (items.length) await new Promise((resolve) => setTimeout(resolve, 1000));
    items.push(itemFrom(await getJSON(`${API}/menu_items/${slot.id}`), slot.id));
  }
  return snapshotFromItems(region, items);
}
