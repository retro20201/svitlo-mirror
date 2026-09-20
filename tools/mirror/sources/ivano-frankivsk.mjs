import { sheetGrid } from '../../lib/xlsx.mjs';
import { getText } from '../lib/http.mjs';
import {
  buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES
} from '../lib/canonical.mjs';

/**
 * АТ «Прикарпаттяобленерго» — the ГПВ archive on the operator's own site.
 *
 * The operator's live day-ahead table is at `/uk/shutdowns_table`, which their robots.txt
 * disallows, and their dedicated schedule site `svitlo.oe.if.ua` answers every request with a
 * Cloudflare managed challenge. Both are therefore off limits. What remains permitted, and what
 * this adapter reads, is `/uk/schedule_archives`: a per-day index of the .xlsx sheet the operator
 * publishes for each day that had outages.
 *
 * The consequence is that this region is D-1 only. The archive is the record of a day that has
 * already happened, so the app gets yesterday rather than tomorrow. Nothing here can fix that —
 * the day-ahead post lives on the operator's Telegram channel, and reading it is another
 * adapter's job.
 */
const BASE = 'https://oe.if.ua';
const LISTING = `${BASE}/uk/schedule_archives`;
const ARCHIVE = `${BASE}/uk/download_schedule_archive?filename=`;

// Kept in step with lib/http.mjs, which does not export its own. Headers are Latin-1 only, so the
// app's Ukrainian name stays out of it.
const USER_AGENT = 'svitlo-mirror/1.0 (+https://koly-svitlo.web.app; outage schedule mirror)';

/**
 * How far back to mirror: today and the day before it.
 *
 * The bound is about honesty as much as bandwidth. The archive keeps months of history, and
 * publishing whatever it happens to hold would leave a July outage sitting in `fact` all through
 * the autumn — which the mirror reads as a schedule and flags the region `live`, telling people
 * there is current data when there is none. Only days the app would actually display are mirrored,
 * so out of season `fact` is empty and the region reports itself seasonal, which is the truth.
 */
const MAX_DAYS = 2;

/** Column A is the queue label; B..AW are the 48 half-hours. */
const FIRST_SLOT_COLUMN = 2;
const SLOTS_PER_DAY = 48;

/**
 * "X" is the operator's only documented mark and means the power is off for that half hour.
 *
 * Both alphabets are accepted because the Latin X and the Cyrillic Х are the same glyph on screen
 * and these sheets are filled in by hand. Any other mark is a symbol this parser has never seen,
 * so it is reported as "можливо" rather than resolved either way — promising light that does not
 * arrive is the failure that makes people delete the app.
 */
function slotState(cell) {
  if (!cell) return 'on';
  const mark = cell.toUpperCase();
  return mark === 'X' || mark === 'Х' ? 'off' : 'possible';
}

/**
 * Column A of a queue row: "1.1" or "Черга 1.1", never the header or the legend prose.
 *
 * The operator writes the label as a *number* (`t="n"`, `<v>1.1</v>`), so the trailing digits guard
 * against the float noise a spreadsheet writer can leave behind — "1.1000000000000001" has to read
 * as queue 1.1 rather than be dropped as unrecognised.
 */
