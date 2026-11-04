import { getText } from '../lib/http.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, validate, NATIONAL_QUEUES } from '../lib/canonical.mjs';
import { withPendingChange } from '../lib/operator-changes.mjs';
import { withChannelEmergency } from './dtek.mjs';

/**
 * АТ «Житомиробленерго» — the queue×half-hour grid rendered straight into their own page.
 *
 * The operator has two sites and only one of them is usable. The React front end at
 * ztoe-poweron.inneti.net (open API at api-ztoe-poweron.inneti.net) publishes the ГПВ as a
 * *picture* — `options?option_key=pw_gpv_image_today` is a path to a PNG — and its
 * `archive_gpv_graphs` collection is images too. The old PHP page, on the other hand, prints the
 * same table as HTML: 12 rows (підчерги 1.1–6.2) × 48 half-hour cells, each cell coloured by an
 * inline `background:` style. That is the machine-readable source, so this adapter reads the old
 * page and ignores the pretty one.
 *
 * The page is served as windows-1251, and `fetch().text()` decodes UTF-8 unconditionally, so every
 * Cyrillic byte comes back as replacement characters. Nothing here depends on them: an invalid
 * sequence never swallows a following ASCII byte, so tags, hex colours and digits survive intact,
 * and the Ukrainian labels are built locally by `queueNames`.
 */
const PAGE = 'https://www.ztoe.com.ua/unhooking-search.php';

/**
 * The page's own legend names exactly two colours: white — "електроенергія гарантована", red —
 * "відключається при доведенні НЕК «Укренерго» обмежень". Out of season every cell is white
 * (#ffffff); in season the dark ones are #ff3333. Matching only white and treating anything else
 * as an outage survives the operator changing their shade of red, and errs the way the canonical
 * format errs: a warned outage that does not happen costs a charged power bank, an unwarned one
 * costs a fridge.
 */
function halfHourState(color) {
  return color.toLowerCase() === '#ffffff' ? 'on' : 'off';
}

/** Every `<tr>` of the document, cheap enough on a 240 KB page and blind to the surrounding tables. */
function tableRows(html) {
  return html.split(/<tr[^>]*>/i).slice(1).map((row) => row.split(/<\/tr>/i)[0]);
}

/**
 * The operator's own "Дата оновлення інформації - 16:30 10.02.2026", reduced to the part that
 * survives the encoding. It is the last timestamp before the grid — the banner above it carries
 * the time Укренерго last changed the number of queues in force, which is a different fact.
 */
function updateStamp(html, gridAt) {
  const stamps = [...html.slice(0, gridAt).matchAll(/(\d{1,2}:\d{2})\s+(\d{2}\.\d{2}\.\d{4})/g)];
  const last = stamps.at(-1);
  return last ? `${last[1]} ${last[2]}` : null;
}

function epochFromDate(text) {
  const [day, month, year] = text.split('.').map(Number);
  // Midday UTC is the same calendar day in Kyiv whatever the offset; `kyivDayStart` does the rest.
  return kyivDayStart(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function parseSchedulePage(html) {
  const rows = tableRows(html);
  const gridAt = html.search(/colspan="48"/i);

  // Each header row spans the 48 half-hours of the days under it. In the evening the operator
  // prints tomorrow as a second table, with its own header and its own twelve rows of 48 cells,
  // below today's — so a queue row belongs to the header above it, not to every date on the page.
  // Counting both dates against every row once made each 48-cell row look short, and both days
  // vanished every evening of the season.
  let days = [];
  const labels = new Set();
  const halves = {};
  for (const row of rows) {
    if (/colspan="48"/i.test(row)) {
      days = [...row.matchAll(/(\d{2}\.\d{2}\.\d{4})/g)].map((match) => match[1]);
      continue;
    }
    // Only schedule cells carry a hex background; the Черга/Підчерга headers use the word `white`.
    const colors = [...row.matchAll(/background:\s*(#[0-9a-f]{6})/gi)].map((match) => match[1]);
    const label = row.match(/<b[^>]*>\s*(\d\.\d)\s*<\/b>/)?.[1];
    if (!label || !days.length || colors.length !== days.length * 48) continue;

    labels.add(label);
    days.forEach((day, index) => {
      halves[day] ??= {};
      halves[day][`GPV${label}`] = colors.slice(index * 48, (index + 1) * 48).map(halfHourState);
    });
  }

  const fact = {};
  for (const [day, byQueue] of Object.entries(halves)) {
    // Out of season the grid is still printed, all white. Publishing that as a schedule would
    // promise light the operator only guarantees "за умови відсутності аварійних відключень";
    // an absent day makes the app say "вимкнень не заплановано", which is what is actually known.
    if (!Object.values(byQueue).some((slots) => slots.includes('off'))) continue;

    const hours = {};
    for (const [queue, slots] of Object.entries(byQueue)) {
      hours[queue] = {};
      for (let hour = 1; hour <= 24; hour++) {
        hours[queue][String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
      }
    }
    fact[epochFromDate(day)] = hours;
  }

  return {
    // Житомир runs the national 1.1–6.2 scheme, so a page that renders the form but not the grid
    // still leaves the queue list known — and a snapshot without queues is published as degraded.
    queues: queueNames(labels.size ? [...labels] : NATIONAL_QUEUES),
    fact,
    update: updateStamp(html, gridAt < 0 ? html.length : gridAt)
  };
}

/**
 * The site does not answer, but the channel may: the table phones have stays as it is, and what the channel says about an
 * order of Укренерго is still said. From the evening of 3 November 2026 ztoe.com.ua timed out for more than half a day
 * while the operator had announced «знову запроваджено аварійні відключення» and a person was in the dark since 16:00;
 * with the whole adapter failing, the banner could not have come back. Offered to the mirror as `error.fallback`, which
 * publishes it marked stale. Without a copy of the table to carry, or when the copy would not pass, the error is the error.
 */
export async function withHeldEmergency(error, region, options = {}) {
  if (!region.previous || !region.emergencyTelegram) return error;
  try {
    const held = await withChannelEmergency(structuredClone(region.previous), region, {
      log: (line) => console.log(`[emergency] ${line}`), ...options
    });
    if (!validate(held).length) error.fallback = held;
  } catch {
    // The channel did not answer either: the old copy stays as the mirror keeps it.
  }
  return error;
}

export async function fetchRegion(region) {
  let html;
  try {
    html = await getText(PAGE);
  } catch (error) {
    throw await withHeldEmergency(error, region);
  }
  const { queues, fact, update } = parseSchedulePage(html);

  const snapshot = buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues,
    fact,
    todayEpoch: kyivDayStart(),
    update,
    source: 'zhytomyr'
  });
  // The operator announces changes on its channel before its table has them (lib/operator-changes.mjs), and says
  // «запроваджено аварійні відключення (ГАВ)» there when Укренерго orders them (lib/dtek-emergency.mjs, area 'own').
  const changed = region.changesTelegram ? await withPendingChange(snapshot, region) : snapshot;
  return region.emergencyTelegram
    ? withChannelEmergency(changed, region, { log: (line) => console.log(`[emergency] ${line}`) })
    : changed;
}
