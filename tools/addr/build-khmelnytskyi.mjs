/**
 * Builds the address→черга dictionary for Хмельницька область from the operator's own XLSX.
 *
 * Хмельницькобленерго does have a cascading address API (`/settlements/`, `/streets/{id}`,
 * `/houses/{id}`), but it only tells you the черга through `POST /shutdown-events`, one request
 * per address. For a few hundred thousand addresses that is not a harvest, it is an attack. The
 * same mapping is published as a spreadsheet per РЕМ — a handful of files — so that is what this
 * reads. The API stays useful for spot-checking what we built, which `--verify` does.
 *
 * The files carry the date they take effect (`…_01072026.xlsx`) and are replaced when the queues
 * are redrawn, so nothing here hardcodes one: it asks the server which of the known effective
 * dates exist and takes the newest. A dictionary built against a superseded file would send
 * people to a черга that is no longer theirs.
 *
 * Coverage is whatever the operator has published. A region that is half-built is reported with
 * its real counts by write-index.mjs, and the app offers only what is there.
 */
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sheetGrid } from '../lib/xlsx.mjs';
import { NATIONAL_QUEUES } from '../mirror/lib/canonical.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'firebase', 'public', 'v1', 'addr', 'khmelnytskyi');
const BASE = 'https://hoe.com.ua/Content/Uploads/GPV6/xls/';

/** Every РЕМ of the oblast. Names that are not published simply answer 404 and are skipped. */
const REMS = [
  'Хмельницький', 'Шепетівський', 'Славутський', 'Старокостянтинівський', 'Камʼянець-Подільський',
  'Дунаєвецький', 'Красилівський', 'Городоцький', 'Ізяславський', 'Летичівський', 'Полонський',
  'Теофіпольський', 'Ярмолинецький', 'Чемеровецький', 'Новоушицький', 'Білогірський',
  'Віньковецький', 'Деражнянський', 'Волочиський', 'Старосинявський'
];

/** Effective dates the operator has used, newest first. Quarterly is their observed cadence. */
const EFFECTIVE = ['01012027', '01102026', '01072026', '01042026', '01012026'];

const fileName = (rem, date) => `Черги_на_відключення_${rem}_РЕМ_побут_${date}.xlsx`;

/** The newest published workbook for one РЕМ, or null if the operator publishes none. */
async function findWorkbook(rem) {
  for (const date of EFFECTIVE) {
    const url = BASE + encodeURIComponent(fileName(rem, date));
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (head?.status === 200) return { rem, date, url };
  }
  return null;
}

/**
 * "1.1. підчерга" → "GPV1.1".
 *
 * Anything that does not name a черга at all is rejected rather than guessed at: a row whose queue
 * cell we cannot read must not quietly inherit the previous row's queue.
 */
export function queueKey(cell) {
  const match = /(\d+)\s*\.\s*(\d+)/.exec(cell ?? '');
  return match ? `GPV${match[1]}.${match[2]}` : null;
}

/**
 * "1, 10, 2а, 16А" → ["1", "10", "2а", "16А"].
 *
 * The operator enumerates houses rather than giving ranges, so each one becomes its own key and
 * the app's exact-match pass answers it. Duplicates inside a cell are dropped; blanks are not keys.
 */
export function houseList(cell) {
  return [...new Set((cell ?? '').split(',').map((part) => part.trim()).filter(Boolean))];
}

/**
 * Records one house, or poisons it when the operator has already put it on a different черга.
 *
 * Their spreadsheet lists some streets twice — вул. Центральна in Пирогівці appears under both
 * підчерга 1.1 and 1.2, and house 4 is in both lists. Their own site cannot settle it either:
 * `/shutdown-events` reports current faults, not the черга. So there is no way to tell which of
 * the two is right, and a coin flip would be wrong for half the people who asked. The house is
 * dropped instead, the lookup says it could not find it, and they pick their черга by hand —
 * exactly what they did before this dictionary existed. No answer is recoverable; a confident
 * wrong answer is what makes someone miss the hours they have.
 */
const CONTRADICTED = null;

