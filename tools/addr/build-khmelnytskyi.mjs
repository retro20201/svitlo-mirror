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
 * Output is the nested shape build-addresses.mjs writes for the ДТЕК oblasts:
 *   settlements.json, c/<c>/streets.json, c/<c>/s/<i>.json   {"1": "GPV1.1"}
 *   c/<c>/x/<i>.json   {"4": ["GPV1.1", "GPV1.2"]}   only streets where a house has several черги
 * A house on several черги is published in `x/` alone (see splitLines), and every index stays
 * what it was on the previous run (see stableList).
 *
 * Coverage is whatever the operator has published. A region that is half-built is reported with
 * its real counts by write-index.mjs, and the app offers only what is there.
 */
import { mkdir, mkdtemp, writeFile, rm, readFile, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
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

/**
 * The newest published workbook for one РЕМ, or null if the operator publishes none.
 *
 * Only a 404 means "no file for this date". A timeout or a 5xx stops the run instead: falling
 * through to the next date would quietly build from the quarter the new file replaced.
 */
async function findWorkbook(rem) {
  for (const date of EFFECTIVE) {
    const url = BASE + encodeURIComponent(fileName(rem, date));
    const head = await fetch(url, { method: 'HEAD' }).catch((err) => {
      throw new Error(`${rem} РЕМ, ${date}: ${err.cause?.code ?? err.message} — hoe.com.ua недоступний`);
    });
    if (head.status === 200) return { rem, date, url };
    if (head.status !== 404) throw new Error(`${rem} РЕМ, ${date}: HTTP ${head.status}`);
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
 * Records one house's черга next to any other the same workbook has already given it.
 *
 * Their spreadsheet lists some streets twice — вул. Центральна in Пирогівці appears under both
 * підчерга 1.1 and 1.2, and house 4 is in both lists. That is not a slip to be settled one way:
 * a building fed by two lines has two черги. ДТЕК's own API returns a list per house, Yasno's FAQ
 * says one address can show two schedules, and which line feeds a given flat is known to the
 * ОСББ or the керуюча компанія, not to us. So every черга is kept, in the order the operator first
 * lists it; the same черга twice is still one.
 */
export function assignHouse(map, house, key) {
  const keys = (map[house] ??= []);
  if (!keys.includes(key)) keys.push(key);
}

/**
 * Takes one РЕМ file's черги for a house into what earlier files said about it.
 *
 * Several черги in one file is the operator describing one building. Two files disagreeing is
 * not: each РЕМ is a district, a village name often recurs in the next district, and the likelier
 * reading is two different houses that merely share settlement, street and number. Publishing that
 * as one building on two lines would show both villages a schedule that is not theirs, so it is
 * withheld — the lookup says it could not find the house and the person picks their черга by hand,
 * as before this dictionary. No answer is recoverable; a confident wrong one is not.
 */
const WITHHELD = null;
const sameLines = (a, b) => a.length === b.length && a.every((key) => b.includes(key));

export function mergeHouse(map, house, keys, problems, where) {
  if (!(house in map)) { map[house] = keys; return; }
  if (map[house] === WITHHELD || sameLines(map[house], keys)) return;
  problems.conflicts.push(`${where}, ${house}: ${map[house].join(' + ')} vs ${keys.join(' + ')}`);
  map[house] = WITHHELD;
}

/**
 * `house → [черга, …]` → what goes to `s/` and what to `x/`.
 *
 * A house on one черга goes to `s/` as `{house: key}`, the shape app 1.0.2 decodes. A house on
 * several goes to `x/` only, with all of them. Putting its first черга in `s/` as well would have
 * 1.0.2 present one of two schedules as the whole answer; leaving it out keeps 1.0.2 saying "not
 * found", exactly what it said when these houses were dropped, while newer apps read `x/` and
 * show both.
 */
export function splitLines(houses) {
  const single = {}, lines = {};
  for (const [house, keys] of Object.entries(houses)) {
    if (keys === WITHHELD || keys.length > MAX_LINES) continue;
    if (keys.length > 1) lines[house] = keys;
    else single[house] = keys[0];
  }
  return { single, lines };
}

/**
 * More черги than a building plausibly has lines, so withheld like a conflict.
 *
 * In the 01.07.2026 set 854 of the 953 multi-черга houses have two, 704 of them in Хмельницький
 * itself — apartment blocks, the shape ДТЕК reports. But 23 have four to seven, almost all village
 * houses: overlapping rows of the operator's table, not lines. ДТЕК's own maximum across 1.6 M
 * houses is four.
 */
export const MAX_LINES = 3;

/** One workbook → `settlement → street → { house: [queueKey, …] }`, plus what could not be read. */
export function parseWorkbook(grid) {
  const bySettlement = new Map();
  const problems = { noQueue: 0, noHouses: 0 };

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

    for (const house of list) assignHouse(map, house, key);
  }
  return { bySettlement, problems };
}

/**
 * The list to publish, given the one published last time and the names the operator lists now.
 *
 * The phone addresses settlements and streets by their INDEX in the published list, and caches
 * that list for a day. If a rebuild reorders it — the operator adds or drops a street and
 * everything after it shifts — a cached list paired with a fresh `s/<i>.json` shows another
 * street's houses, in every app version already installed. So indices are permanent: the previous
 * list is kept as it is, new names are appended, and a name the operator no longer lists keeps its
 * slot (writeRegion empties its files). Same index rule as stable() in build-addresses.mjs.
 */
export function stableList(previous, current) {
  const known = new Set(previous);
  const live = new Set(current);
  const added = current.filter((name) => !known.has(name));
  return {
    list: [...previous, ...added],
    live,
    added: added.length,
    gone: previous.filter((name) => !live.has(name)).length
  };
}

/**
 * A list an earlier run published, or [] when there is none yet.
 *
 * Only a missing file means "none". A list that does not parse — cut short by a kill, or left
 * with merge markers — stops the run: taken for a first run, it would renumber every name in it.
 */
async function readList(file) {
  const text = await readFile(file, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return '[]';
    throw err;
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file}: не розбирається як JSON — поверніть його з git, перш ніж перебудовувати`);
  }
}
const byName = (a, b) => a.localeCompare(b, 'uk');

/**
 * Writes a file whole or not at all: into a dot-file beside it, then renamed over it. A plain
 * write truncates first, so a kill mid-write would leave half a list. Hosting skips dot-files, so
 * a temp file a kill leaves behind is never published.
 */
async function writeWhole(file, text) {
  const temp = join(dirname(file), `.${basename(file)}.tmp`);
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

/**
 * Writes `settlement → street → houses` into `out`, over whatever the last run left there.
 *
 * Written in place rather than wiped and rebuilt, because the previous lists are what keeps the
 * indices (stableList). A name the operator stopped listing keeps its slot but not its houses:
 * its `s/` becomes `{}` and its `x/` goes. The operator's files replace last quarter's whole, so
 * the houses it last had are on a superseded черга, and "not found" — the person picks their
 * черга by hand — beats presenting last quarter's answer as current.
 *
 * Each list is written after the files it points to, so a run that dies half-way leaves the old
 * lists — each a prefix of the new one — over files that are either old or already new. A
 * settlement slot past the end of the old list is cleared before it is used: a run that died
 * there may have filled it for another village, if the rerun's new names differ.
 */
export async function writeRegion(out, merged) {
  const previous = await readList(join(out, 'settlements.json'));
  const settlements = stableList(previous, [...merged.keys()].sort(byName));
  const stats = {
    settlements: settlements.list.length, settlementsAdded: settlements.added, settlementsGone: settlements.gone,
    streets: 0, streetsAdded: 0, streetsGone: 0, addresses: 0, multiLine: 0, queues: new Set(), examples: []
  };

  for (let c = 0; c < settlements.list.length; c++) {
    const name = settlements.list[c];
    const dir = join(out, 'c', String(c));
    if (c >= previous.length) await rm(dir, { recursive: true, force: true });
    // A settlement no longer listed has no live streets, so all of them are emptied below.
    const streets = merged.get(name) ?? new Map();
    const names = stableList(await readList(join(dir, 'streets.json')), [...streets.keys()].sort(byName));
    await mkdir(join(dir, 's'), { recursive: true });

    for (let i = 0; i < names.list.length; i++) {
      const file = `${i}.json`;
      if (!names.live.has(names.list[i])) {
        await rm(join(dir, 'x', file), { force: true });
        await writeWhole(join(dir, 's', file), '{}');
        continue;
      }
      const { single, lines } = splitLines(streets.get(names.list[i]));
      // `x/` before `s/`, as in build-addresses.mjs. A street that no longer has a multi-line house
      // loses its `x/` file, or the app would keep showing a second черга the operator dropped.
      if (Object.keys(lines).length) {
        await mkdir(join(dir, 'x'), { recursive: true });
        await writeWhole(join(dir, 'x', file), JSON.stringify(lines));
      } else {
        await rm(join(dir, 'x', file), { force: true });
      }
      await writeWhole(join(dir, 's', file), JSON.stringify(single));

      stats.addresses += Object.keys(single).length;
      stats.multiLine += Object.keys(lines).length;
      for (const key of Object.values(single)) stats.queues.add(key);
      for (const [house, keys] of Object.entries(lines)) {
        for (const key of keys) stats.queues.add(key);
        if (stats.examples.length < 5) stats.examples.push(`${name}, ${names.list[i]}, ${house}: ${keys.join(' + ')}`);
      }
    }
    await writeWhole(join(dir, 'streets.json'), JSON.stringify(names.list));
    stats.streets += names.list.length;
    stats.streetsAdded += names.added;
    stats.streetsGone += names.gone;
  }

  await writeWhole(join(out, 'settlements.json'), JSON.stringify(settlements.list));
  return stats;
}

/**
 * Where a run writes. `--only <РЕМ>` checks one file and is not a build: merged over the published
 * region it would rewrite every street that РЕМ shares with another from its file alone, dropping
 * the other's houses and publishing the ones a full run withholds as a disagreement. So it gets a
 * fresh temp dir and the published region is left alone.
 */
export const outputDir = (only) => (only == null ? OUT : mkdtemp(join(tmpdir(), 'addr-khmelnytskyi-')));

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
    // A house on several черги is only in `x/`, so "ours" is both files of the street.
    const street0 = (sub) => readFile(join(OUT, 'c', String(index), sub, '0.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    const ours = Object.keys({ ...(await street0('s')), ...(await street0('x')) });
    const overlap = ours.filter((h) => theirHouses.has(h)).length;
    checked += ours.length;
    matched += overlap;
    console.log(`  ${name}, ${street}: наших ${ours.length}, у оператора ${theirHouses.size}, збіглося ${overlap}`);
  }
  console.log(`\nзбіг будинків: ${matched}/${checked}`);
}

async function main() {
  const flag = process.argv.indexOf('--only');
  const only = flag === -1 ? null : process.argv[flag + 1];
  if (only === undefined) { console.error('--only потребує назви РЕМ, напр. --only Шепетівський'); process.exit(1); }
  const wanted = only === null ? REMS : [only];

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
  const remsOf = new Map();

  for (const hit of found) {
    const buffer = Buffer.from(await (await fetch(hit.url)).arrayBuffer());
    const parsed = parseWorkbook(sheetGrid(buffer));
    problems.noQueue += parsed.problems.noQueue;
    problems.noHouses += parsed.problems.noHouses;

    for (const [settlement, streets] of parsed.bySettlement) {
      remsOf.set(settlement, [...(remsOf.get(settlement) ?? []), hit.rem]);
      const target = merged.get(settlement) ?? new Map();
      merged.set(settlement, target);
      for (const [street, houses] of streets) {
        const into = target.get(street) ?? {};
        target.set(street, into);
        // Merged one house at a time rather than with Object.assign, so that a house two РЕМ
        // files disagree about is withheld here instead of the later file simply winning.
        for (const [house, keys] of Object.entries(houses)) {
          mergeHouse(into, house, keys, problems, `${settlement}, ${street}`);
        }
      }
    }
  }

  const out = await outputDir(only);
  const built = await writeRegion(out, merged);
  const queues = built.queues;

  // The region's queue list is published by the mirror adapter, not from here — but it has to
  // name every черга this dictionary can return, or the app will find someone's підчерга and
  // then refuse to apply it. Rather than write a second copy of the list and let the two drift,
  // this checks that the operator still uses the national scheme the adapter publishes.
  const unexpected = [...queues].filter((q) => !NATIONAL_QUEUES.includes(q.replace(/^GPV/, '')));
  if (unexpected.length) {
    console.log(`\nУВАГА: черги поза національною схемою: ${unexpected.join(', ')}`);
    console.log('  sources/khmelnytskyi.mjs публікує лише 1.1–6.2 — адреси в цих чергах не застосуються');
  }

  console.log(`\nнаселених пунктів ${built.settlements} (нових ${built.settlementsAdded}, більше не в списку ${built.settlementsGone})`);
  console.log(`вулиць ${built.streets} (нових ${built.streetsAdded}, більше не в списку ${built.streetsGone} — лишились у списку, без адрес)`);
  console.log(`адрес ${built.addresses} · будинків на кількох чергах ${built.multiLine}`);
  console.log(`черг ${queues.size}: ${[...queues].sort().join(', ')}`);
  if (built.examples.length) {
    console.log('на кількох чергах, перші:');
    for (const e of built.examples) console.log('  ', e);
  }
  if (problems.noQueue) console.log(`рядків без черги пропущено: ${problems.noQueue}`);
  if (problems.noHouses) console.log(`рядків без будинків пропущено: ${problems.noHouses}`);
  // Merging is by name, so a village name two РЕМ both list is either one place on a district
  // border or two places — and the second would mix two villages' streets in one picker entry.
  const shared = [...remsOf].filter(([, rems]) => rems.length > 1);
  if (shared.length) {
    console.log(`УВАГА: назва є в кількох РЕМ — ${shared.length}, перші:`);
    for (const [name, rems] of shared.slice(0, 5)) console.log('  ', `${name}: ${rems.join(', ')}`);
  }
  if (problems.conflicts.length) {
    console.log(`РЕМ-файли розходяться — не опубліковано ${problems.conflicts.length}, перші:`);
    for (const c of problems.conflicts.slice(0, 5)) console.log('  ', c);
  }
  if (only !== null) console.log(`\nлише ${only} РЕМ — записано в ${out}; опублікований регіон не змінено`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await (process.argv.includes('--verify') ? verify() : main())
    .catch((err) => { console.error(err.message); process.exit(1); });
}
