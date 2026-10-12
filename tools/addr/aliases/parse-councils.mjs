/**
 * Council decisions that come as HTML tables or Word annexes:
 *   boryspil        three decisions of Бориспільська міська рада: «Стара назва | Нова назва» tables, the city's and its villages'
 *   bila-tserkva    the council's rename page (Wayback copy): 2016, 28.07.2022 and 27.06.2024 tables
 *   brovary         the annex of decision 713-26-08 (06.05.2022), «Вул/провул. | Попереднє | Нове найменування»
 *   khmelnytskyi    annex 3 of decision 24/2008 as amended: every street with «Попередні назви» (type word included)
 *
 * A row names a street in a town; a heading row between rows («село Глибоке», «с. Гайок») moves the
 * rows below it to that village, whose scope is `<region>/~<type> <name>` and is resolved against
 * the operator's settlement list by the builder.
 *
 *   node tools/addr/aliases/parse-councils.mjs <raw root> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlTables, htmlTitle } from './html.mjs';
import { readDocx } from './docx.mjs';
import { parseName, tidyName, settlementTypeOf, parseName as parse, cleanSpaces } from './text.mjs';
import { yearIn } from './wiki-common.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

const MONTHS = { січня: 1, лютого: 2, березня: 3, квітня: 4, травня: 5, червня: 6, липня: 7, серпня: 8, вересня: 9, жовтня: 10, листопада: 11, грудня: 12 };

/** «село Глибоке», «с. Гайок», «м.Біла Церква» → { type, name } or null. */
export function localityHeading(text) {
  const t = cleanSpaces(text).replace(/^м\./, 'м. ').replace(/^с\./, 'с. ');
  const m = t.match(/^(місто|селище|село|смт|м\.|с\.|с-ще|сел\.)\s+(.+)$/i);
  if (!m) return null;
  const type = settlementTypeOf(m[1]);
  return type ? { type, name: tidyName(m[2]) } : null;
}

/** The scope of a heading row inside a town's table: the town itself, or `<region>/~<type> <name>`. */
function scopeFor(region, townScope, townName, heading) {
  if (!heading) return townScope;
  const same = parse(heading.name, 'settlement').tokens.join(' ') === parse(townName, 'settlement').tokens.join(' ');
  return same ? townScope : `${region}/~${heading.type} ${heading.name}`;
}

function pairRow({ scope, oldCell, newCell, year, act, url, fetched, district = '', note = '' }) {
  const old = parseName(oldCell);
  const next = parseName(newCell);
  if (!old.name || old.junk || !next.name || next.junk) return null;
  if (old.tokens.join(' ') === next.tokens.join(' ') && old.type === next.type) return null;
  return row({
    list: 'streets', scope,
    old_type: old.type, old_name: tidyName(old.name), new_type: next.type, new_name: tidyName(next.name),
    district, year, act, src: 'loc', flags: old.part ? 'part' : '', note, url, fetched
  });
}

/** The date in a Borispol title: «17 грудня 2015 року № 42-2-VII» → { year, act }. */
export function boryspilMeta(title) {
  const m = title.match(/(\d{1,2})\s+(\S+)\s+(\d{4})\s+року\s+№\s*([\p{L}\d-]+)/u);
  return m ? { year: m[3], act: `БМР ${m[4]}`, date: `${m[1]} ${m[2]} ${m[3]}` } : { year: '', act: '' };
}

/** Pure: one Borispol decision's page → rows. Tables are «№ | Стара назва | Нова назва». */
export function parseBoryspil(html, { url = '', fetched = '' } = {}) {
  const { year, act } = boryspilMeta(htmlTitle(html));
  const rows = [];
  for (const table of htmlTables(html)) {
    let scope = 'kyiv-region/boryspil';
    for (const cells of table) {
      if (cells.length === 1) {
        const heading = localityHeading(cells[0]);
        if (heading) scope = scopeFor('kyiv-region', 'kyiv-region/boryspil', 'Бориспіль', heading);
        continue;
      }
      if (cells.length < 3 || !/^\d+\.?$/.test(cells[0])) continue;
      const r = pairRow({ scope, oldCell: cells[1], newCell: cells[2], year, act, url, fetched });
      if (r) rows.push(r);
    }
  }
  return rows;
}

/** «рішення БМР … від 28 липня 2022 року № 2869-31-VІІІ» → { year, act }. */
function bilaTserkvaDecision(text) {
  const m = text.match(/від\s+(\d{1,2})\s+(\S+)\s+(\d{4})\s+року\s+№\s*([\p{L}\d-]+)/u);
  return m ? { year: m[3], act: `БМР ${m[4]}` } : { year: '', act: '' };
}

