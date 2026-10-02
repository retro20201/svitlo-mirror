import { request } from '../lib/http.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * АТ «Вінницяобленерго» — the operator's own address search at disconnection.voe.com.ua.
 *
 * There is no table of all черги anywhere: the site answers one house at a time, with that house's
 * hours for today (and tomorrow, once published) and, in season, its черга. So the mirror asks for
 * one house per підчерга, picked from the operator's own list of which streets belong to which
 * черга (gpv-2026-2027-na-sayt.pdf) as a house that list gives to that підчерга and no other.
 *
 * What the site returns is what its own page draws (assets/js/app.js, assets/css/style.css):
 * `tables[].rows[]` are days labelled "Пт 02.10"; each has 24 hour cells; each cell holds
 * `segments` `{type, start, size}` with `start`/`size` in percent of the hour, `type` one of
 * `confirm_0` (light, transparent), `confirm_2` «Заплановано», `confirm_3` «Застосовано»,
 * `confirm_4` «Завершено» — the last three all an outage, planned, under way, or over.
 *
 * Out of season every house answers «Активних відключень не знайдено», `empty`, with no черга —
 * checked 2026-10-02 from the Kyiv server. In-season answers have not been seen yet, so this reads
 * them fail-closed: a house's hours are published under a підчерга only when the answer itself
 * names that підчерга; a house the answer puts in another черга, or several addresses, or an
 * unfamiliar shape, publishes nothing for that підчерга rather than something wrong.
 *
 * The site answers only Ukrainian addresses (Cloudflare refuses others), so this runs from the
 * Kyiv server.
 */
const BASE = 'https://disconnection.voe.com.ua';
const CITY = { id: '510100000', label: 'м.Вінниця (Вінницька Область/М.Вінниця)' };
const SPACING_MS = 2000;

/**
 * Houses per підчерга, best first. Each is one the operator's list (gpv-2026-2027-na-sayt.pdf, the
 * «СО ВМЕМ» part — the city) gives to that підчерга and to no other, checked against the whole
 * document twice, independently. 4.2 lists only whole streets, so its house is on a street no
 * other підчерга mentions. Ids are the site's own (`api/autocomplete.php?type=street|house`,
 * resolved 2026-10-02). A later house is asked only when the site says an earlier one belongs to
 * a different черга.
 */
const house = (streetId, street, houseId, number) => ({ streetId, street, houseId, house: number });
export const HOUSES = {
  '1.1': [house('1763', 'вулиця Ш Алейхема', '26284', '5')],
  '1.2': [house('1422', 'вулиця М.Заньковецької', '33197', '10'), house('1134', 'вулиця Бортняка', '50888', '4')],
  '2.1': [house('1281', 'вулиця Заболотного', '32311', '10')],
  '2.2': [house('863', 'провулок 1-й Київський', '47417', '12')],
  '3.1': [house('1753', 'вулиця Чернігівська', '41583', '12'), house('1403', 'вулиця Липовецька', '42000', '15')],
  '3.2': [house('1431', 'вулиця Праведників світу', '31155', '9')],
  '4.1': [house('1350', 'вулиця Комітетська', '37970', '10')],
  '4.2': [house('1517', 'вулиця Івана Пулюя', '45203', '3')],
  '5.1': [house('1116', 'вулиця Богдана Хмельницького', '40403', '2')],
  '5.2': [house('1383', 'вулиця Лялі Ратушної', '31963', '20')],
  '6.1': [house('27306', 'вулиця Генерала Гандзюка', '674459', '17')],
  '6.2': [house('1090', 'вулиця 600-Річчя', '640796', '16'), house('1090', 'вулиця 600-Річчя', '48390', '42')]
};

const OUTAGE = new Set(['confirm_2', 'confirm_3', 'confirm_4']);
const LIGHT = new Set(['confirm_0']);
const RANK = { on: 0, possible: 1, off: 2 };
const HEADER = ['Часові проміжки', ...Array.from({ length: 24 }, (_, h) =>
  `${String(h).padStart(2, '0')}-${String(h + 1).padStart(2, '0')}`)];

/** "Пт 02.10" → Kyiv-midnight epoch, the year being whichever puts the date nearest `now`. */
export function dayOfLabel(label, now = new Date()) {
  const match = /(\d{2})\.(\d{2})\s*$/.exec(String(label ?? ''));
  if (!match) return null;
  const [day, month] = [Number(match[1]), Number(match[2])];
  const year = now.getUTCFullYear();
  const candidates = [year - 1, year, year + 1].map((y) => Date.UTC(y, month - 1, day, 12));
  const nearest = candidates.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
  const date = new Date(nearest);
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return null;
  return kyivDayStart(date);
}

