import { getText } from '../lib/http.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart, kyivTomorrowStart } from '../lib/canonical.mjs';
import { markCarried } from '../lib/carried.mjs';

/**
 * АТ «Чернівціобленерго» — the table on oblenergo.cv.ua/shutdowns/, rendered server-side.
 *
 * Twelve rows «Група 1…12» × 48 half-hours, each cell a bare element whose tag and text agree:
 * `<u>з</u>` заживлені (on), `<o>в</o>` відключені (off), `<s>мз</s>` можливо заживлені
 * (possible) — the legend's own words and colours. Nothing else has ever appeared in a row
 * (13 saved tables, 6 of them in season, 2025–26).
 *
 * «Група» is the operator's own numbering, not the national підчерги: on 08.04.2026 only groups
 * 10 and 11 were cut, and the city's addresses sit in even groups only. So the rows are published
 * under their own keys, CV1…CV12, named as the operator names them; the app shows the name.
 *
 * What the page shows is the newest table it has, not today's: yesterday's after midnight, a July
 * table in October. Each day is keyed by the table's own date and kept only when that is today or
 * tomorrow. `/shutdowns/?next` never fails — without a published tomorrow it serves today's table
 * again — so it is asked only when the page links it, and kept only when it carries that date.
 * `<div id="gsv_24h">` is the operator's switch that hides the whole schedule; the table is still
 * in the HTML under it, and is not published. A day of nothing but «з» says nothing is planned,
 * which is what the app already says without a table.
 *
 * Raw HTML only: their script removes past cells in the browser, so a rendered copy is shifted.
 * The site answers only Ukrainian addresses; its last robots.txt asked for a 10 s crawl delay.
 */
const PAGE = 'https://oblenergo.cv.ua/shutdowns/';
const NEXT_DELAY_MS = 10_000;
const GROUPS = 12;
const STATES = { u: ['з', 'on'], o: ['в', 'off'], s: ['мз', 'possible'] };

export const QUEUES = Object.fromEntries(
  Array.from({ length: GROUPS }, (_, i) => [`CV${i + 1}`, `Група ${i + 1}`])
);

function kyivDateOf(text) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!match) return null;
  const [day, month, year] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return null;
  return kyivDayStart(date);
}

/**
 * One page → `{ hidden, day, groups, next }`: the table's own day, its 12 rows of 48 states, and
 * the date of tomorrow's table if the page links one. Throws on anything it does not recognise —
 * the old 18-group hourly layout included — which keeps the last good copy.
 */
export function parsePage(html) {
  const start = html.indexOf('<div id="gsv"');
  if (start === -1) throw new Error('no #gsv table on the page');
  const end = html.indexOf('arrow_forward_ios', start);
  const grid = html.slice(start, end === -1 ? undefined : end);

  const dateText = /<div id="gsv"[^>]*>\s*<ul>\s*<p>\s*([^<]*?)\s*<\/p>/.exec(grid)?.[1];
  const day = dateText ? kyivDateOf(dateText) : null;
  if (day === null) throw new Error(`unreadable table date ${JSON.stringify(dateText)}`);

  const labels = [...grid.matchAll(/<li id="grp(\d+)" data-id="(\d+)"[^>]*>\s*Група\s*<b>\s*(\d+)\s*<\/b>/g)];
  if (labels.length !== GROUPS || labels.some(([, id, data, shown], i) =>
    Number(id) !== i + 1 || Number(data) !== i + 1 || Number(shown) !== i + 1)) {
    throw new Error(`expected groups 1–${GROUPS}, found ${labels.map((m) => m[3]).join(',')}`);
  }

  const rows = [...grid.matchAll(/<div id="inf(\d+)" data-id="(\d+)"[^>]*>(.*?)<\/div>/gs)];
  if (rows.length !== GROUPS) throw new Error(`${rows.length} rows, expected ${GROUPS}`);
  const groups = rows.map(([, id, data, body], i) => {
    if (Number(id) !== i + 1 || Number(data) !== i + 1) throw new Error(`row ${i + 1} is inf${id}`);
    const cells = [...body.matchAll(/<(u|o|s)(?:\s[^>]*)?>([^<]*)<\/\1>/g)];
    const leftover = body.replace(/<(u|o|s)(?:\s[^>]*)?>[^<]*<\/\1>/g, '').trim();
    if (leftover) throw new Error(`row ${i + 1}: unexpected markup ${JSON.stringify(leftover.slice(0, 40))}`);
    if (cells.length !== 48) throw new Error(`row ${i + 1}: ${cells.length} cells, expected 48`);
    return cells.map(([, tag, text]) => {
      const [expected, state] = STATES[tag];
      if (text.trim().toLowerCase() !== expected) throw new Error(`row ${i + 1}: <${tag}>${text}</${tag}>`);
      return state;
    });
  });

  const nextText = /<a href="\/shutdowns\/\?next">\s*([^<]*?)\s*<\/a>/.exec(html)?.[1];
  return {
    hidden: /<div id="gsv_24h/.test(html),
    day,
    groups,
    next: nextText ? kyivDateOf(nextText) : null
  };
}

/** A parsed page → the day it may publish, or nothing. */
export function publishable(page, now = new Date()) {
  const today = kyivDayStart(now);
  const tomorrow = kyivTomorrowStart(now);
  if (page.hidden) {
    if (page.groups.some((row) => row.includes('off'))) {
      console.warn('[chernivtsi] the schedule is switched off on the page, but its table has outages');
    }
    return null;
  }
  if (page.day !== today && page.day !== tomorrow) return null;
  if (page.groups.every((row) => row.every((state) => state === 'on'))) return null;
  const hours = {};
  page.groups.forEach((row, i) => {
    const key = `CV${i + 1}`;
    hours[key] = {};
    for (let hour = 1; hour <= 24; hour++) {
      hours[key][String(hour)] = hourStateFromHalves(row[(hour - 1) * 2], row[(hour - 1) * 2 + 1]);
    }
  });
  return { day: page.day, hours };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchRegion(region, now = new Date(), { fetchPage = getText, wait = pause } = {}) {
  const fact = {};
  const carried = [];
  const page = parsePage(await fetchPage(PAGE));
  const first = publishable(page, now);
  if (first) fact[first.day] = first.hours;

  // Asked even when today's page is switched off: a quiet day can be followed by a dark one, and
  // its 00:00 outages must reach phones the evening before.
  const tomorrow = kyivTomorrowStart(now);
  if (page.next === tomorrow) {
    try {
      await wait(NEXT_DELAY_MS);
      // Fewer retries than the main page: main + pause + this must stay inside the region's limit.
      const next = parsePage(await fetchPage(`${PAGE}?next`, { retries: 1, timeoutMs: 15000 }));
      // Without a published tomorrow, ?next serves today's table again.
      if (next.day === tomorrow) {
        const second = publishable(next, now);
        if (second) fact[second.day] = second.hours;
      }
    } catch (error) {
      // Today's fresh table still goes out. Tomorrow stays as phones already have it, rather than
      // vanishing for a cycle and coming back — two wake-ups and a disarmed midnight alert.
      const kept = region.previous?.fact?.data?.[tomorrow];
      if (kept) {
        fact[tomorrow] = kept;
        carried.push(tomorrow);
      }
      console.warn(`[chernivtsi] ?next: ${error.message}; tomorrow ${kept ? 'kept from the last copy' : 'not published'}`);
    }
  }

  return markCarried(buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: QUEUES,
    fact,
    todayEpoch: kyivDayStart(now),
    update: null,
    source: 'chernivtsi'
  }), carried);
}
