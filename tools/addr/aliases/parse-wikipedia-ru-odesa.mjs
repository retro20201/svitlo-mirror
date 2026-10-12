/**
 * ru.wikipedia «Список улиц Одессы»: lines «* ''Старое название улица'' — см. Новое название улица».
 * The names are RUSSIAN, so the rows are not pairs the builder can join to the operator's list; they
 * carry the flag `ruonly` and give the builder the Russian form of an old name it already knows
 * from another source (it matches both names by a loose Russian/Ukrainian key).
 *
 *   node tools/addr/aliases/parse-wikipedia-ru-odesa.mjs <raw/wikipedia-ru-odesa> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesOf, plain } from './wikitext.mjs';
import { parseName, tidyName } from './text.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

/** Pure: the page → rows with the Russian names in `old_name` / `new_name` and in `ru`. */
export function parseRuOdesa(page, { fetched = '' } = {}) {
  const url = `https://ru.wikipedia.org/?oldid=${page.revid}`;
  const rows = [];
  for (const line of page.text.split('\n')) {
    if (!/^\*/.test(line) || !/см\./.test(line)) continue;
    const raw = line.replace(/^\*+/, '').replace(/\{\{[^}]*\}\}/g, '');
    // The old name is in italics. «Новое улица — см. ''Старое улица''» lists the same pair from the other
    // side (the new name first); that line is the reverse of a line already read and is skipped.
    const split = raw.match(/^(.*?)\s*[—–-]\s*см\.(.*)$/);
    if (!split) continue;
    const rightRaw = split[2].replace(/^''/, '');
    if (/''/.test(rightRaw)) continue;
    const text = plain(raw);
    const m = text.match(/^(.*?)\s*[—–-]\s*см\.\s*(.+)$/);
    if (!m) continue;
    const right = m[2].replace(/\s*\([^)]*\)\s*$/, '');
    for (const oldPiece of m[1].split(/\s*\/\s*/)) {
      const old = parseName(oldPiece);
      const next = parseName(right);
      if (!old.name || old.junk || !next.name || next.junk) continue;
      rows.push(row({
        list: 'streets', scope: 'odesa/odesa',
        old_type: old.type, old_name: tidyName(old.name), new_type: next.type, new_name: tidyName(next.name),
        src: 'wp', flags: 'ruonly', ru: tidyName(old.name), url, fetched
      }));
    }
  }
  return sortRows(rows, SOURCE_SORT);
}

/** Reads `raw/wikipedia-ru-odesa` → rows. */
export async function parseRaw(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const page = pagesOf(JSON.parse(await readFile(join(dir, 'ru-odesa.json'), 'utf8')))[0];
  return parseRuOdesa(page, { fetched: manifest.files[0].fetchedAt.slice(0, 10) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-wikipedia-ru-odesa.mjs <raw/wikipedia-ru-odesa> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
