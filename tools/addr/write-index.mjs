/**
 * Writes `v1/addr/index.json` — what the app reads to decide whether it can offer address lookup
 * for a region at all, and which of the two layouts to walk.
 *
 * Kept separate from the builder so it can be re-run after any harvest, in any order, without
 * re-fetching anything: it only scans what is already on disk. A region that is half-built is
 * reported with its real counts, so the app can still use the streets that exist.
 *
 * A region that publishes any `x/<i>.json` (houses fed by more than one line, each with every
 * черга) also gets `lines: true` and `multiLine`, the number of such houses. The app requests `x/`
 * only where `lines` is set, so a region without it costs no extra request per street — and the
 * entry of a region without `x/` is exactly what it was before these files existed.
 *
 * The same goes for `aliases.json` (old and former names, tools/addr/aliases/): a region that has
 * any gets `aliases: true` and `aliasKeys`, the number of entries across its files, and a region
 * without one keeps the entry it had. The app asks for `aliases.json` only where `aliases` is set,
 * and `"aliases": false` in index.json switches the feature off for a region without a release.
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADDR = join(ROOT, 'firebase', 'public', 'v1', 'addr');

const readJSON = async (p) => JSON.parse(await readFile(p, 'utf8'));
const exists = async (p) => !!(await stat(p).catch(() => null));

/** The `x/` files of one street directory: how many there are, and how many houses they name. */
async function countLines(dir) {
  let files = 0, houses = 0;
  for (const f of await readdir(dir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    files++;
    houses += Object.keys(await readJSON(join(dir, f))).length;
  }
  return { files, houses };
}

/** Adds the two fields only when there is something to say; otherwise the entry is untouched. */
const withLines = (entry, { files, houses }) => (files ? { ...entry, lines: true, multiLine: houses } : entry);

/** Same for aliases: `files` aliases.json files holding `keys` entries between them. */
const withAliases = (entry, { files, keys }) => (files ? { ...entry, aliases: true, aliasKeys: keys } : entry);

/** The `aliases.json` of a region: its own (and Kyiv's) and those under `c/<c>/`. */
async function countAliases(dir) {
  let files = 0, keys = 0;
  const one = async (file) => {
    const data = await readJSON(file).catch(() => null);
    if (!data || !Array.isArray(data.a)) return;
    files++;
    keys += data.a.length;
  };
  await one(join(dir, 'aliases.json'));
  for (const c of await readdir(join(dir, 'c')).catch(() => [])) await one(join(dir, 'c', c, 'aliases.json'));
  return { files, keys };
}

async function countFlat(dir) {
  const streets = await readJSON(join(dir, 'streets.json'));
  let built = 0, addresses = 0;
  for (let i = 0; i < streets.length; i++) {
    const f = join(dir, 's', `${i}.json`);
    if (!(await exists(f))) continue;
    built++;
    addresses += Object.keys(await readJSON(f)).length;
  }
  return withAliases(withLines({ shape: 'flat', streets: streets.length, built, addresses }, await countLines(join(dir, 'x'))), await countAliases(dir));
}

async function countNested(dir) {
  const settlements = await readJSON(join(dir, 'settlements.json'));
  let streets = 0, built = 0, addresses = 0;
  const lines = { files: 0, houses: 0 };
  const cityDirs = await readdir(join(dir, 'c')).catch(() => []);
  for (const c of cityDirs) {
    const cityDir = join(dir, 'c', c);
    const list = await readJSON(join(cityDir, 'streets.json')).catch(() => null);
    if (!list) continue;
    streets += list.length;
    for (let i = 0; i < list.length; i++) {
      const f = join(cityDir, 's', `${i}.json`);
      if (!(await exists(f))) continue;
      built++;
      addresses += Object.keys(await readJSON(f)).length;
    }
    const city = await countLines(join(cityDir, 'x'));
    lines.files += city.files;
    lines.houses += city.houses;
  }
  return withAliases(withLines({ shape: 'nested', settlements: settlements.length, streets, built, addresses }, lines), await countAliases(dir));
}

/** Every region under `addr`, keyed by its directory name. */
export async function buildIndex(addr = ADDR) {
  const index = {};
  for (const region of (await readdir(addr).catch(() => [])).sort()) {
    // `build-addresses.mjs --fresh` rebuilds into `<region>.new/` and parks the copy it replaced
    // in `<region>.old/`. Neither is a region; listing one would offer the app a half-built twin.
    if (/\.(new|old)$/.test(region)) continue;
    const dir = join(addr, region);
    if (!(await stat(dir)).isDirectory()) continue;
    if (await exists(join(dir, 'streets.json'))) index[region] = await countFlat(dir);
    else if (await exists(join(dir, 'settlements.json'))) index[region] = await countNested(dir);
  }
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = await buildIndex();
  await writeFile(join(ADDR, 'index.json'), JSON.stringify(index, null, 1), 'utf8');
  for (const [r, v] of Object.entries(index)) {
    const done = v.streets ? Math.round((v.built / v.streets) * 100) : 0;
    const lines = v.lines ? `, ${v.multiLine} on several lines` : '';
    const aliases = v.aliases ? `, ${v.aliasKeys} alias keys` : '';
    console.log(`${r.padEnd(12)} ${v.shape.padEnd(7)} ${v.built}/${v.streets} streets (${done}%), ${v.addresses} addresses${lines}${aliases}`);
  }
}
