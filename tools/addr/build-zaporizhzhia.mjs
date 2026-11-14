/**
 * Address → черга for the city of Запоріжжя, from the operator's own lookup.
 *
 * АТ «Запоріжжяобленерго» answers «Дізнатися свою чергу по м. Запоріжжя» on a page of its own — a Google Apps Script
 * linked from www.zoe.com.ua/outage/ (seen there 14 November 2026). The page asks its script for the whole table once
 * (`getData`) and searches it in the browser: 13 thousand rows `[street, house, ГПВ підчерга, hours it is not switched
 * off in, ГАВ number]`. One request reads all the operator publishes; nothing is asked house by house.
 *
 * The city only. The district's sheets say «Відключення відсутні», and the rest of the oblast has no list.
 *
 * What a row means, by the page's own code:
 * - the «house» is what a person picks from a list, and it is often a group: «22|24», «1–5», «46-54|58-64»,
 *   «165-247 непарні», «114 п.4-6» (entrances), «12 (9 пов)». A range runs along one side of the street — of 4167
 *   ranges 4151 begin and end on the same parity, read that way 206 clashes between overlapping ranges of
 *   different черги fall to 27, and where the operator means every number it says «1-10 поспіль» — so «1–5» is
 *   1, 3, 5, and only «поспіль» or a range whose ends differ in parity is every number;
 * - an empty черга is «Не вимикається». Such a row gives no черга: a house that has only such rows is not in the
 *   dictionary (the app says it could not find it, which is true of a schedule), and a house that has both is given
 *   the черга it does have;
 * - the hours column («пн-пт 8-15») is when that line is not switched off; it does not change the черга;
 * - a house under two черги, by its own rows or by a range that covers it, is a house on two lines: both are kept
 *   (`x/`), as everywhere else.
 *
 * A piece of a house cell that is none of these shapes is left out, never guessed.
 *
 * The call is the page's own and not a documented API, and the operator has replaced the script before (the old address
 * then answers 404): when it stops answering, take the new link from www.zoe.com.ua/outage/ (a Ukrainian address only)
 * and put it in `SCRIPT`.
 *
 * Run: `node tools/addr/build-zaporizhzhia.mjs [--out <dir>] [--from <saved answer of the call>] [--allow-small]`,
 * then `node tools/addr/write-index.mjs`.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRegion, assignHouse, MAX_LINES } from './build-khmelnytskyi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'firebase', 'public', 'v1', 'addr', 'zaporizhzhia');
export const SCRIPT = 'https://script.google.com/macros/s/AKfycbwFgBo9W8JL_7FqghJ1hDiE-Fyxzs4GZJAq2xhTseOiv5ZnkusMKj0_g9R0DJKko19r';
export const CITY = 'Запоріжжя';
/** The table had 1.3 thousand streets and nine thousand houses with a черга in November 2026: far fewer is a changed page. */
const MIN_STREETS = 800;
const MIN_HOUSES = 6000;
/** A range longer than this is a slip of the pen, not a side of a street («2-1800»). */
const MAX_RANGE = 400;

/** The answer of the page's `getData` call — `)]}'`, then `[["op.exec",[0,"<the table as a JSON string>"]], …]` — as rows. */
export function rowsOf(answer) {
  const text = String(answer ?? '').replace(/^\)\]\}'\s*/u, '');
  const outer = JSON.parse(text);
  const exec = Array.isArray(outer) ? outer.find((part) => Array.isArray(part) && part[0] === 'op.exec') : null;
  const table = typeof exec?.[1]?.[1] === 'string' ? JSON.parse(exec[1][1]) : null;
  if (!Array.isArray(table) || !table.every((row) => Array.isArray(row) && row.length >= 3)) throw new Error('not the lookup table');
  return table.map((row) => row.slice(0, 5).map((cell) => String(cell ?? '').trim()));
}

