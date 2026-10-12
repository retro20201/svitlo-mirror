/**
 * Two PDF tables whose text layer lists a page column by column, so the rows have to be put back
 * together from where each line sits (`pdf-layout.swift` prints it; PDFKit, macOS):
 *
 *   odesa-oda   order 830/А-2024 of the Odesa regional administration (30.08.2024): «Назва до
 *               перейменування | Назва після перейменування», under headings for the raion, the hromada
 *               and the locality (місто Одеса, село Петродолинське …)
 *   bucha       the hromada's street list of 04.09.2024: «Об'єкт | Назва актуальна | Примітки», where a
 *               note says «(перейменовано з вул. Ворошилова)»
 *
 * A locality other than the town itself becomes the scope `<region>/~<type> <name>`, resolved by the
 * builder against the operator's settlement list.
 *
 *   node tools/addr/aliases/parse-pdfs.mjs <raw root> [out.tsv]
 */
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseName, tidyName, cleanSpaces, streetTypeOf } from './text.mjs';
import { localityHeading } from './parse-councils.mjs';
import { row, SOURCE_COLUMNS, SOURCE_SORT } from './rows.mjs';
import { writeTsv, sortRows } from './tsv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `page \t column \t y \t text` lines of pdf-layout.swift → items, in reading order. */
export function layoutItems(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [page, col, y, ...rest] = line.split('\t');
    return { page: Number(page), col: Number(col), y: Number(y), text: cleanSpaces(rest.join('\t')) };
  });
}

const reading = (a, b) => a.page - b.page || b.y - a.y;
const TYPE_WORD = /^(Вулиця|Провулок|Проспект|Площа|Бульвар|Узвіз|Проїзд|Шосе|Тупик|Алея|Майдан|Набережна)(?=\s|$)/;
// Objects that are not streets still start a row, so their wrapped lines do not stick to the street above.
const OTHER_OBJECT = /^(Сквер|Парк|Пляж|Урочище|Гагарінське)(?=\s|$)/;

// ---- Odesa ODA ----------------------------------------------------------------------------

/** Pure: items of columns [old, new, full width] → source rows. */
export function parseOda(items, { url = '', fetched = '' } = {}) {
  const heads = items.filter((i) => i.col === 2 && (/^(місто|селище|село|смт)\s*\S/i.test(i.text) || /(район|ТГ)$/.test(i.text)));
  const isHeadLine = (i) => heads.some((h) => h.page === i.page && Math.abs(h.y - i.y) < 3);
  const events = [];
  const rows = [];
  // The text layer cuts a line at the column edge («стрілецької дивіз»); the full-width pass of the same page
  // has the whole line, so a cut line is completed from the line of the same height that starts with it.
  const whole = items.filter((i) => i.col === 2);
  const complete = (item) => whole.find((w) => w.page === item.page && Math.abs(w.y - item.y) < 1.5 && w.text.length > item.text.length && w.text.startsWith(item.text))?.text ?? item.text;
  for (const item of items.filter((i) => i.col === 0 && !isHeadLine(i) && (TYPE_WORD.test(i.text) || OTHER_OBJECT.test(i.text)))) {
    const r = { kind: 'row', page: item.page, y: item.y, old: complete(item), new: '', street: TYPE_WORD.test(item.text) };
    rows.push(r);
    events.push(r);
  }
  const rowAt = (page, y) => rows.find((r) => r.page === page && Math.abs(r.y - y) < 3);
  const above = (page, y) => rows.filter((r) => r.page === page && r.y > y - 1 && r.y - y < 40).sort((a, b) => a.y - b.y)[0];
  const startsRow = (text) => TYPE_WORD.test(text) || OTHER_OBJECT.test(text);
  for (const item of items.filter((i) => i.col === 1 && !isHeadLine(i)).sort(reading)) {
    const same = rowAt(item.page, item.y);
    if (same && !same.new && startsRow(item.text)) { same.new = item.text; continue; }
    // A wrapped second line of a cell.
    const owner = above(item.page, item.y);
    if (owner && !startsRow(item.text) && owner.y - item.y > 5 && item.text.length > 2) owner.new = `${owner.new} ${item.text}`;
  }
  for (const item of items.filter((i) => i.col === 0 && !isHeadLine(i) && !startsRow(i.text)).sort(reading)) {
    const owner = above(item.page, item.y);
    if (owner && owner.y - item.y > 5 && owner.y - item.y < 30 && !/^Назва/.test(item.text)) owner.old = `${owner.old} ${item.text}`;
  }
  for (const item of heads) events.push({ kind: 'head', page: item.page, y: item.y, text: item.text });
  events.sort(reading);

  const out = [];
  let scope = 'odesa/odesa';
  let hromada = '';
  let inTable = false;
  for (const e of events) {
    if (e.kind === 'head') {
      const loc = localityHeading(e.text.replace(/^(село|селище|місто|смт)(?=\S)/i, '$1 '));
      if (loc) {
        inTable = true;
        scope = loc.name === 'Одеса' && loc.type === 'м.' ? 'odesa/odesa' : `odesa/~${loc.type} ${loc.name}`;
      } else if (/(ТГ|район)$/.test(e.text)) hromada = e.text;
      continue;
    }
    if (!inTable || !e.street || !e.new) continue;
    const old = parseName(e.old);
    const next = parseName(e.new);
    if (!old.name || !next.name || old.junk || next.junk || !old.type) continue;
    out.push(row({
      list: 'streets', scope,
      old_type: old.type, old_name: tidyName(old.name), new_type: next.type, new_name: tidyName(next.name),
      district: scope === 'odesa/odesa' ? '' : hromada, year: '2024', act: 'ОДА 830/А-2024', src: 'loc', flags: old.part ? 'part' : '',
      note: '', url, fetched
    }));
  }
  return sortRows(out, SOURCE_SORT);
}

