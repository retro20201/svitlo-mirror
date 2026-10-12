/**
 * uk.wikipedia street lists of the towns without a machine-readable official list: «Вулиці Дніпра»,
 * «Вулиці Кривого Рогу», «Вулиці Нікополя», «Вулиці Павлограда», «Вулиці Одеси», «Вулиці Борисполя»,
 * «Вулиці Хмельницького» and «Список перейменованих вулиць Василькова».
 *
 * Two kinds of table turn up and both are read:
 *   current   one row per street today: current name, type, [district], former names (a comma list)
 *   pair      one row per rename: old name, new name, [type], [district], [year]
 * and, for Dnipro, `# old (район) — new` list lines under a dated heading.
 *
 *   node tools/addr/aliases/parse-wikipedia-cities.mjs <raw/wikipedia-uk-other> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesOf, parseTables, parseListLines, plain } from './wikitext.mjs';
import { parseName, tidyName } from './text.mjs';
import { districts, formerNames, typesOf, yearIn, headingYear, headingAct } from './wiki-common.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

/** Page title → scope and, for tables without a header row, which column is which. */
export const CITY_PAGES = {
  'Вулиці Дніпра': { scope: 'dnipro/dnipro' },
  'Вулиці Кривого Рогу': { scope: 'dnipro/kryvyi-rih' },
  'Вулиці Нікополя': { scope: 'dnipro/nikopol', headerless: { former: 1, current: 2, type: 3 } },
  'Вулиці Павлограда': { scope: 'dnipro/pavlohrad', headerless: { type: 1, current: 2, former: 3 } },
  'Вулиці Одеси': { scope: 'odesa/odesa' },
  'Вулиці Борисполя': { scope: 'kyiv-region/boryspil' },
  'Вулиці Хмельницького': { scope: 'khmelnytskyi/khmelnytskyi' },
  'Список перейменованих вулиць Василькова': { scope: 'kyiv-region/vasylkiv' }
};

/** Which column plays which part, from the header text. */
export function columnRoles(header, rawHeader = []) {
  const roles = {};
  header.forEach((cell, i) => {
    // The plain text of a header can lose its words to a template: {{Abbr|Рік затв.|…}}.
    const h = (plain(cell) || plain(String(rawHeader[i] ?? '').replace(/\{\{[^|}]*\|([^|}]*)[^}]*\}\}/g, '$1'))).toLowerCase().replace(/\s+/g, ' ');
    const set = (role) => { if (roles[role] === undefined) roles[role] = i; };
    if (/^(сучасна назва|діючі назви|назва|нова назва|нові назви|нові)/.test(h) && !/об.єкта/.test(h)) {
      set(/^(нова|нові)/.test(h) ? 'new' : 'current');
    } else if (/(колишні назви|попередні назви|назва попередня|попередні|стара назва)/.test(h)) {
      set('former');
    } else if (/^(тип|топонім|тип топоніму|тип об.єкта)/.test(h)) set('type');
    else if (/^район/.test(h)) set('district');
    else if (/(рік|затверджено)/.test(h)) set('year');
  });
  return roles;
}

const cellAt = (cells, index) => (index === undefined ? '' : cells[index] ?? '');

/** A current-names row → pairs. */
function currentRow(cells, roles, ctx) {
  const currentRaw = cellAt(cells, roles.current);
  const name = tidyName(plain(currentRaw));
  if (!name) return [];
  const typeCell = cellAt(cells, roles.type);
  const kinds = typeCell ? typesOf(typeCell) : [];
  const parsed = parseName(name);
  // The current name may carry its own type: «Київський (проспект)» or «вулиця Х».
  const newTypes = kinds.length ? kinds : parsed.type ? [parsed.type] : [];
  if (!newTypes.length) return [];
  const out = [];
  const year = yearIn(cellAt(cells, roles.year));
  const district = districts(cellAt(cells, roles.district));
  for (const former of formerNames(cellAt(cells, roles.former))) {
    const old = parseName(former.name);
    for (const newType of newTypes) {
      if (old.tokens.join(' ') === parsed.tokens.join(' ') && (!former.type || former.type === newType)) continue;
      out.push(row({
        list: 'streets', scope: ctx.scope,
        old_type: former.type, old_name: former.name, new_type: newType, new_name: tidyName(parsed.name),
        district, year, act: '', src: 'wp', flags: [former.part ? 'part' : '', former.merge ? 'merge' : ''].filter(Boolean).join(','),
        url: ctx.url, fetched: ctx.fetched
      }));
    }
  }
  return out;
}