export function assignHouse(map, house, key, problems, where) {
  if (house in map) {
    if (map[house] === key) return;
    if (map[house] !== CONTRADICTED) {
      problems.conflicts.push(`${where}, ${house}: ${map[house]} vs ${key}`);
    }
    map[house] = CONTRADICTED;
    return;
  }
  map[house] = key;
}

/** Strips the poisoned entries once every workbook has had its say. */
export function withoutContradictions(houses) {
  return Object.fromEntries(Object.entries(houses).filter(([, key]) => key !== CONTRADICTED));
}

/** One workbook → `settlement → street → { house: queueKey }`, plus what could not be read. */
export function parseWorkbook(grid) {
  const bySettlement = new Map();
  const problems = { noQueue: 0, noHouses: 0, conflicts: [] };

  // Row 1 is the РЕМ's name and row 3 the header; data starts at row 4. The header is located
  // rather than assumed, so an inserted note row does not silently shift every column.
  let firstDataRow = 4;
  for (let row = 1; row < Math.min(grid.length, 12); row++) {
    if (grid[row]?.[1] === 'Населений пункт') { firstDataRow = row + 1; break; }
  }

  for (let row = firstDataRow; row < grid.length; row++) {
    const cells = grid[row];
    if (!cells) continue;
    const [settlement, street, houses, queue] = [cells[1], cells[2], cells[3], cells[4]];
    if (!settlement?.trim() || !street?.trim()) continue;

    const key = queueKey(queue);
    if (!key) { problems.noQueue++; continue; }
    const list = houseList(houses);
    if (!list.length) { problems.noHouses++; continue; }

    const streets = bySettlement.get(settlement.trim()) ?? new Map();
    bySettlement.set(settlement.trim(), streets);
    const map = streets.get(street.trim()) ?? {};
    streets.set(street.trim(), map);

    for (const house of list) {
      assignHouse(map, house, key, problems, `${settlement}, ${street}`);
    }
  }
  return { bySettlement, problems };
}

/**
 * Cross-checks what we built against the operator's own address API.
 *
 * The spreadsheet and the API are two different exports of one database, so they should agree on
 * which streets a settlement has and which houses a street has. If they do not, the spreadsheet
 * we parsed is stale, or the parse is wrong — either way the dictionary would send people to a
 * черга that is not theirs. A handful of settlements is enough to catch both, and keeps this to
 * about twenty requests rather than a crawl of their site.
 */