/** One hour cell → its two half-hours. A segment counts for a half it covers by more than 1 %. */
function halvesOfCell(cell, warn) {
  const halves = ['on', 'on'];
  for (const segment of cell?.segments ?? []) {
    const start = Number(segment?.start);
    const size = Number(segment?.size);
    if (!Number.isFinite(start) || !Number.isFinite(size) || start < 0 || size <= 0 || start + size > 100.5) {
      throw new Error(`segment out of the hour: ${JSON.stringify(segment)}`);
    }
    let state;
    if (OUTAGE.has(segment.type)) state = 'off';
    else if (LIGHT.has(segment.type)) continue;
    else {
      // A kind the page did not draw on 2026-10-02 (their stylesheet has a commented-out
      // `confirm_1`). Not knowing what it means, say "maybe" rather than "light".
      warn(`unknown segment type ${segment.type}`);
      state = 'possible';
    }
    [[0, 50], [50, 100]].forEach(([from, to], half) => {
      const overlap = Math.min(to, start + size) - Math.max(from, start);
      if (overlap > 1 && RANK[state] > RANK[halves[half]]) halves[half] = state;
    });
  }
  return halves;
}

/**
 * One search answer → `{ days: {epoch: 48 half-hours} }` for the expected підчерга, or
 * `{ skip: reason }` when the answer does not vouch for it. Throws on a shape it does not know,
 * which fails the region and keeps the last good copy.
 */
export function parseAnswer(answer, expectedQueue, now = new Date(), warn = () => {}) {
  if (!answer || answer.ok !== true) throw new Error(`search refused: ${answer?.message ?? 'no answer'}`);
  if (answer.addresses && Object.keys(answer.addresses).length > 1) return { skip: 'several addresses' };
  const tables = answer.tables ?? [];
  if (!Array.isArray(tables)) throw new Error('tables is not a list');
  if (tables.length === 0) return { skip: 'no table' };
  if (tables.length > 1) return { skip: `${tables.length} tables` };
  const table = tables[0];
  if (table.empty) return { skip: 'no outages listed' };
  const listed = table.listnum === null || table.listnum === undefined ? null : String(table.listnum).trim();
  if (listed !== expectedQueue) return { skip: `the site puts this house in черга ${listed}` };
  if (JSON.stringify(table.header) !== JSON.stringify(HEADER)) throw new Error('unfamiliar table header');

  const today = kyivDayStart(now);
  const days = {};
  for (const row of table.rows ?? []) {
    const epoch = dayOfLabel(row?.label, now);
    if (epoch === null) throw new Error(`unfamiliar day label ${row?.label}`);
    if (!Array.isArray(row.cells) || row.cells.length !== 24) throw new Error(`${row.label}: ${row.cells?.length} hours`);
    if (epoch < today) continue;
    days[epoch] = row.cells.flatMap((cell) => halvesOfCell(cell, warn));
  }
  return { days };
}

function cookieHeader(response) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchRegion(region, now = new Date()) {
  // The form carries a CSRF token tied to the session cookie the page sets.
  const session = await request(`${BASE}/`, {
    read: async (response) => ({ html: await response.text(), cookie: cookieHeader(response) })
  });
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(session.html)?.[1];
  if (!csrf) throw new Error('no csrf token on the search page');

  const ask = async (home) => {
    await pause(SPACING_MS);
    const form = new FormData();
    for (const [key, value] of Object.entries({
      csrf, selected_eic: '', website: '', type: 'address', value: home.houseId,
      city_id: CITY.id, city_label: CITY.label,
      street_id: home.streetId, street_label: home.street,
      house_id: home.houseId, house_label: home.house
    })) form.set(key, value);
    return request(`${BASE}/api/search.php`, {
      method: 'POST',
      body: form,
      headers: { 'x-requested-with': 'XMLHttpRequest', referer: `${BASE}/`, cookie: session.cookie },
      read: (response) => response.json()
    });
  };

  const halvesByDay = {};
  for (const [queue, homes] of Object.entries(HOUSES)) {
    let parsed;
    for (const home of homes) {
      parsed = parseAnswer(await ask(home), queue, now, (message) => console.warn(`[vinnytsia] ${queue}: ${message}`));
      // Only a house the site places elsewhere is worth a second one; "no outages" is an answer.
      if (!parsed.skip || parsed.skip === 'no outages listed') break;
      console.warn(`[vinnytsia] ${queue}: ${home.street} ${home.house} — ${parsed.skip}`);
    }
    if (parsed.skip) {
      if (parsed.skip !== 'no outages listed') console.warn(`[vinnytsia] ${queue}: not published`);
      continue;
    }
    for (const [epoch, halves] of Object.entries(parsed.days)) {
      (halvesByDay[epoch] ??= {})[`GPV${queue}`] = halves;
    }
  }

  const fact = {};
  for (const [epoch, queues] of Object.entries(halvesByDay)) {
    if (!Object.values(queues).some((halves) => halves.some((state) => state !== 'on'))) continue;
    fact[epoch] = {};
    for (const [key, halves] of Object.entries(queues)) {
      fact[epoch][key] = {};
      for (let hour = 1; hour <= 24; hour++) {
        fact[epoch][key][String(hour)] = hourStateFromHalves(halves[(hour - 1) * 2], halves[(hour - 1) * 2 + 1]);
      }
    }
  }

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: queueNames(NATIONAL_QUEUES),
    fact,
    todayEpoch: kyivDayStart(now),
    update: null,
    source: 'vinnytsia'
  });
}
