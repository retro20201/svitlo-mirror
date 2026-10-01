import { getBytes, getJSON } from '../lib/http.mjs';
import { decodePng } from '../lib/png.mjs';
import { readGrids } from '../lib/grid-image.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * ПрАТ «Волиньобленерго» — the day's ГПВ picture from the operator's own «poweron» service.
 *
 * energy.volyn.ua answers only Ukrainian IPs, but its schedule page is an iframe of
 * voe-poweron.inneti.net, whose API (robots: `Allow: /`) hands out the published pictures:
 * `options?option_key=pw_gpv_image_today` / `_tomorrow` carry a path, and the operator's page
 * shows `https://api-voe-poweron.inneti.net` + that path. There is no table behind it to read —
 * the service has no `a_gpv_g` — so the picture is the schedule.
 *
 * It is a rendered PNG: twelve subqueues × 48 half-hours in two halves of the day, every cell
 * flat rgb(185,200,215) for light or rgb(68,110,155) for none, so it is read by colour
 * (`lib/grid-image.mjs`), not by OCR. The date never comes from the picture: the archive lists
 * every published file with the day it is for.
 *
 * Checked on 2026-10-01 against twelve archived in-season pictures (January–March 2026, 0 to 432
 * dark half-hours) and by eye against two of them. The today/tomorrow options point at those same
 * archived files: on 1 липня the archive entry was created at 21:08:32 and the option set at
 * 21:09:32. A picture that does not read as the grid anyway is published as the picture itself
 * (`sheets`), which the app shows when it has no hours for the day — a wrong timeline is the one
 * thing worse than a picture.
 */
const HOST = 'https://api-voe-poweron.inneti.net';
const SOURCE_PAGE = 'https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/';
const LIGHT = [185, 200, 215];
const DARK = [68, 110, 155];
const SPACING_MS = 1000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A decoded picture → half-hours per subqueue, in the operator's 1.1–6.2 row order. */
export function halvesFromPicture(bytes) {
  const image = decodePng(bytes);
  const grids = readGrids(image, { on: LIGHT, off: DARK, slots: 24, rows: 12 });
  if (grids.length !== 2) throw new Error(`expected the two halves of the day, found ${grids.length} grids`);
  const halves = {};
  NATIONAL_QUEUES.forEach((label, row) => {
    halves[`GPV${label}`] = [...grids[0][row], ...grids[1][row]];
  });
  return halves;
}

/** Hours for a day, or nothing for a grid without a single dark cell. */
export function hoursFromHalves(halves) {
  if (!Object.values(halves).some((slots) => slots.includes('off'))) return null;
  const queues = {};
  for (const [key, slots] of Object.entries(halves)) {
    queues[key] = {};
    for (let hour = 1; hour <= 24; hour++) {
      queues[key][String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
    }
  }
  return queues;
}

/**
 * The archive's entry for a published file. `dateGraph` and `dateCreate` are Kyiv wall-clock
 * times labelled `+00:00`, so their digits are read as they stand and never converted.
 */
export function archiveEntry(archive, path) {
  return (archive['hydra:member'] ?? [])
    .filter((entry) => entry.imageUrl?.contentUrl === path || entry.imageMobileUrl?.contentUrl === path)
    .sort((a, b) => String(b.dateCreate).localeCompare(String(a.dateCreate)))[0] ?? null;
}

const wallDate = (stamp) => stamp.slice(0, 10);
const wallStamp = (stamp) => `${stamp.slice(11, 16)} ${stamp.slice(8, 10)}.${stamp.slice(5, 7)}.${stamp.slice(0, 4)}`;

function dayStartOf(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return kyivDayStart(new Date(Date.UTC(year, month - 1, day, 12)));
}

export async function fetchRegion(region) {
  const paths = [];
  for (const key of ['pw_gpv_image_today', 'pw_gpv_image_tomorrow']) {
    const options = await getJSON(`${HOST}/api/options?option_key=${key}`);
    const value = options['hydra:member']?.[0]?.value ?? '';
    // The operator's page shows a picture only when the value is longer than one character.
    if (value.length > 1 && !paths.includes(value)) paths.push(value);
  }

  const fact = {};
  const sheets = [];
  let update = null;
  if (paths.length) {
    await pause(SPACING_MS);
    const archive = await getJSON(`${HOST}/api/archive_gpv_graphs?page=1`);
    for (const path of paths) {
      const entry = archiveEntry(archive, path);
      if (!entry?.dateGraph) {
        console.warn(`[volyn] ${path} is not in the archive yet; it cannot be dated, so it waits`);
        continue;
      }
      const dayStart = dayStartOf(wallDate(entry.dateGraph));
      if (!update || entry.dateCreate > update) update = entry.dateCreate;

      await pause(SPACING_MS);
      const url = `${HOST}${path}`;
      try {
        const hours = hoursFromHalves(halvesFromPicture(await getBytes(url)));
        if (hours) fact[dayStart] = hours;
      } catch (error) {
        console.warn(`[volyn] ${path} did not read as the grid (${error.message}); publishing the picture`);
        sheets.push({ dayStart, imageUrl: url, sourceUrl: SOURCE_PAGE, caption: null, isRevision: false });
      }
    }
  }

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: queueNames(NATIONAL_QUEUES),
    fact,
    todayEpoch: kyivDayStart(),
    update: update && wallStamp(update),
    sheets: sheets.sort((a, b) => a.dayStart - b.dayStart),
    source: 'volyn'
  });
}
