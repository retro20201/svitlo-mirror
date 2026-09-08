/**
 * Writes `v1/addr/index.json` — what the app reads to decide whether it can offer address lookup
 * for a region at all, and which of the two layouts to walk.
 *
 * Kept separate from the builder so it can be re-run after any harvest, in any order, without
 * re-fetching anything: it only scans what is already on disk. A region that is half-built is
 * reported with its real counts, so the app can still use the streets that exist.
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADDR = join(ROOT, 'firebase', 'public', 'v1', 'addr');

const readJSON = async (p) => JSON.parse(await readFile(p, 'utf8'));
const exists = async (p) => !!(await stat(p).catch(() => null));

async function countFlat(dir) {
  const streets = await readJSON(join(dir, 'streets.json'));
  let built = 0, addresses = 0;
  for (let i = 0; i < streets.length; i++) {
    const f = join(dir, 's', `${i}.json`);
    if (!(await exists(f))) continue;
    built++;
    addresses += Object.keys(await readJSON(f)).length;
  }
  return { shape: 'flat', streets: streets.length, built, addresses };
}

async function countNested(dir) {
  const settlements = await readJSON(join(dir, 'settlements.json'));
  let streets = 0, built = 0, addresses = 0;
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
  }
  return { shape: 'nested', settlements: settlements.length, streets, built, addresses };
}

const index = {};
for (const region of (await readdir(ADDR).catch(() => [])).sort()) {
  const dir = join(ADDR, region);
  if (!(await stat(dir)).isDirectory()) continue;
  if (await exists(join(dir, 'streets.json'))) index[region] = await countFlat(dir);
  else if (await exists(join(dir, 'settlements.json'))) index[region] = await countNested(dir);
}

await writeFile(join(ADDR, 'index.json'), JSON.stringify(index, null, 1), 'utf8');
for (const [r, v] of Object.entries(index)) {
  const done = v.streets ? Math.round((v.built / v.streets) * 100) : 0;
  console.log(`${r.padEnd(12)} ${v.shape.padEnd(7)} ${v.built}/${v.streets} streets (${done}%), ${v.addresses} addresses`);
}
