/**
 * OpenStreetMap through Overpass: highways whose `old_name*` tags say what the street was called.
 * One file per town (`raw/osm/<town>.json`, `out tags center`).
 *
 * Which tags count:
 *   old_name, old_name:uk, old_name2          Ukrainian old names (a `;` list holds several; Latin ones go)
 *   old_name:ru                               the Russian form of the same, kept as `ru`
 *   old_name:<period>, old_name:uk:<period>   dated variants («1985-2024», «--2023-09-27»): the end year is the year of the rename
 * Every other language (en, pl, de, fr, it, be, ko, uk-Latn …) is noise and is ignored.
 *
 *   node tools/addr/aliases/parse-osm.mjs <raw/osm> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseName, tidyName, isCyrillicName, cleanSpaces } from './text.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

/**
 * File name → the scope of the operator list the names belong to. `box` [south, west, north, east]
 * drops ways outside the town: the Overpass areas for Obukhiv, Fastiv and Pereyaslav are whole
 * hromadas, villages included, and their streets are not the town's.
 */
export const OSM_TOWNS = {
  'bila-tserkva': { scope: 'kyiv-region/bila-tserkva' },
  'boryspil': { scope: 'kyiv-region/boryspil' },
  'brovary': { scope: 'kyiv-region/brovary' },
  'bucha': { scope: 'kyiv-region/bucha' },
  'irpin': { scope: 'kyiv-region/irpin' },
  'vasylkiv': { scope: 'kyiv-region/vasylkiv' },
  'vyshhorod': { scope: 'kyiv-region/vyshhorod' },
  'obukhiv': { scope: 'kyiv-region/obukhiv', box: [50.075, 30.57, 50.14, 30.68] },
  'fastiv': { scope: 'kyiv-region/fastiv', box: [50.05, 29.86, 50.11, 29.98] },
  'pereyaslav': { scope: 'kyiv-region/pereyaslav', box: [50.05, 31.40, 50.10, 31.50] },
  'dnipro': { scope: 'dnipro/dnipro' },
  'kamianske': { scope: 'dnipro/kamianske' },
  'kryvyi-rih': { scope: 'dnipro/kryvyi-rih' },
  'nikopol': { scope: 'dnipro/nikopol' },
  'pavlohrad': { scope: 'dnipro/pavlohrad' },
  'khmelnytskyi': { scope: 'khmelnytskyi/khmelnytskyi' },
  'odesa': { scope: 'odesa/odesa' },
  'izmail': { scope: 'odesa/izmail' },
  'chornomorsk': { scope: 'odesa/chornomorsk' },
  'bilhorod-dnistrovskyi': { scope: 'odesa/bilhorod-dnistrovskyi' },
  'podilsk': { scope: 'odesa/podilsk' }
};

/** The years a key's period ends in: «1985-2024» → 2024, «--2023-09-27» → 2023, «-2016» → 2016. */
function periodYear(period) {
  const years = [...period.matchAll(/(?<!\d)(19\d\d|20[0-3]\d)(?!\d)/g)].map((m) => m[1]);
  return years.length ? years[years.length - 1] : '';
}

/** Splits the old-name tags of one way into groups: { period, year, uk: [...], ru: [...] }. */
export function oldNameGroups(tags) {
  const groups = new Map();
  const group = (period) => {
    if (!groups.has(period)) groups.set(period, { period, year: periodYear(period), uk: [], ru: [] });
    return groups.get(period);
  };
  for (const [key, value] of Object.entries(tags)) {
    let m;
    if (key === 'old_name' || key === 'old_name:uk' || key === 'old_name2') { group('').uk.push(value); continue; }
    if (key === 'old_name:ru') { group('').ru.push(value); continue; }
    if ((m = key.match(/^old_name:(?:uk:)?([-~\d][-~\d.]*)$/))) { group(m[1]).uk.push(value); continue; }
    if ((m = key.match(/^old_name:ru:([-~\d][-~\d.]*)$/))) { group(m[1]).ru.push(value); continue; }
  }
  return [...groups.values()];
}

/** `a;b;Latin` → the Cyrillic parts, as written. */
function splitValues(value) {
  return String(value).split(/\s*[;|]\s*|\s*,\s+/).map((v) => cleanSpaces(v)).filter((v) => v && isCyrillicName(v));
}

function insideBox(element, box) {
  if (!box) return true;
  const c = element.center;
  if (!c) return false;
  return c.lat >= box[0] && c.lat <= box[2] && c.lon >= box[1] && c.lon <= box[3];
}

/** Pure: one town's Overpass answer → source rows (one per distinct pair, with the first way as the note). */
export function parseOsmTown(json, { scope, box, fetched = '' }) {
  const merged = new Map();
  for (const element of json.elements ?? []) {
    if (element.type !== 'way' || !insideBox(element, box)) continue;
    const tags = element.tags ?? {};
    const newRaw = tags['name:uk'] || tags.name;
    if (!newRaw || !isCyrillicName(newRaw)) continue;
    const current = parseName(newRaw);
    // Two names glued into one tag («Зелена вулиця вулиця Шестакова»): not a name.
    if (current.junk || !current.name) continue;
    for (const g of oldNameGroups(tags)) {
      const old = g.uk.flatMap(splitValues);
      const ru = g.ru.flatMap(splitValues);
      old.forEach((value, i) => {
        const parsed = parseName(value);
        const name = tidyName(parsed.name);
        if (!name || parsed.junk || parsed.unofficial) return;
        const sameName = parsed.tokens.join(' ') === current.tokens.join(' ');
        if (sameName && (!parsed.type || !current.type || parsed.type === current.type)) return;
        const russian = ru.length === old.length ? ru[i] : old.length === 1 ? ru[0] : '';
        const key = [parsed.type, name, current.type, current.name, g.year, russian ? parseName(russian).name : ''].join('|');
        if (!merged.has(key)) {
          merged.set(key, {
            old_type: parsed.type, old_name: name, new_type: current.type, new_name: tidyName(current.name),
            year: g.year, ru: russian ? tidyName(parseName(russian).name) : '', part: parsed.part, way: element.id
          });
        }
      });
    }
  }
  const rows = [...merged.values()].map((m) => row({
    list: 'streets', scope,
    old_type: m.old_type, old_name: m.old_name, new_type: m.new_type, new_name: m.new_name,
    year: m.year, src: 'osm', flags: m.part ? 'part' : '', ru: m.ru,
    note: `way/${m.way}`, url: `https://www.openstreetmap.org/way/${m.way}`, fetched
  }));
  return sortRows(rows, SOURCE_SORT);
}

/** Reads `raw/osm` (one file per town and the manifest) → rows. */
export async function parseRaw(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const all = [];
  for (const [town, cfg] of Object.entries(OSM_TOWNS)) {
    const entry = manifest.files.find((f) => f.path === `${town}.json`);
    if (!entry) throw new Error(`osm/${town}.json is not in the manifest`);
    const json = JSON.parse(await readFile(join(dir, entry.path), 'utf8'));
    all.push(...parseOsmTown(json, { ...cfg, fetched: (json.osm3s?.timestamp_osm_base ?? entry.fetchedAt).slice(0, 10) }));
  }
  return sortRows(all, SOURCE_SORT);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-osm.mjs <raw/osm> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