const STREET = /^(?:вул\.|пров\.|пр\.|просп\.|бул\.|пл\.|площа|майдан|шосе|проїзд|узвіз|наб\.|о\.)\s*\S/iu;

/** A street as the dictionary names it, or null for a first cell that is not a street («Балабіне», «Квартал №2»). */
export function streetTitle(cell) {
  const name = String(cell ?? '').replace(/[`´'ʼ‘]/gu, '’').replace(/\s+/gu, ' ').trim()
    .replace(/^(вул\.|пров\.|пр\.|просп\.|бул\.|пл\.|наб\.|о\.)(?=\S)/iu, '$1 ');
  return STREET.test(name) ? name : null;
}

/** «3.1» → `GPV3.1`; anything else — the empty «Не вимикається» above all — is no черга. */
export function queueKey(label) {
  return /^[1-6]\.[12]$/u.test(label) ? `GPV${label}` : null;
}

const NUMBER = '\\d+(?:\\s?[А-ЩЬЮЯЄІЇҐа-щьюяєіїґA-Za-z])?';
const SINGLE = new RegExp(`^(\\d+)(?:\\s?([А-ЩЬЮЯЄІЇҐа-щьюяєіїґA-Za-z]))?(?:\\s?/\\s?(\\d+|[А-ЩЬЮЯЄІЇҐа-щьюяєіїґA-Za-z]))?$`, 'u');
const RANGE = new RegExp(`^(${NUMBER})\\s?[–—-]\\s?(${NUMBER})$`, 'u');
const numberOf = (house) => Number(house.match(/^\d+/u)[0]);
const tidyHouse = (house) => house.replace(/\s+/gu, '').replace(/[a-zа-щьюяєіїґ]/gu, (letter) => letter.toUpperCase());

/**
 * The buildings a house cell names. `left`: pieces that are no shape this reads, for the report.
 *
 * @returns {{ houses: string[], left: string[] }}
 */
export function buildings(cell) {
  const houses = [];
  const left = [];
  const add = (house) => { if (!houses.includes(house)) houses.push(house); };
  // «(9 пов)», «(будинок№8)», «(під'їзд 1, 2)» say which part of the building, and go first: they hold commas of their own.
  const text = String(cell ?? '').replace(/\([^)]*(?:\)|$)/gu, ' ').replace(/\\/gu, '/').replace(/\s+/gu, ' ').trim();
  // «165-247 непарні», «1-10 поспіль»: the word is about the whole cell.
  const said = /поспіль/iu.test(text) ? 'all' : /непарн/iu.test(text) ? 1 : /парн/iu.test(text) ? 0 : null;
  let last = null;
  for (const raw of text.split(/[|,;]/u)) {
    const piece = raw
      .replace(/\s*п(?:ід)?\.?\s*№?\s*\d+(?:\s?[–—-]\s?\d+)?\s*$/iu, '') // «п.1–2», «п. №1-3», «під.4-7»: entrances of one building
      .replace(/\s*(?:(?:не)?парні?|поспіль)\s*$/iu, '')
      .replace(/^(\d+)\s?-\s?([А-ЩЬЮЯЄІЇҐа-щьюяєіїґ])$/u, '$1$2')        // «123-А»
      .replace(/\s+/gu, ' ').trim();
    if (!piece) continue;
    // «21а|б|в»: the letters of the number before them.
    if (last !== null && /^[А-ЩЬЮЯЄІЇҐа-щьюяєіїґ]$/u.test(piece)) { add(tidyHouse(`${last}${piece}`)); continue; }
    const range = piece.match(RANGE);
    if (range) {
      const from = numberOf(range[1]);
      const to = numberOf(range[2]);
      last = null;
      // «26-1» is a building's own number, not houses 26 down to 1.
      if (to <= from) { add(tidyHouse(piece)); continue; }
      if (to - from > MAX_RANGE) { left.push(raw.trim()); continue; }
      const sameSide = (to - from) % 2 === 0;
      const parity = said === 'all' ? null : said ?? (sameSide ? from % 2 : null);
      // An end written with a letter is that building; the plain number beside it is not promised.
      const lettered = (end) => /\D/u.test(end);
      if (lettered(range[1])) add(tidyHouse(range[1]));
      for (let n = from; n <= to; n++) {
        if (parity !== null && n % 2 !== parity) continue;
        if ((n === from && lettered(range[1])) || (n === to && lettered(range[2]))) continue;
        add(String(n));
      }
      if (lettered(range[2])) add(tidyHouse(range[2]));
      continue;
    }
    if (SINGLE.test(piece)) { add(tidyHouse(piece)); last = numberOf(piece); continue; }
    last = null;
    left.push(raw.trim());
  }
  return { houses, left };
}

/**
 * The table → `settlement → street → { house: [queueKey, …] }`, and what was left out and why.
 */
export function buildRegion(rows) {
  const streets = new Map();
  const dropped = { notStreet: 0, notSwitchedOff: 0, unread: 0 };
  const left = [];
  for (const [streetCell, houseCell, label] of rows) {
    const street = streetTitle(streetCell);
    if (!street) { dropped.notStreet++; continue; }
    const key = queueKey(label);
    if (!key) { dropped.notSwitchedOff++; continue; }
    const read = buildings(houseCell);
    if (read.left.length) { dropped.unread += read.left.length; left.push(...read.left.map((piece) => `${street}: ${piece}`)); }
    if (!read.houses.length) continue;
    const map = streets.get(street) ?? {};
    streets.set(street, map);
    for (const house of read.houses) assignHouse(map, house, key);
  }
  return { merged: new Map([[CITY, streets]]), dropped, left };
}

/** The page's own call for its table. */
async function fetchTable() {
  const response = await fetch(`${SCRIPT}/callback?nocache_id=1&token=`, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; svitlo-mirror)',
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-same-domain': '1',
      Origin: 'https://script.google.com',
      Referer: `${SCRIPT}/exec`
    },
    body: new URLSearchParams({ request: '["getData","[]",null,[0],null,null,1,0]' }).toString()
  });
  if (!response.ok) throw new Error(`the lookup's table: HTTP ${response.status} — the operator may have replaced the script (see the head of this file)`);
  return response.text();
}

async function main() {
  const arg = (name) => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1]; };
  const out = arg('--out') ?? OUT;
  const from = arg('--from');
  const rows = rowsOf(from ? await readFile(from, 'utf8') : await fetchTable());
  const { merged, dropped, left } = buildRegion(rows);
  const streets = merged.get(CITY);
  const found = [...streets.values()].reduce((n, houses) => n + Object.keys(houses).length, 0);
  if (!process.argv.includes('--allow-small') && (streets.size < MIN_STREETS || found < MIN_HOUSES)) {
    throw new Error(`${streets.size} вулиць, ${found} будинків — менше за ${MIN_STREETS} і ${MIN_HOUSES}: `
      + 'nothing is published (--allow-small if the operator really lists so few)');
  }
  await mkdir(out, { recursive: true });
  const stats = await writeRegion(out, merged);
  const tooMany = [...streets.values()].reduce((n, houses) => n + Object.values(houses).filter((keys) => keys.length > MAX_LINES).length, 0);
  console.log(`${rows.length} рядків → ${stats.streets} вулиць, ${stats.addresses} будинків, ${stats.multiLine} на кількох чергах; `
    + `не вимикається: ${dropped.notSwitchedOff} рядків, не вулиця: ${dropped.notStreet}, не прочитано шматків: ${dropped.unread}, понад ${MAX_LINES} черг: ${tooMany}`);
  if (left.length) console.log(`не прочитано, наприклад: ${left.slice(0, 12).join(' · ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((error) => { console.error(error.message); process.exit(1); });
}