// ---- Bucha ----------------------------------------------------------------------------------

/** «вул. Піонерської» (genitive) → «Піонерська»: only the feminine adjective endings are safe to turn back. */
export function nominative(word) {
  return word.replace(/ської$/, 'ська').replace(/цької$/, 'цька').replace(/зької$/, 'зька').replace(/(?<=[бвгґджзклмнпрстфхцчшщ])ої$/, 'а').replace(/(?<=[аеєиіїоуюя])ьої$/, 'я');
}

/** The old name out of «(перейменовано з частини вул. Ворошилова відрізок …)». */
export function oldNamesFromNote(note) {
  const m = note.replace(/\s+/g, ' ').match(/перейменовано\s+(?:з|із)\s+(.+?)\)?\s*$/i);
  if (!m) return [];
  let text = m[1];
  if (/на розі|розі /i.test(text)) return [];
  const part = /(частини|відрізок|відрізку)/i.test(text);
  text = text.replace(/\s+(відрізок|ділянка|від\s).*$/i, '').replace(/^частини\s+/i, '').replace(/[«»"]/g, '');
  return text.split(/\s+та\s+|\s*,\s+/).map((piece) => {
    const p = piece.trim().replace(/^(вулиці|вул\.?|провулку|провул\.?|пров\.?|площі|пл\.?|бульвару|бульв\.?|сквер)\s+/i, (t) => `${streetTypeOf(t.trim()) || 'вул.'} `);
    const parsed = parseName(p);
    if (!parsed.name || parsed.junk) return null;
    return { type: parsed.type, name: tidyName(parsed.name.split(' ').map(nominative).join(' ')), part };
  }).filter(Boolean);
}

/** Pure: items of columns [object, name, note, full width] → source rows. */
export function parseBucha(items, { url = '', fetched = '' } = {}) {
  const rows = [];
  for (const item of items.filter((i) => i.col === 0 && /^(вулиця|провулок|площа|бульвар|проспект|проїзд|узвіз|сквер|парк)$/i.test(i.text))) {
    rows.push({ page: item.page, y: item.y, type: item.text.toLowerCase(), name: '', note: '' });
  }
  const above = (page, y) => rows.filter((r) => r.page === page && r.y > y - 2).sort((a, b) => a.y - b.y)[0];
  for (const item of items.filter((i) => i.col === 1 || i.col === 2).sort(reading)) {
    const owner = above(item.page, item.y);
    if (!owner || owner.y - item.y > 60) continue;
    if (item.col === 1) owner.name = `${owner.name} ${item.text}`.trim();
    else owner.note = `${owner.note} ${item.text}`.trim();
  }
  // Section headings: «… розташованих в селищі Ворзель».
  const heads = [];
  for (const page of [...new Set(items.map((i) => i.page))]) {
    const text = items.filter((i) => i.page === page && i.col === 3 && i.y > 740).sort(reading).map((i) => i.text).join(' ');
    const m = text.match(/розташованих\s+(?:в|у)?\s*(місті|селищі|селі)\s+(.+)$/i);
    if (m) heads.push({ page, scope: `kyiv-region/~${/місті/i.test(m[1]) ? 'м.' : /селищі/i.test(m[1]) ? 'смт' : 'с.'} ${tidyName(m[2])}` });
  }
  const out = [];
  for (const r of rows) {
    const head = heads.filter((h) => h.page <= r.page).pop();
    const scope = !head || /~м\. Буча$/.test(head.scope) ? 'kyiv-region/bucha' : head.scope;
    if (/^(сквер|парк)$/.test(r.type)) continue;
    const next = parseName(`${r.type} ${r.name}`);
    if (!next.name || next.junk) continue;
    for (const old of oldNamesFromNote(r.note)) {
      const oldType = old.type || '';
      if (parseName(old.name).tokens.join(' ') === next.tokens.join(' ') && (!oldType || oldType === next.type)) continue;
      out.push(row({
        list: 'streets', scope, old_type: oldType, old_name: old.name, new_type: next.type, new_name: tidyName(next.name),
        year: '', act: 'Бучанська МР, перелік від 04.09.2024', src: 'loc', flags: old.part ? 'part' : '', note: '', url, fetched
      }));
    }
  }
  return sortRows(out, SOURCE_SORT);
}

function layout(pdf, columns) {
  return layoutItems(execFileSync('swift', [join(HERE, 'pdf-layout.swift'), pdf, ...columns], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
}

/** Reads `raw/{odesa-oda,bucha}` (PDFs, through pdf-layout.swift) → rows. */
export async function parseRaw(root) {
  const files = async (dir) => JSON.parse(await readFile(join(root, dir, 'manifest.json'), 'utf8')).files;
  const all = [];
  for (const f of await files('odesa-oda')) {
    if (f.path.endsWith('.pdf')) all.push(...parseOda(layout(join(root, 'odesa-oda', f.path), ['40-296', '296-570', '0-600']), { url: f.url, fetched: f.fetchedAt.slice(0, 10) }));
  }
  for (const f of await files('bucha')) {
    if (f.path.endsWith('.pdf')) all.push(...parseBucha(layout(join(root, 'bucha', f.path), ['40-125', '125-285', '285-570', '0-600']), { url: f.url, fetched: f.fetchedAt.slice(0, 10) }));
  }
  return sortRows(all, SOURCE_SORT);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('usage: parse-pdfs.mjs <raw root> [out.tsv]'); process.exit(1); }
  const rows = await parseRaw(dir);
  if (out) await writeTsv(out, SOURCE_COLUMNS, rows);
  console.error(`${rows.length} rows`);
}
