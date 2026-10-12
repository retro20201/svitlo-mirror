/**
 * rename.dp.ua/rename.json: Dnipro's renamed streets by raion, with the kind of thing renamed.
 * The site states no licence, so these rows are a CROSS-CHECK only: the builder gives them the
 * source code `rdp`, and the gate refuses any published row that rests on `rdp` alone.
 *
 *   node tools/addr/aliases/parse-rename-dp.mjs <raw/rename-dp> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseName, tidyName } from './text.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

const KINDS = {
  street: 'вул.', lane: 'пров.', impasse: 'тупик', avenue: 'просп.', square: 'пл.', embankment: 'наб.',
  boulevard: 'бул.', slope: 'узвіз'
};

/** Pure: the parsed json → rows. */
export function parseRenameDp(json, { url = '', fetched = '' } = {}) {
  const rows = [];
  for (const [key, area] of Object.entries(json)) {
    if (!/^r\d+$/.test(key) || !Array.isArray(area.objects)) continue;
    for (const o of area.objects) {
      const type = KINDS[o.type];
      if (!type) continue;
      const old = parseName(o.oldName);
      const next = parseName(o.newName);
      if (!old.name || old.junk || !next.name || next.junk) continue;
      const newType = KINDS[o.newType] || next.type || type;
      if (old.tokens.join(' ') === next.tokens.join(' ') && (old.type || type) === newType) continue;
      rows.push(row({
        list: 'streets', scope: 'dnipro/dnipro',
        old_type: old.type || type, old_name: tidyName(old.name), new_type: newType, new_name: tidyName(next.name),
        district: area.newAreaName ?? '', src: 'rdp', flags: [old.part ? 'part' : '', o.restored ? 'restored' : ''].filter(Boolean).join(','),
        url, fetched
      }));
    }
  }
  return sortRows(rows, SOURCE_SORT);
}

/** Reads `raw/rename-dp` → rows. */
export async function parseRaw(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const f = manifest.files.find((x) => x.path === 'rename.json');
  return parseRenameDp(JSON.parse(await readFile(join(dir, 'rename.json'), 'utf8')), { url: f.url, fetched: f.fetchedAt.slice(0, 10) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-rename-dp.mjs <raw/rename-dp> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
