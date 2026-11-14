/**
 * Builds the address→черга dictionary for Житомирська область from the operator's own address lists.
 *
 * Житомиробленерго publishes, for each of its twelve підчерги, the whole list of streets and
 * buildings on it — one page per підчерга, `https://www.ztoe.com.ua/unhooking-search.php?pidcherga_id=N`,
 * N = 1…12 — as a plain HTML table: РЕМ, населений пункт, вулиця, будинки, черга, підчерга, примітка.
 * The same page has an address form that asks for one address at a time; the twelve lists hold every
 * answer that form could give, so a handful of requests is a whole dictionary and nothing here is a
 * crawl. The REST API behind their newer site (`api-ztoe-poweron.inneti.net/api/pw_address_queues`)
 * answers with an empty collection (0 items on 3 November 2026, in season), so it is not used.
 *
 * Output is the nested shape build-addresses.mjs writes for the ДТЕК oblasts:
 *   settlements.json, c/<c>/streets.json, c/<c>/s/<i>.json   {"1": "GPV1.1"}
 *   c/<c>/x/<i>.json   {"4": ["GPV1.1", "GPV1.2"]}   only streets where a house is on several підчерги
 * through the same writer as the Хмельницький dictionary, so every index stays what it was on the
 * previous run.
 *
 * Only rows for households («побутові споживачі») are read: a business at the same address is on the
 * line its contract names, which is often not the one the building's flats are on.
 *
 * Run: `node tools/addr/build-zhytomyr.mjs [--out <dir>] [--from <dir with 1.html … 12.html, as
 * served>]`, then `node tools/addr/write-index.mjs`. The page is windows-1251. ztoe.com.ua did not
 * answer at all on 3 November 2026 and answered a plain request from outside Ukraine on the 14th
 * (twelve pages, 0.4–1.5 MB each); if it times out, try from the Kyiv server.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRegion, assignHouse, houseList, MAX_LINES } from './build-khmelnytskyi.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'firebase', 'public', 'v1', 'addr', 'zhytomyr');
const PAGE = (id) => `https://www.ztoe.com.ua/unhooking-search.php?pidcherga_id=${id}`;
/** The twelve підчерги of the national scheme: 1.1 … 6.2. */
export const PIDCHERGA_IDS = Array.from({ length: 12 }, (_, i) => i + 1);
const PAUSE_MS = 4000;
/** The first live run, 14 November 2026: 1 547 settlements, 303 thousand houses. */
const MIN_SETTLEMENTS = 1000;
const MIN_HOUSES = 200_000;

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#039;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };
const text = (cell) => cell
  .replace(/<[^>]+>/g, '')
  .replace(/&(?:nbsp|amp|quot|#039|apos|lt|gt);/g, (entity) => ENTITIES[entity])
  .replace(/\s+/g, ' ')
  .trim();

/** The operator's page is windows-1251; `fetch().text()` would turn every Ukrainian letter to U+FFFD. */
export const decodePage = (bytes) => new TextDecoder('windows-1251').decode(bytes);

/**
 * One page → its address rows. A row is seven cells whose fifth and sixth are digits: the schedule
 * grid on the same page has rows of forty-eight cells, and the header row has words there.
 */
export function parseAddressPage(html) {
  const rows = [];
  const problems = { notHousehold: 0, badQueue: 0 };
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(text);
    if (cells.length !== 7 || !/^\d$/.test(cells[4]) || !/^\d$/.test(cells[5])) continue;
    const [rem, settlement, street, houses, queue, sub, note] = cells;
    if (!/^побутов/i.test(note)) { problems.notHousehold++; continue; }
    if (!rem || !settlement || !street) { problems.badQueue++; continue; }
    rows.push({ rem, settlement, street, houses, key: `GPV${queue}.${sub}` });
  }
  return { rows, problems };
}

/** «місто Баранівка», «м. Звягель», «с. Рудня», «селище Нова Борова» → the name alone. */
const TYPE = /^(?:місто|м\.|смт\.?|селище міського типу|селище|с-ще|село|с\.|с\/рада|с\/р)\s+/iu;
export const bareName = (name) => name.replace(TYPE, '').trim() || name.trim();

/**
 * One apostrophe for every spelling, and single spaces. On 14 November 2026 «с. Кам’янка» and
 * «с. Кам'янка» of one РЕМ came out as two villages, each with half the streets, and Житомир had
 * «вул. Закам'янська» twice. «’» is what the ДТЕК dictionaries carry; the app's search drops any.
 */
const tidy = (name) => name.replace(/(?<=\p{L})['ʼ‘`´](?=\p{L})/gu, '’').replace(/\s+/g, ' ').trim();

/** Left in capitals inside a name that is otherwise calmed down: «вул. ГЕРОЇВ УПА» → «вул. Героїв УПА». */
const ABBREVIATIONS = new Set(['СГТ', 'СТ', 'ОК', 'ГК', 'УПА', 'ОУН', 'УНР', 'ЗСУ', 'АТО', 'ОМБ', 'УПТК', 'ОСТМ', 'КТП']);
/** «ІІ» and «III», in either alphabet: a number, not a word. */
const ROMAN = /^[IVXІХ]+$/u;
const isShouted = (word) => word.length >= 2 && word === word.toUpperCase() && word !== word.toLowerCase();

/**
 * «вул. ВАСИЛЯ СТУСА» → «вул. Василя Стуса», «вул. 8-ГО БЕРЕЗНЯ» → «вул. 8-го Березня».
 *
 * Some РЕМ type their lists in capitals (872 street names of 14 236 and three villages on
 * 14 November 2026). The search does not mind, the list on the phone does. Only a name with a
 * capitalised word of four letters or more is touched, so «вул. Героїв УПА» and an abbreviation
 * nobody listed here stay as the operator wrote them; initials («Г.ЛОГАНІВСЬКА») keep their letter.
 */
export function calm(name) {
  const words = name.match(/[\p{L}’]+/gu) ?? [];
  if (!words.some((word) => word.length >= 4 && isShouted(word) && !ABBREVIATIONS.has(word))) return name;
  return name.replace(/(\d-)?([\p{L}’]+)/gu, (whole, ordinal, word) => {
    if (!isShouted(word) || ABBREVIATIONS.has(word) || ROMAN.test(word)) return whole;
    const lower = word.toLowerCase();
    return ordinal ? ordinal + lower : lower[0].toUpperCase() + lower.slice(1);
  });
}

/** «с/рада Оліївська станція Світин»: land of a village council outside any village — dachas, a station. */
const COUNCIL = /^с\/р(?:ада)?\.?\s+(\S+)(?:\s+(.+))?$/iu;

/**
 * The settlement cell as it is listed. A council's land is named as what it is («Оліївська
 * сільрада, станція Світин»): with the type merely dropped it read «Оліївська», a village that
 * does not exist, next to the real Оліївка.
 */
export function settlementName(cell) {
  const name = tidy(cell);
  const council = COUNCIL.exec(name);
  return calm(council ? `${council[1]} сільрада${council[2] ? `, ${council[2]}` : ''}` : name);
}

/** The street of the rows that name none: a village with no street names, a plot in a field. */
export const NO_STREET = 'Без вулиці';

/**
 * The street cell as it is listed. The operator's form puts «N/A» where the type of street was
 * not chosen («N/A Лісова», «N/A садове товариство "Джерело"») — that is dropped; and where nothing
 * else is said («N/A Не Вказано», «вул. N/A», «N/A N/A», «вул. .», «вул. не указана») the houses
 * go under one honest name instead of five spellings of "unknown".
 */
export function streetTitle(cell) {
  const name = tidy(cell).replace(/^N\/A\s+(?=\S)/iu, '');
  const bare = name.replace(/^(?:вул\.?|вулиця)\s*/iu, '');
  if (!/\p{L}{2}|\d/u.test(bare) || /^(?:не\s+в?казан\p{L}*|не\s+указан\p{L}*)$/iu.test(bare)) return NO_STREET;
  return calm(name);
}

/**
 * «1, 10, 2а» → ["1", "10", "2а"], without what is not a building: «б/н», a lone «а», a dot, a
 * trailing dash («42-»), the colon in front of a plot number («:1390»), and «0», «00», «000» — the
 * operator's way of saying "no number" (370 such on 14 November 2026). The cells carry such stray
 * pieces (`42-, . , , 25`), and a key without a digit can never be what someone types.
 */
export function buildings(cell) {
  const parts = houseList(cell)
    .map((part) => part.replace(/^[:\s.]+/u, '').replace(/[-–\s.]+$/u, '').trim())
    .filter((part) => /\d/u.test(part) && !/^0+$/u.test(part));
  return [...new Set(parts)];
}

/**
 * The names a settlement is shown under. The type words differ from row to row for the same kind of
 * place, so they are dropped; a name that two РЕМ share («Березівка») keeps its РЕМ, and one that a
 * РЕМ lists as both a town and a village keeps its original words.
 */
export function settlementTitles(pairs) {
  const rems = new Map();
  for (const { rem, settlement } of pairs) {
    const bare = bareName(settlement);
    rems.set(bare, new Set([...(rems.get(bare) ?? []), rem]));
  }
  const raw = new Map();
  for (const { rem, settlement } of pairs) {
    const bare = bareName(settlement);
    raw.set(`${rem}|${bare}`, new Set([...(raw.get(`${rem}|${bare}`) ?? []), settlement.trim()]));
  }
  const title = ({ rem, settlement }) => {
    const bare = bareName(settlement);
    const sameRem = raw.get(`${rem}|${bare}`);
    const base = sameRem.size > 1 ? settlement.trim() : bare;
    return rems.get(bare).size > 1 ? `${base} (${rem} РЕМ)` : base;
  };
  return title;
}

/** Rows of all pages → `settlement title → street → { house: [queueKey, …] }`, and what was left out. */
export function buildRegion(pages) {
  const rows = pages.flatMap((page) => page.rows)
    .map((row) => ({ ...row, settlement: settlementName(row.settlement), street: streetTitle(row.street) }));
  const titleOf = settlementTitles(rows);
  const merged = new Map();
  const dropped = { noHouses: 0 };
  for (const row of rows) {
    const list = buildings(row.houses);
    if (!list.length) { dropped.noHouses++; continue; }
    const name = titleOf(row);
    const streets = merged.get(name) ?? new Map();
    merged.set(name, streets);
    const map = streets.get(row.street) ?? {};
    streets.set(row.street, map);
    for (const house of list) assignHouse(map, house, row.key);
  }
  return { merged, dropped };
}

async function fetchPage(id) {
  const response = await fetch(PAGE(id), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; svitlo-mirror)' } });
  if (!response.ok) throw new Error(`підчерга ${id}: HTTP ${response.status}`);
  return decodePage(new Uint8Array(await response.arrayBuffer()));
}

async function main() {
  const arg = (name) => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1]; };
  const out = arg('--out') ?? OUT;
  const from = arg('--from');
  const pages = [];
  for (const id of PIDCHERGA_IDS) {
    const html = from ? decodePage(await readFile(join(from, `${id}.html`))) : await fetchPage(id);
    const page = parseAddressPage(html);
    console.log(`підчерга ${id}: ${page.rows.length} рядків (${page.problems.notHousehold} непобутових пропущено)`);
    if (!page.rows.length) throw new Error(`підчерга ${id}: no address rows — the page changed, nothing is published`);
    pages.push(page);
    if (!from && id !== PIDCHERGA_IDS.at(-1)) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }
  const { merged, dropped } = buildRegion(pages);
  // Twelve pages that still have rows but far fewer of them are a changed page, not a smaller oblast:
  // written over the published dictionary they would leave most villages without their streets.
  const found = [...merged.values()].flatMap((streets) => [...streets.values()])
    .reduce((n, houses) => n + Object.keys(houses).length, 0);
  if (!process.argv.includes('--allow-small') && (merged.size < MIN_SETTLEMENTS || found < MIN_HOUSES)) {
    throw new Error(`${merged.size} населених пунктів, ${found} будинків — менше за ${MIN_SETTLEMENTS} і ${MIN_HOUSES}: `
      + 'nothing is published (--allow-small if the operator really lists so few)');
  }
  await mkdir(out, { recursive: true });
  const stats = await writeRegion(out, merged);
  const tooMany = [...merged.values()].flatMap((streets) => [...streets.values()])
    .reduce((n, houses) => n + Object.values(houses).filter((keys) => keys.length > MAX_LINES).length, 0);
  console.log(`${merged.size} населених пунктів, ${stats.streets} вулиць, ${stats.addresses} будинків, `
    + `${stats.multiLine} на кількох чергах; без будинків: ${dropped.noHouses}, понад ${MAX_LINES} черг: ${tooMany}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((error) => { console.error(error.message); process.exit(1); });
}