/** Pure: the Bila Tserkva page → rows. Tables 0/1 carry the decision per row; the last is the 2016 list. */
export function parseBilaTserkva(html, { url = '', fetched = '' } = {}) {
  const rows = [];
  for (const table of htmlTables(html)) {
    const header = table.find((r) => r.some((c) => /стара назва/i.test(c)));
    if (!header) continue;
    const hasDecision = header.some((c) => /рішення/i.test(c));
    let scope = 'kyiv-region/bila-tserkva';
    for (const cells of table) {
      const first = cells.find((c) => c && !/^\d+\.?$/.test(c));
      if (cells.filter(Boolean).length === 1 || (cells[0] === '' && localityHeading(cells[1] ?? ''))) {
        const heading = localityHeading(first ?? '');
        if (heading) scope = scopeFor('kyiv-region', 'kyiv-region/bila-tserkva', 'Біла Церква', heading);
        continue;
      }
      if (!/^\d+\.?$/.test(cells[0]) || cells.length < 3) continue;
      const decision = hasDecision ? bilaTserkvaDecision(cells[4] ?? '') : { year: '2016', act: '' };
      const r = pairRow({ scope, oldCell: cells[1], newCell: cells[2], ...decision, url, fetched });
      if (r) rows.push(r);
    }
  }
  return rows;
}

/** Pure: Brovary's annex: «№ | Вул/провул. | Попереднє найменування | Нове найменування». */
export function parseBrovary(blocks, { url = '', fetched = '' } = {}) {
  const date = blocks.find((b) => b.kind === 'p' && /від\s+\d\d\.\d\d\.\d{4}/.test(b.text))?.text.match(/(\d{4})/)?.[1] ?? '';
  const number = blocks.find((b) => b.kind === 'p' && /^№\s*[\d-]+/.test(b.text))?.text.replace(/^№\s*/, '') ?? '';
  const rows = [];
  for (const block of blocks.filter((b) => b.kind === 'table')) {
    for (const cells of block.rows) {
      if (cells.length < 4 || /найменування/i.test(cells[2])) continue;
      const r = pairRow({
        scope: 'kyiv-region/brovary', oldCell: `${cells[1]} ${cells[2]}`, newCell: `${cells[1]} ${cells[3]}`,
        year: date, act: number ? `БМР ${number}` : '', url, fetched
      });
      if (r) rows.push(r);
    }
  }
  return rows;
}

/**
 * Pure: Khmelnytskyi annex 3: [№, type, full name, short name, location, year, previous names, code].
 * The annex lists EVERY street of the city, with or without previous names. A street without any is no rename, but
 * its name is somebody's current name: a `census` row says so (the operator's list has 883 streets and misses
 * some of them, «вул. Лесі Українки» in Ракове among them), so that an old name which is also a current name
 * somewhere in the city is never offered as a sure answer.
 */
export function parseKhmelnytskyi(blocks, { url = '', fetched = '' } = {}) {
  const rows = [];
  const table = blocks.filter((b) => b.kind === 'table').find((b) => b.rows[0]?.some((c) => /Попередні назви/i.test(c)));
  if (!table) return rows;
  for (const cells of table.rows.slice(1)) {
    if (cells.length < 7) continue;
    const [, typeWord, fullName, shortName, location, yearCell, previous, code] = cells;
    const newName = parseName(`${typeWord} ${fullName}`);
    if (!newName.type || !newName.name) continue;
    rows.push(row({
      list: 'streets', scope: 'khmelnytskyi/khmelnytskyi', new_type: newName.type, new_name: tidyName(newName.name),
      act: 'ХМР 24/2008', src: 'loc', flags: 'census',
      note: [code ? `код ${code}` : '', location].filter(Boolean).join('; '), url, fetched
    }));
    if (!previous?.trim()) continue;
    const year = yearIn(yearCell);
    for (const part of previous.split(/\s*[,;]\s*/)) {
      const r = pairRow({
        scope: 'khmelnytskyi/khmelnytskyi', oldCell: part, newCell: `${typeWord} ${fullName}`,
        year, act: 'ХМР 24/2008', url, fetched, note: [code ? `код ${code}` : '', shortName && shortName !== fullName ? `коротка: ${shortName}` : '', location].filter(Boolean).join('; ')
      });
      if (r) rows.push(r);
    }
  }
  return rows;
}

/** Reads `raw/{boryspil,bila-tserkva,brovary,khmelnytskyi}` → rows. */
export async function parseRaw(root) {
  const files = async (dir) => JSON.parse(await readFile(join(root, dir, 'manifest.json'), 'utf8')).files;
  const all = [];
  for (const f of await files('boryspil')) {
    if (f.path.endsWith('.html')) all.push(...parseBoryspil(await readFile(join(root, 'boryspil', f.path), 'utf8'), { url: f.url, fetched: f.fetchedAt.slice(0, 10) }));
  }
  for (const f of await files('bila-tserkva')) {
    if (f.path.endsWith('.html')) all.push(...parseBilaTserkva(await readFile(join(root, 'bila-tserkva', f.path), 'utf8'), { url: f.url, fetched: f.fetchedAt.slice(0, 10) }));
  }
  for (const f of await files('brovary')) {
    if (f.path.endsWith('.docx')) all.push(...parseBrovary(readDocx(await readFile(join(root, 'brovary', f.path))), { url: f.url, fetched: f.fetchedAt.slice(0, 10) }));
  }
  for (const f of await files('khmelnytskyi')) {
    if (f.path.endsWith('.docx')) all.push(...parseKhmelnytskyi(readDocx(await readFile(join(root, 'khmelnytskyi', f.path))), { url: f.url, fetched: f.fetchedAt.slice(0, 10) }));
  }
  return sortRows(all, SOURCE_SORT);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-councils.mjs <raw root> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