function queueLabel(cell) {
  const match = /^(?:черга\s*)?(\d)\.(\d)\d*$/i.exec(cell ?? '');
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * One day's workbook → `{ queueKey: { '1'..'24': state } }`.
 *
 * Rows are found by the shape of their label rather than by the documented row numbers 3–14, so
 * that an added queue is picked up instead of being silently dropped at row 15.
 */
export function parseDaySheet(buffer) {
  const grid = sheetGrid(buffer);

  const byQueue = {};
  for (const cells of grid) {
    if (!cells) continue;
    const label = queueLabel(cells[1]);
    if (!label) continue;

    const hours = {};
    for (let hour = 1; hour <= 24; hour++) {
      const first = FIRST_SLOT_COLUMN + (hour - 1) * 2;
      hours[String(hour)] = hourStateFromHalves(slotState(cells[first]), slotState(cells[first + 1]));
    }
    byQueue[`GPV${label}`] = hours;
  }
  return byQueue;
}

/**
 * The days one month's listing offers a workbook for, as `YYYYMMDD`.
 *
 * `?month=` silently falls back to the current month whenever the value is outside the window the
 * site retains, so the rendered dates are checked against what was asked for — without that,
 * August's rows would be mirrored as though they were December's. Days are then taken from the
 * download filenames, which carry their own date, rather than from the surrounding row markup.
 */
export function archiveDaysFromListing(html, month) {
  const rendered = /schedule-archive-row__date'>\d{2}\.(\d{2})\.(\d{4})</.exec(html);
  if (!rendered || `${rendered[2]}-${rendered[1]}` !== month) return [];
  return [...new Set(
    [...html.matchAll(/shutdowns_schedule_archive_(\d{8})\.xlsx/g)].map((match) => match[1])
  )];
}

/** The days worth mirroring, as `YYYYMMDD` → Kyiv midnight epoch, newest first. */
function recentDays() {
  const days = new Map();
  for (let back = 0; back < MAX_DAYS; back++) {
    const at = new Date(Date.now() - back * 86400000);
    const iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(at);
    days.set(iso.replaceAll('-', ''), kyivDayStart(at));
  }
  return days;
}

/**
 * A day with no published sheet answers 302 to the site root, so redirects must not be followed:
 * letting fetch chase it would yield the homepage under status 200 and a body that is not a
 * workbook. `getText` can express neither that nor a binary response, hence the direct call.
 */
async function downloadDay(day) {
  const response = await fetch(`${ARCHIVE}shutdowns_schedule_archive_${day}.xlsx`, {
    redirect: 'manual',
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'uk-UA,uk;q=0.9' }
  });
  if (response.status !== 200) return null;
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchRegion(region) {
  const wanted = recentDays();

  // Normally one listing; two only when the run straddles a month boundary and yesterday is on the
  // previous page. Deriving the months from the days keeps that to the minimum.
  const months = new Set([...wanted.keys()].map((day) => `${day.slice(0, 4)}-${day.slice(4, 6)}`));
  const published = new Set();
  for (const month of months) {
    const listing = await getText(`${LISTING}?month=${month}`);
    for (const day of archiveDaysFromListing(listing, month)) published.add(day);
  }

  const selected = [...wanted.keys()].filter((day) => published.has(day));

  const fact = {};
  for (const day of selected) {
    try {
      const workbook = await downloadDay(day);
      if (!workbook) continue;

      const byQueue = parseDaySheet(workbook);
      if (!Object.keys(byQueue).length) continue;

      fact[wanted.get(day)] = byQueue;
    } catch {
      // One unreadable workbook must not cost the other day; the check below catches the case
      // where the format has moved and none of them read.
    }
  }

  // The listing naming workbooks that none of them can be turned into hours means the sheet has
  // changed shape. Failing here keeps the last good copy and flags the region as degraded, which
  // is far better than publishing an empty day: the app would render that as "вимкнень не
  // заплановано" in the middle of a blackout, the one confusion it exists to prevent.
  if (selected.length && !Object.keys(fact).length) {
    throw new Error(`archive listed ${selected.length} day(s), none could be parsed`);
  }

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    // Published even out of season, when there is no sheet to read them from. The oblast runs
    // Укренерго's national 1.1–6.2 scheme and the daily sheet's rows never depart from it, so this
    // is a fact about the region rather than a guess about today. It also keeps the snapshot valid
    // while the archive is empty, so people can still find which queue they are on before
    // restrictions resume.
    queues: queueNames(NATIONAL_QUEUES),
    fact,
    todayEpoch: kyivDayStart(),
    // The listing carries no timestamp of its own, and inventing one would misrepresent how fresh
    // the archive is.
    update: null,
    source: 'ivano-frankivsk'
  });
}
