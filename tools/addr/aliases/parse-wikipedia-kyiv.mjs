/**
 * uk.wikipedia «Список вулиць Києва (А…Я, лінії, Садові)»: one `{{Street-table-row-Kiev|…}}` per
 * street, with its former names. Arguments, in order:
 *   1 cadastre code  2 current name (a link)  3 type  4 former names  5 district  6 locality
 *   7 year of the current name with the template that cites the deciding act  [8 flags, ignored]
 *
 * In the former-names cell a template after a name cites the act that GAVE that name, so the act of
 * the rename is the one after the year, not the ones in the cell.
 *
 *   node tools/addr/aliases/parse-wikipedia-kyiv.mjs <raw/wikipedia-kyiv> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTemplates, pagesOf, plain, stripNotes } from './wikitext.mjs';
import { parseName, streetTypeOf, tidyName, cleanSpaces } from './text.mjs';
import { districts, formerNames } from './wiki-common.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

const ACT_PREFIX = { 'ркмр2': 'КМР', 'рвкмр2': 'ВК КМР', 'ркмда2': 'КМДА', 'ркмр': 'КМР', 'рвкмр': 'ВК КМР' };

/** «2019{{ркмр2|7610}}» → { year: '2019', act: 'КМР 7610' }. */
export function yearAndAct(cell) {
  const text = stripNotes(cell);
  const template = text.match(/\{\{\s*([^|{}]+?)\s*\|\s*([^|{}]+?)\s*(?:\|[^{}]*)?\}\}/);
  const plainText = plain(text);
  // «до 2000» is no year: the name is older than that.
  const before = plainText.match(/до\s+(1[5-9]\d\d|20[0-3]\d)(?!\d)/i);
  const year = before ? String(Number(before[1]) - 1) : plainText.match(/(?<!\d)(1[5-9]\d\d|20[0-3]\d)(?!\d)/)?.[1] ?? '';
  const prefix = template ? ACT_PREFIX[template[1].toLowerCase()] : '';
  return { year, act: template && prefix ? `${prefix} ${template[2]}` : '' };
}

/** Pure: pages (as `pagesOf` returns them) → source rows. */
export function parseKyivPages(pages, { fetched = '' } = {}) {
  const rows = [];
  for (const page of pages) {
    for (const t of findTemplates(page.text, 'Street-table-row-Kiev')) {
      const [code, nameCell, typeCell, formerCell, districtCell, , yearCell] = t.args.map((a) => a.trim());
      if (!nameCell) continue;
      const newName = tidyName(plain(nameCell));
      if (!newName || /^без назви/i.test(newName)) continue;
      const typeWord = cleanSpaces(plain(typeCell));
      const newType = streetTypeOf(typeWord) || typeWord;
      const { year, act } = yearAndAct(yearCell ?? '');
      const url = `https://uk.wikipedia.org/?oldid=${page.revid}`;
      for (const former of formerNames(formerCell ?? '')) {
        if (parseName(former.name).tokens.join(' ') === parseName(newName).tokens.join(' ') && (!former.type || former.type === newType)) continue;
        const flags = [former.part ? 'part' : '', former.merge ? 'merge' : ''].filter(Boolean).join(',');
        rows.push(row({
          list: 'streets', scope: 'kyiv',
          old_type: former.type, old_name: former.name,
          new_type: newType, new_name: newName,
          district: districts(districtCell ?? ''), year, act, src: 'wp', flags,
          note: code ? `код ${code}` : '', url, fetched
        }));
      }
    }
  }
  return sortRows(rows, SOURCE_SORT);
}

/** Reads `raw/wikipedia-kyiv` (the 33-page answer and its manifest) → rows. */
export async function parseRaw(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const pages = pagesOf(JSON.parse(await readFile(join(dir, 'kyiv-33-pages.json'), 'utf8')));
  return parseKyivPages(pages, { fetched: manifest.files[0].fetchedAt.slice(0, 10) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-wikipedia-kyiv.mjs <raw/wikipedia-kyiv> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
