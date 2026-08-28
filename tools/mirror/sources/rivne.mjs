import { getText } from '../lib/http.mjs';
import {
  buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES
} from '../lib/canonical.mjs';

/**
 * ПрАТ «Рівнеобленерго» — the ГПВ table on the operator's own page, read as HTML.
 *
 * There is no API behind it. `#fetched-data-container` is filled server-side by the CMS and that
 * table is the only place Рівне publishes hours; the site's WordPress REST route returns the same
 * markup in a third of the bytes, but it is addressed by numeric post id and the operator has
 * already moved this content between posts once, so the canonical URL is the safer read. It is
 * gzipped to about 35 KB on the wire, which one poll per quarter-hour can afford.
 *
 * Рівне uses Укренерго's national 1.1–6.2 scheme and says on the page that the queues themselves
 * never change — only the hours inside them do. There is no weekly plan, only published days, so
 * `preset.data` stays empty.
 */
const PAGE = 'https://www.roe.vsei.ua/disconnections/';

/** The container the CMS fills; the rest of the page is boilerplate that also contains tables. */
function scheduleTable(html) {
  const start = html.indexOf('id="fetched-data-container"');
  if (start < 0) return null;
  const end = html.indexOf('</table>', start);
  return end < 0 ? null : html.slice(start, end);
}

function rows(table) {
  return [...table.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(
    (row) => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((cell) => cell[1])
  );
}

/** Cell markup → one string per line, because a cell holds each of its intervals in its own `<p>`. */
function lines(cell) {
  return cell
    .replace(/<br\s*\/?>|<\/(?:p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The `Підчерга` row names the columns, and every date row below follows its order.
 *
 * A row that is present but not fully named means the layout moved; positions can no longer be
 * trusted, and mapping hours onto the wrong queue is the one failure worth going dark over.
 */
function queueLabels(table) {
  for (const cells of rows(table)) {
    const texts = cells.map((cell) => lines(cell).join(' '));
    if (!texts[0]?.includes('Підчерга')) continue;
    const labels = texts.slice(1);
    return labels.length > 0 && labels.every(Boolean) ? labels : null;
  }
  return null;
}

/** `dd.mm.yyyy` → that day's Europe/Kyiv midnight. Noon UTC lands on the same date at either offset. */
function dayEpoch(text) {
  const match = /(\d{2})\.(\d{2})\.(\d{4})/.exec(text);
  if (!match) return null;
  const [, day, month, year] = match;
  return kyivDayStart(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12)));
}

/**
 * A cell's intervals → 48 half-hour slots, or null when the cell announces nothing yet.
 *
 * Boundaries round outward, so an interval that starts or ends mid-slot darkens the whole slot:
 * the app must never promise light inside a declared outage. That rule also handles the operator's
 * habit of writing the end of the day as `23:59`, which rounds up to the 48th slot.
 */
function slotsFromCell(cellLines) {
  const slots = Array(48).fill('on');
  let announced = false;

  for (const line of cellLines) {
    for (const [, h1, m1, h2, m2] of line.matchAll(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/g)) {
      const from = Math.max(0, Math.floor((Number(h1) * 60 + Number(m1)) / 30));
      const to = Math.min(48, Math.ceil((Number(h2) * 60 + Number(m2)) / 30));
      for (let slot = from; slot < to; slot++) slots[slot] = 'off';
      announced = true;
    }
  }

  return announced ? slots : null;
}

function hoursFromSlots(slots) {
  const hours = {};
  for (let hour = 1; hour <= 24; hour++) {
    hours[String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
  }
  return hours;
}

function publishedDays(table, queueKeys) {
  const fact = {};

  for (const cells of rows(table)) {
    // Header rows either span the whole table or carry no date, so a dated multi-column row is
    // exactly a published day.
    const epoch = cells.length > 1 ? dayEpoch(lines(cells[0]).join(' ')) : null;
    if (!epoch) continue;

    const day = {};
    cells.slice(1).forEach((cell, index) => {
      const slots = slotsFromCell(lines(cell));
      if (slots && queueKeys[index]) day[queueKeys[index]] = hoursFromSlots(slots);
    });

    // `Очікується` across the row means tomorrow already has a row but nothing is decided yet.
    // Publishing it as a day of light would be a promise the operator has not made.
    if (Object.keys(day).length > 0) fact[epoch] = day;
  }

  return fact;
}

/** Split out from `fetchRegion` so the parser can be exercised against captured pages offline. */
export function parsePage(html, region) {
  const table = scheduleTable(html);
  const labels = table ? queueLabels(table) : null;
  // Falling back to the national scheme keeps the region listed with its real queue names when the
  // table is unreadable — the queues are fixed, only the hours are in doubt, and a region with no
  // queues at all fails validation and is published as degraded.
  const queues = queueNames(labels ?? NATIONAL_QUEUES);
  const updated = /Оновлено:\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/.exec(html);

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues,
    fact: labels ? publishedDays(table, Object.keys(queues)) : {},
    todayEpoch: kyivDayStart(),
    update: updated ? updated[1] : null,
    source: 'rivne'
  });
}

export async function fetchRegion(region) {
  return parsePage(await getText(PAGE), region);
}
