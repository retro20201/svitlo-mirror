import { postForm } from '../lib/http.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * АТ «Полтаваобленерго» — the day's ГПВ grid, as their own page asks for it.
 *
 * The «Графік погодинних відключень» widget on poe.pl.ua POSTs `seldate={"date_in":"DD-MM-YYYY"}`
 * to `/customs/newgpv-info.php` and drops the HTML fragment it gets back into the page. That
 * fragment is the schedule: twelve rows (підчерги 1.1–6.2) × 48 half-hours, each cell a class —
 * `light_1` on, `light_2` off, `light_3` "час, необхідний для перемикань, електроенергії може не
 * бути". Their Telegram channel only ever carries the number of queues in force, which is why the
 * region was once recorded as having no table at all.
 *
 * The fragment for a day is empty until the operator publishes it (the evening before, around
 * 20:45), and a quiet day comes back as one sentence: "застосування графіка … не прогнозується".
 *
 * poe.pl.ua drops connections from outside Ukraine at the TCP level, so this adapter only works
 * from a Ukrainian address.
 */
const ENDPOINT = 'https://www.poe.pl.ua/customs/newgpv-info.php';
const SPACING_MS = 1000;

const STATES = { light_1: 'on', light_2: 'off', light_3: 'possible' };

const MONTHS = new Map([
  ['січня', 1], ['лютого', 2], ['березня', 3], ['квітня', 4], ['травня', 5], ['червня', 6],
  ['липня', 7], ['серпня', 8], ['вересня', 9], ['жовтня', 10], ['листопада', 11], ['грудня', 12]
]);

/** `DD-MM-YYYY` in Kyiv for `offset` days after `now` — the only date format the endpoint takes. */
export function kyivDate(now, offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(now.getTime() + offset * 86400000));
  const [year, month, day] = parts.split('-');
  return `${day}-${month}-${year}`;
}

/**
 * One day's fragment → `{ halves, update }`, `{ quiet: true, update }`, or `null` when nothing is
 * published yet. Anything else throws: a fragment this parser does not recognise is a changed
 * page, and a guessed schedule is worse than a region marked as broken.
 */
export function parseFragment(html, date) {
  const text = html.trim();
  if (!text) return null;

  const named = text.match(/<b[^>]*>\s*(\d{1,2})\s+([\p{L}]+)\s+(\d{4})\s+року\s*<\/b>/u);
  if (!named) throw new Error(`no date in the fragment for ${date}`);
  const [day, month, year] = date.split('-').map(Number);
  if (+named[1] !== day || MONTHS.get(named[2].toLowerCase()) !== month || +named[3] !== year) {
    throw new Error(`fragment for ${date} is dated ${named[1]} ${named[2]} ${named[3]}`);
  }

  // The operator's own stamp under the fragment, "16 листопада 2025 19:34".
  const update = [...text.matchAll(/<div style="text-align: end;[^"]*">([^<]+)<\/div>/g)].at(-1)?.[1].trim() ?? null;

  const table = text.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  if (!table) {
    if (/не\s+прогнозується/.test(text)) return { quiet: true, update };
    throw new Error(`unrecognised fragment for ${date}`);
  }

  const halves = {};
  let queue = null;
  for (const row of table[1].split(/<tr[^>]*>/).slice(1)) {
    const cells = [...row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
    const slots = cells.filter(([, attrs]) => /class="light_/.test(attrs));
    const labels = cells
      .filter(([, attrs]) => !/class="light_/.test(attrs))
      .map(([, , content]) => content.replace(/<[^>]+>|&nbsp;?/g, '').trim())
      .filter(Boolean);

    queue = labels.find((label) => /^\d\s*черга$/.test(label))?.[0] ?? queue;
    const sub = labels.at(-1);
    if (!queue || !/^[12]$/.test(sub ?? '') || slots.length !== 48) {
      throw new Error(`malformed row in the ${date} table: ${labels.join(' / ')} (${slots.length} cells)`);
    }
    halves[`GPV${queue}.${sub}`] = slots.map(([, attrs]) => {
      const state = STATES[attrs.match(/class="(light_\w+)"/)[1]];
      if (!state) throw new Error(`unknown cell state ${attrs} in the ${date} table`);
      return state;
    });
  }

  const expected = NATIONAL_QUEUES.map((label) => `GPV${label}`);
  if (Object.keys(halves).sort().join() !== expected.join()) {
    throw new Error(`the ${date} table names ${Object.keys(halves).join(', ')}`);
  }
  return { halves, update };
}

/** Half-hours → canonical hours, or nothing for a grid with no outage anywhere in it. */
export function hoursFromHalves(halves) {
  if (!Object.values(halves).some((slots) => slots.some((state) => state !== 'on'))) return null;
  const queues = {};
  for (const [key, slots] of Object.entries(halves)) {
    queues[key] = {};
    for (let hour = 1; hour <= 24; hour++) {
      queues[key][String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
    }
  }
  return queues;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchRegion(region, now = new Date()) {
  const fact = {};
  let update = null;
  for (const offset of [0, 1]) {
    if (offset) await pause(SPACING_MS);
    const date = kyivDate(now, offset);
    const parsed = parseFragment(await postForm(ENDPOINT, { seldate: JSON.stringify({ date_in: date }) }), date);
    if (!parsed) continue;
    update = parsed.update ?? update;
    const hours = parsed.halves && hoursFromHalves(parsed.halves);
    if (!hours) continue;
    const [day, month, year] = date.split('-').map(Number);
    fact[kyivDayStart(new Date(Date.UTC(year, month - 1, day, 12)))] = hours;
  }

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: queueNames(NATIONAL_QUEUES),
    fact,
    todayEpoch: kyivDayStart(now),
    update,
    source: 'poltava'
  });
}