/** An old → new row → pairs. */
function pairRow(cells, roles, ctx, extra) {
  const oldRaw = cellAt(cells, roles.former);
  const newRaw = cellAt(cells, roles.new ?? roles.current);
  const oldNames = formerNames(oldRaw);
  const newName = parseName(plain(newRaw));
  if (!oldNames.length || !newName.name || newName.junk) return [];
  const typeCell = cellAt(cells, roles.type);
  const kinds = typeCell ? typesOf(typeCell) : [];
  const newTypes = kinds.length ? kinds : newName.type ? [newName.type] : [];
  const out = [];
  const year = yearIn(cellAt(cells, roles.year)) || extra.year;
  const district = districts(cellAt(cells, roles.district)) || extra.district || '';
  for (const old of oldNames) {
    for (const newType of newTypes.length ? newTypes : ['']) {
      const oldParsed = parseName(old.name);
      if (oldParsed.tokens.join(' ') === newName.tokens.join(' ') && (!old.type || old.type === newType)) continue;
      out.push(row({
        list: 'streets', scope: ctx.scope,
        old_type: old.type, old_name: old.name, new_type: newType, new_name: tidyName(newName.name),
        district, year, act: extra.act, src: 'wp', flags: [old.part ? 'part' : '', old.merge ? 'merge' : ''].filter(Boolean).join(','),
        url: ctx.url, fetched: ctx.fetched
      }));
    }
  }
  return out;
}

/** Pure: a page → rows. */
export function parseCityPage(page, config, { fetched = '' } = {}) {
  const ctx = { scope: config.scope, url: `https://uk.wikipedia.org/?oldid=${page.revid}`, fetched };
  const rows = [];
  for (const table of parseTables(page.text)) {
    let roles, dataRows = table.rows;
    if (table.header) roles = columnRoles(table.header, table.headerRaw);
    else if (config.headerless) { roles = config.headerless; dataRows = table.rows.slice(1); }
    else continue;
    const shape = roles.current !== undefined && roles.former !== undefined && roles.new === undefined ? 'current'
      : roles.former !== undefined && (roles.new !== undefined || roles.current !== undefined) ? 'pair' : null;
    if (!shape) continue;
    // «Список перейменувань … 2015—2016»: the year (and act) of a pair table is in its heading.
    const extra = { year: headingYear(table.headings), act: headingAct(table.headings), district: '' };
    for (const raw of dataRows) {
      const cells = raw.map((c) => c);
      if (cells.length === 1) {
        // A district marker row inside a pair table: «| colspan=3 | '''Амур-Нижньодніпровський'''».
        extra.district = districts(cells[0]);
        continue;
      }
      if (shape === 'current') rows.push(...currentRow(cells, roles, ctx));
      else rows.push(...pairRow(cells, roles, ctx, extra));
    }
  }
  return rows;
}

/** Dnipro's `# ''old вулиця (Х район)'' — '''new вулиця'''` lines under a dated heading. */
export function parseDniproLines(page, { scope, fetched = '' }) {
  const rows = [];
  const url = `https://uk.wikipedia.org/?oldid=${page.revid}`;
  for (const item of parseListLines(page.text)) {
    const text = item.text.replace(/&nbsp;/g, ' ');
    const parts = text.split(/\s+[—–-]\s+/);
    if (parts.length !== 2) continue;
    const left = plain(parts[0]);
    const right = plain(parts[1]);
    const dm = left.match(/\(([^()]*?(район|райони)[^()]*)\)\s*$/i);
    const district = dm ? districts(dm[1].replace(/\s*райони?$/i, '')) : '';
    const oldText = dm ? left.slice(0, dm.index) : left;
    const old = parseName(oldText);
    const next = parseName(right);
    if (!old.name || old.junk || !next.name || next.junk || !(old.type || next.type)) continue;
    if (old.tokens.join(' ') === next.tokens.join(' ') && old.type === next.type) continue;
    const year = headingYear(item.headings);
    if (!year) continue;
    rows.push(row({
      list: 'streets', scope,
      old_type: old.type, old_name: tidyName(old.name), new_type: next.type, new_name: tidyName(next.name),
      district, year, act: headingAct(item.headings), src: 'wp', flags: old.part ? 'part' : '', url, fetched
    }));
  }
  return rows;
}

/** Reads `raw/wikipedia-uk-other` → rows. */
export async function parseRaw(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const fetched = manifest.files[0].fetchedAt.slice(0, 10);
  const pages = pagesOf(JSON.parse(await readFile(join(dir, 'uk-10-pages.json'), 'utf8')));
  const all = [];
  for (const page of pages) {
    const config = CITY_PAGES[page.title];
    if (!config) continue;
    const rows = parseCityPage(page, config, { fetched });
    if (page.title === 'Вулиці Дніпра') rows.push(...parseDniproLines(page, { scope: config.scope, fetched }));
    all.push(...rows);
  }
  return sortRows(all, SOURCE_SORT);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-wikipedia-cities.mjs <raw/wikipedia-uk-other> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