async function verify(sample = 6) {
  const ajax = { headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  const json = async (url) => (await fetch(url, ajax)).json().catch(() => null);

  const settlements = JSON.parse(await readFile(join(OUT, 'settlements.json'), 'utf8'));
  const picks = [];
  for (let i = 0; i < sample; i++) picks.push(Math.floor((i + 0.5) * settlements.length / sample));

  let checked = 0, matched = 0;
  for (const index of picks) {
    const name = settlements[index];
    const hits = await json(`https://hoe.com.ua/settlements/?term=${encodeURIComponent(name)}`);
    const hit = (hits ?? []).find((s) => s.text.includes(name));
    if (!hit) { console.log(`  ${name}: немає в API оператора`); continue; }

    const ourStreets = JSON.parse(await readFile(join(OUT, 'c', String(index), 'streets.json'), 'utf8'));
    const street = ourStreets[0];
    const theirStreets = await json(`https://hoe.com.ua/streets/${hit.id}?term=${encodeURIComponent(street.replace(/^вул\.\s*/, ''))}`);
    const theirStreet = (theirStreets ?? [])[0];
    if (!theirStreet) { console.log(`  ${name}, ${street}: вулиці немає в API`); continue; }

    const theirHouses = new Set((await json(`https://hoe.com.ua/houses/${theirStreet.id}`)) ?? []);
    const ours = Object.keys(JSON.parse(await readFile(join(OUT, 'c', String(index), 's', '0.json'), 'utf8')));
    const overlap = ours.filter((h) => theirHouses.has(h)).length;
    checked += ours.length;
    matched += overlap;
    console.log(`  ${name}, ${street}: наших ${ours.length}, у оператора ${theirHouses.size}, збіглося ${overlap}`);
  }
  console.log(`\nзбіг будинків: ${matched}/${checked}`);
}

async function main() {
  const wanted = process.argv.includes('--only')
    ? [process.argv[process.argv.indexOf('--only') + 1]]
    : REMS;

  console.log('шукаю опубліковані файли…');
  const found = [];
  for (const rem of wanted) {
    const hit = await findWorkbook(rem);
    if (hit) { console.log(`  ${rem} РЕМ — ${hit.date}`); found.push(hit); }
  }
  if (!found.length) { console.error('жодного файлу не опубліковано'); process.exit(1); }
  console.log(`знайдено ${found.length} з ${wanted.length}`);

  const merged = new Map();
  const problems = { noQueue: 0, noHouses: 0, conflicts: [] };
  const queues = new Set();

  for (const hit of found) {
    const buffer = Buffer.from(await (await fetch(hit.url)).arrayBuffer());
    const parsed = parseWorkbook(sheetGrid(buffer));
    problems.noQueue += parsed.problems.noQueue;
    problems.noHouses += parsed.problems.noHouses;
    problems.conflicts.push(...parsed.problems.conflicts);

    for (const [settlement, streets] of parsed.bySettlement) {
      const target = merged.get(settlement) ?? new Map();
      merged.set(settlement, target);
      for (const [street, houses] of streets) {
        const into = target.get(street) ?? {};
        target.set(street, into);
        // Merged one house at a time rather than with Object.assign, so that a house two РЕМ
        // files disagree about is poisoned here too instead of the later file simply winning.
        for (const [house, key] of Object.entries(houses)) {
          assignHouse(into, house, key, problems, `${settlement}, ${street}`);
        }
      }
    }
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, 'c'), { recursive: true });

  const settlements = [...merged.keys()].sort((a, b) => a.localeCompare(b, 'uk'));
  await writeFile(join(OUT, 'settlements.json'), JSON.stringify(settlements), 'utf8');

  let streetCount = 0, addressCount = 0;
  for (let i = 0; i < settlements.length; i++) {
    const streets = merged.get(settlements[i]);
    const names = [...streets.keys()].sort((a, b) => a.localeCompare(b, 'uk'));
    const dir = join(OUT, 'c', String(i));
    await mkdir(join(dir, 's'), { recursive: true });
    await writeFile(join(dir, 'streets.json'), JSON.stringify(names), 'utf8');
    for (let j = 0; j < names.length; j++) {
      const houses = withoutContradictions(streets.get(names[j]));
      await writeFile(join(dir, 's', `${j}.json`), JSON.stringify(houses), 'utf8');
      addressCount += Object.keys(houses).length;
      for (const q of Object.values(houses)) queues.add(q);
    }
    streetCount += names.length;
  }

  // The region's queue list is published by the mirror adapter, not from here — but it has to
  // name every черга this dictionary can return, or the app will find someone's підчерга and
  // then refuse to apply it. Rather than write a second copy of the list and let the two drift,
  // this checks that the operator still uses the national scheme the adapter publishes.
  const unexpected = [...queues].filter((q) => !NATIONAL_QUEUES.includes(q.replace(/^GPV/, '')));
  if (unexpected.length) {
    console.log(`\nУВАГА: черги поза національною схемою: ${unexpected.join(', ')}`);
    console.log('  sources/khmelnytskyi.mjs публікує лише 1.1–6.2 — адреси в цих чергах не застосуються');
  }

  console.log(`\nнаселених пунктів ${settlements.length} · вулиць ${streetCount} · адрес ${addressCount}`);
  console.log(`черг ${queues.size}: ${[...queues].sort().join(', ')}`);
  if (problems.noQueue) console.log(`рядків без черги пропущено: ${problems.noQueue}`);
  if (problems.noHouses) console.log(`рядків без будинків пропущено: ${problems.noHouses}`);
  if (problems.conflicts.length) {
    console.log(`суперечностей ${problems.conflicts.length}, перші:`);
    for (const c of problems.conflicts.slice(0, 5)) console.log('  ', c);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--verify')) await verify();
  else await main();
}
