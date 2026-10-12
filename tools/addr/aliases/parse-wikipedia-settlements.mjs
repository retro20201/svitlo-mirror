/**
 * uk.wikipedia's lists of settlements renamed by the decommunisation and decolonisation laws, for the
 * four oblasts the operator lists. They restate the Rada acts (the act is in the last column), so they
 * serve as a second witness for the pairs `parse-rada.mjs` reads from the acts themselves.
 *
 *   node tools/addr/aliases/parse-wikipedia-settlements.mjs <raw/wikipedia-uk-other> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesOf, parseTables, plain } from './wikitext.mjs';
import { settlementTypeOf, tidyName, parseName } from './text.mjs';
import { RADA_REGIONS } from './parse-rada.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

const PAGES = [/декомунізації/, /деколонізації/];
const clean = (cell) => plain(cell).replace(/^[\s|]+/, '').trim();

/** «Апостолівський» → «Апостолівський р-н»; «Переяслав-Хмельницька м/р» stays. */
function raion(text) {
  const t = clean(text);
  return /(ий|ій)$/.test(t) ? `${t} р-н` : t;
}

/** Pure: a page → rows. */
export function parseSettlementPage(page, { fetched = '' } = {}) {
  const url = `https://uk.wikipedia.org/?oldid=${page.revid}`;
  const rows = [];
  for (const table of parseTables(page.text)) {
    const oblast = table.headings.map((h) => plain(h)).reverse().find((h) => /область$/.test(h));
    const scope = oblast && RADA_REGIONS.find(([re]) => re.test(oblast))?.[1];
    if (!scope || !table.header) continue;
    const at = (re) => table.header.findIndex((h) => re.test(plain(h)));
    const [type, old, area, next, act] = [at(/^Тип/), at(/^Стара назва/), at(/^Район/), at(/^Нова назва/), at(/(Посилання|№ постанови)/)];
    if ([type, old, next].some((i) => i < 0)) continue;
    for (const cells of table.rows) {
      const kind = settlementTypeOf(clean(cells[type] ?? '').split(' ')[0]);
      const oldName = parseName(clean(cells[old] ?? ''), 'settlement');
      const newName = parseName(clean(cells[next] ?? ''), 'settlement');
      if (!kind || !oldName.name || !newName.name) continue;
      const actText = clean(cells[act] ?? '').replace(/^ПВРУ\s*/, '');
      rows.push(row({
        list: 'settlements', scope,
        old_type: kind, old_name: tidyName(oldName.name), new_type: kind, new_name: tidyName(newName.name),
        district: area >= 0 ? raion(cells[area] ?? '') : '', act: actText ? `ВРУ ${actText}` : '', src: 'wp', url, fetched
      }));
    }
  }
  return sortRows(rows, SOURCE_SORT);
}

/** Reads `raw/wikipedia-uk-other` → rows. */
export async function parseRaw(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const fetched = manifest.files[0].fetchedAt.slice(0, 10);
  const all = [];
  for (const page of pagesOf(JSON.parse(await readFile(join(dir, 'uk-10-pages.json'), 'utf8')))) {
    if (!PAGES.some((re) => re.test(page.title))) continue;
    all.push(...parseSettlementPage(page, { fetched }));
  }
  return sortRows(all, SOURCE_SORT);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-wikipedia-settlements.mjs <raw/wikipedia-uk-other> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
