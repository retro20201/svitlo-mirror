/**
 * Builds the address→черга dictionary for the subscribers of ПрАТ «ПЕЕМ «ЦЕК» from the operator's own page.
 *
 * cek.dp.ua/index.php/cpojivaham/pobutovi-spozhyvachi/viznachennya-chergy.html is a lookup form whose whole table is inlined in the page,
 * for the form's script to filter as someone types (checked 2026-11-10, robots.txt `Allow: /`):
 *
 *   const locations = {"м. Дніпро": {"пров. Енергетичний": {"1": "Черга 5.2", "2": "Черга 5.2", …}, …}, …};
 *
 * One GET of ~480 KB, nothing run, no request per street — nothing like a harvest. 14 settlements, 442 streets, 9 065 houses on
 * 10 November 2026: the operator lists only the subscribers it switches off by queue, not every house of a town.
 *
 * Output is the nested shape build-addresses.mjs writes for the ДТЕК oblasts (see build-khmelnytskyi.mjs, whose writer this uses):
 *   settlements.json, c/<c>/streets.json, c/<c>/s/<i>.json   {"1": "GPV5.2"}
 *   c/<c>/x/<i>.json   {"4": ["GPV2.1", "GPV6.1"]}   only streets where a house has several черги
 *
 * What the operator's labels come to:
 *   «Черга 5.2», «4.1»               one queue
 *   «Черга 2.1 та 6.1»               a house on two lines, as ДТЕК reports them: both, in the operator's order
 *   «Черга 2» (no sub-queue)         both sub-queues, 2.1 and 2.2: the two carry the same hours on most days and NOT on all (7 November
 *                                    2026: 2.1 and 2.2 differed), so one of them for the house would be wrong for half of them
 *   «Група 5.1 (АТ "ДТЕК ДЕМ")»      ДТЕК's, not CEK's: not in this dictionary, so the lookup says it could not find the house and the
 *                                    person picks by hand (or looks it up under «Дніпро»)
 * Anything else is counted and left out rather than guessed.
 *
 * Run it from the repo root, then `node tools/addr/write-index.mjs`:
 *   node tools/addr/build-cek.mjs            # fetch the page, write firebase/public/v1/addr/cek
 *   node tools/addr/build-cek.mjs --file p.html   # read a saved copy of the page instead
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeHouse, writeRegion } from './build-khmelnytskyi.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = join(ROOT, 'firebase', 'public', 'v1', 'addr', 'cek');
const PAGE = 'https://cek.dp.ua/index.php/cpojivaham/pobutovi-spozhyvachi/viznachennya-chergy.html';
const AGENT = 'SvitloMirror/1.0 (+https://koly-svitlo.web.app)';

/** Below this the page is not what it was: it changed, or answered something else. Nothing is written over a good dictionary. */
export const MIN_SETTLEMENTS = 8;
export const MIN_HOUSES = 4000;

/** The object the page's script holds, or an error saying the page no longer has it. */
export function parseLocations(html) {
  const found = /const\s+locations\s*=\s*(\{[\s\S]*?\})\s*;\s*\r?\n/.exec(html);
  if (!found) throw new Error('на сторінці немає const locations — ЦЕК змінив сторінку');
  let data;
  try {
    data = JSON.parse(found[1]);
  } catch (error) {
    throw new Error(`const locations не розбирається як JSON: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('const locations — не об’єкт');
  return data;
}

const SUBQUEUE = /^([1-6])\.([12])$/;
const WHOLE = /^([1-6])$/;

/**
 * «Черга 2.1 та 6.1» → ["GPV2.1", "GPV6.1"]; «Черга 2» → ["GPV2.1", "GPV2.2"]; ДТЕК's groups and anything unreadable → null.
 * The order is the operator's, and a queue named twice is one.
 */
export function keysOf(label) {
  const text = String(label ?? '').replace(/[ \s]+/g, ' ').trim();
  const body = text.replace(/^черга\s+/iu, '');
  if (!body || /дтек|група/iu.test(body)) return null;
  const keys = [];
  for (const part of body.split(/\s+та\s+/iu)) {
    const sub = SUBQUEUE.exec(part.trim());
    const whole = WHOLE.exec(part.trim());
    const found = sub ? [`GPV${sub[1]}.${sub[2]}`] : whole ? [`GPV${whole[1]}.1`, `GPV${whole[1]}.2`] : null;
    if (!found) return null;
    for (const key of found) if (!keys.includes(key)) keys.push(key);
  }
  return keys.length ? keys : null;
}

/** `locations` → `settlement → street → {house: [черга, …]}` as writeRegion takes it, and what was left out and why. */
export function merge(locations) {
  const merged = new Map();
  const problems = { conflicts: [], dtek: 0, unreadable: [], emptyStreets: 0 };
  for (const [settlement, streets] of Object.entries(locations)) {
    const name = settlement.trim();
    const byStreet = merged.get(name) ?? new Map();
    for (const [street, houses] of Object.entries(streets ?? {})) {
      const streetName = street.trim();
      if (!streetName) continue;
      const map = byStreet.get(streetName) ?? {};
      for (const [house, label] of Object.entries(houses ?? {})) {
        const number = house.trim();
        if (!number) continue;
        const keys = keysOf(label);
        if (keys) mergeHouse(map, number, keys, problems, `${name}, ${streetName}`);
        else if (/дтек/iu.test(String(label))) problems.dtek++;
        else if (problems.unreadable.length < 20) problems.unreadable.push(`${name}, ${streetName}, ${number}: «${label}»`);
      }
      if (Object.keys(map).length) byStreet.set(streetName, map);
      else problems.emptyStreets++;
    }
    if (byStreet.size) merged.set(name, byStreet);
  }
  return { merged, problems };
}

async function fetchPage() {
  const response = await fetch(PAGE, { headers: { 'user-agent': AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`cek.dp.ua: HTTP ${response.status}`);
  return response.text();
}

export function countHouses(merged) {
  let houses = 0;
  for (const streets of merged.values()) for (const map of streets.values()) houses += Object.keys(map).length;
  return houses;
}

async function main(argv) {
  const file = argv[argv.indexOf('--file') + 1];
  const html = argv.includes('--file') ? await readFile(file, 'utf8') : await fetchPage();
  const { merged, problems } = merge(parseLocations(html));
  const houses = countHouses(merged);
  if (merged.size < MIN_SETTLEMENTS || houses < MIN_HOUSES) {
    throw new Error(`на сторінці ${merged.size} населених пунктів і ${houses} будинків (мінімум ${MIN_SETTLEMENTS} і ${MIN_HOUSES}) — нічого не записано`);
  }
  const stats = await writeRegion(OUT, merged);
  console.log(`cek: ${stats.settlements} settlements, ${stats.streets} streets, ${stats.addresses} houses on one queue, ${stats.multiLine} on several`);
  console.log(`     left out: ${problems.dtek} of ДТЕК ДЕМ, ${problems.conflicts.length} in conflict, ${problems.unreadable.length} unreadable`);
  for (const line of problems.conflicts.slice(0, 5)) console.log(`     conflict: ${line}`);
  for (const line of problems.unreadable.slice(0, 5)) console.log(`     unreadable: ${line}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
