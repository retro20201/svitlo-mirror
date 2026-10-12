/**
 * Resolutions of the Verkhovna Rada on renaming settlements (zakon.rada.gov.ua, the print view).
 * Every rename is one sentence:
 *
 *   село Жовтневе Бородянського району на село Дмитрівка;
 *   місто Орджонікідзе на місто Покров;
 *   Перейменувати місто Южне Одеського району Одеської області на місто Південне.
 *
 * under a heading «2) у Дніпропетровській області:» or with the oblast written in the sentence.
 * Only the four oblasts the operator lists are kept. The old raion becomes `district`: the operator's
 * settlement list has none, and the same old name was given to many villages («Жовтневе» to five
 * in Kyiv oblast alone).
 *
 *   node tools/addr/aliases/parse-rada.mjs <raw/rada> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToLines, htmlTitle } from './html.mjs';
import { tidyName, cleanSpaces } from './text.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

export const RADA_REGIONS = [
  [/київськ/i, 'kyiv-region'],
  [/дніпропетровськ/i, 'dnipro'],
  [/одеськ/i, 'odesa'],
  [/хмельницьк/i, 'khmelnytskyi']
];

const TYPE = '(селище\\s+міського\\s+типу|селище|село|місто|смт)';
const TYPE_KIND = (word) => (/^місто$/i.test(word) ? 'м.' : /^село$/i.test(word) ? 'с.' : 'смт');
const SENTENCE = new RegExp(`^(?:\\d+\\.\\s*)?(?:Перейменувати\\s+)?${TYPE}\\s+(.+?)\\s+на\\s+${TYPE}\\s+(.+?)\\s*[;.]?$`, 'i');

/** «Бородянського району» → «Бородянський р-н»; «Переяслав-Хмельницького району» → «Переяслав-Хмельницький р-н». */
export function raionNominative(genitive) {
  const adjective = genitive.replace(/ого$/, 'ий').replace(/ього$/, 'ій');
  return `${adjective} р-н`;
}

function regionOf(text) {
  for (const [re, id] of RADA_REGIONS) if (re.test(text)) return id;
  return '';
}

/** Splits «Червона Зірка Білянської сільської ради Липовецького району [Вінницької області]» into its parts. */
export function splitOldPart(rest) {
  let text = cleanSpaces(rest);
  let region = '';
  const oblast = text.match(/\s+(\S+ої)\s+області$/i);
  if (oblast) { region = regionOf(oblast[1]); text = text.slice(0, oblast.index); }
  let raion = '';
  const r = text.match(/\s+(\S+ого)\s+району$/i) ?? text.match(/\s+(\S+ього)\s+району$/i);
  if (r) { raion = raionNominative(r[1]); text = text.slice(0, r.index); }
  let council = '';
  const c = text.match(/\s+(\S+ої)\s+(сільської|селищної|міської)\s+(ради|територіальної\s+громади)$/i);
  if (c) { council = `${c[1]} ${c[2]} ${c[3].toLowerCase().replace(/\s+/g, ' ')}`; text = text.slice(0, c.index); }
  return { name: tidyName(text), raion, council, region };
}

/** Pure: one act's printed page → rows. */
export function parseRadaAct(html, { url = '', fetched = '' } = {}) {
  const title = htmlTitle(html);
  const m = title.match(/від\s+(\d\d)\.(\d\d)\.(\d{4})\s+№\s*([\w-]+)/);
  const year = m?.[3] ?? '';
  const act = m ? `ВРУ ${m[4]}` : '';
  const rows = [];
  let region = '';
  for (const line of htmlToLines(html)) {
    const heading = line.match(/^\d+\)\s+(?:у|в|і|й)\s+(.+?)\s+області:?$/i);
    if (heading) { region = regionOf(heading[1]); continue; }
    if (/^\d+\.\s+(Ця|Постанова)/.test(line)) { region = ''; continue; }
    const s = line.match(SENTENCE);
    if (!s) continue;
    const old = splitOldPart(s[2]);
    const next = splitOldPart(s[4]);
    const where = old.region || region || next.region;
    if (!where || !old.name || !next.name) continue;
    rows.push(row({
      list: 'settlements', scope: where,
      old_type: TYPE_KIND(s[1]), old_name: old.name, new_type: TYPE_KIND(s[3]), new_name: next.name,
      district: old.raion, year, act, src: 'vr', note: old.council, url, fetched
    }));
  }
  return sortRows(rows, SOURCE_SORT);
}

/** Reads `raw/rada` (one html per act and the manifest) → rows. */
export async function parseRaw(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const all = [];
  for (const f of manifest.files) {
    if (!f.path.endsWith('.html')) continue;
    const html = await readFile(join(dir, f.path), 'utf8');
    all.push(...parseRadaAct(html, { url: f.url.replace(/\/print$/, ''), fetched: f.fetchedAt.slice(0, 10) }));
  }
  return sortRows(all, SOURCE_SORT);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-rada.mjs <raw/rada> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
