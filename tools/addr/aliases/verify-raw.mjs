/**
 * Checks a folder of raw downloads (one sub-folder per source) and prints what each holds.
 *
 *   node tools/addr/aliases/verify-raw.mjs <rawRoot> [--json] [--no-pdf]
 *
 * Per source and file: the bytes against the manifest's SHA-256, that the document is the right
 * kind and complete, and a smoke-test count of the rows a parser would find (acts: rename
 * sentences; tables: rows with two filled cells; wikitext: table rows or template calls; Overpass:
 * ways). The counts are checks that the download is real, not the parser's output — the parsers
 * are a later step and count more carefully. Nothing here executes or imports a downloaded file;
 * a PDF is read by PDFKit through pdf-text.swift (skipped with --no-pdf).
 */
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeXml, readZipEntry } from '../../lib/xlsx.mjs';
import { decodeBody, isMain, parseArgs, sha256 } from './http.mjs';
import { checkFile, FILE_SOURCES } from './fetch-files.mjs';
import { OSM_AREAS } from './fetch-osm.mjs';
import { RADA_ACTS } from './fetch-rada.mjs';
import { WIKI_SETS } from './fetch-wikipedia.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- smoke counters (pure; tested) ------------------------------------------------------------

const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

/** `&nbsp;`, `&laquo;`, `&#1030;` … → characters; an entity it does not know is left as it is. */
export function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** HTML → plain text, one line per block element. */
export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/?(br|p|div|tr|li|h\d|table)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \u00a0]+/g, ' ');
}

/** Rows of an HTML table document: cell texts per `<tr>`; rows with two or more filled cells are "pair rows". */
export function htmlTableRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) =>
    [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((td) => htmlToText(td[1]).replace(/\s+/g, ' ').trim())
  );
}

export const pairRows = (rows) => rows.filter((cells) => cells.filter((c) => /\p{L}/u.test(c)).length >= 2);

/** DOCX → rows of cell texts (every `<w:tr>`), and the count of paragraphs outside tables is not needed. */
export function docxRows(buf) {
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
  return [...xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((tr) =>
    [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) =>
      decodeXml([...tc[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(' ')).replace(/\s+/g, ' ').trim()
    )
  );
}

/** Rada act text → rename sentences "… на місто|село|селище [міського типу] Нова". */
export function radaRenames(text) {
  return (text.match(/(?<!\p{L})на\s+(?:село|селище міського типу|селище|місто)\s+\S+/gu) ?? []).length;
}

const TYPE_WORDS = /^(?:вулиця|провулок|проспект|площа|бульвар|узвіз|проїзд|тупик|шосе|набережна|сквер|міст|алея|дорога|завулок|майдан|парк)(?!\p{L})/iu;

/**
 * ODA order text → rename pairs, estimated as half the capitalised street-type words ("Вулиця",
 * "Провулок" …). The text layer runs several rows of a column into one line ("…Танцюри Вулиця
 * Генерала Ратова…"), so counting lines undercounts; every row has a type word on each side.
 */
export function odaPairs(text) {
  const words = text.match(/(?:Вулиця|Провулок|Проспект|Площа|Бульвар|Узвіз|Проїзд|Тупик|Шосе|Набережна|Сквер|Алея|Завулок|Парк|Майдан|Міст|Дорога|Лінія|Спуск)(?![а-яіїєґ'’])/gu) ?? [];
  return Math.floor(words.length / 2);
}

export const odaLocalities = (text) => text.split('\n').filter((l) => /^(?:місто|село|селище(?: міського типу)?)\s+\S/i.test(l.trim()) && !TYPE_WORDS.test(l.trim())).length;

/** Overpass answer → what the later parser will work from. */
export function osmStats(json) {
  const ways = json.elements ?? [];
  const names = new Set();
  let ru = 0, uk = 0, centred = 0;
  const keys = new Set();
  for (const w of ways) {
    const tags = w.tags ?? {};
    names.add(tags.name);
    if (w.center) centred++;
    for (const k of Object.keys(tags)) if (k.startsWith('old_name')) keys.add(k);
    if (Object.keys(tags).some((k) => /^old_name:ru/.test(k))) ru++;
    if (Object.keys(tags).some((k) => /^old_name(:uk)?($|:)/.test(k))) uk++;
  }
  return { ways: ways.length, distinctNames: names.size, withOldRu: ru, withOldUk: uk, withCenter: centred, oldNameKeys: [...keys].sort(), osmBase: json.osm3s?.timestamp_osm_base };
}

/** The text layer of a PDF through PDFKit, or null where swift is unavailable. */
export function pdfText(file) {
  const run = spawnSync('nice', ['-n', '15', 'swift', join(HERE, 'pdf-text.swift'), file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: HERE });
  if (run.status !== 0) return { text: null, pages: 0, error: (run.stderr || run.error?.message || 'swift failed').trim().split('\n').pop() };
  const pages = Number(/pages (\d+)/.exec(run.stderr)?.[1] ?? 0);
  return { text: run.stdout, pages };
}

// --- per source ---------------------------------------------------------------------------------

const readManifest = async (dir) => JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => 'null'));

async function checkIntegrity(dir, manifest, expected) {
  const problems = [];
  const files = [];
  for (const rel of expected) {
    const entry = manifest?.files.find((f) => f.path === rel);
    const buf = await readFile(join(dir, rel)).catch(() => null);
    if (!buf) { files.push({ path: rel, bytes: 0, ok: false, problems: ['missing'] }); continue; }
    const bad = [];
    if (!entry) bad.push('not in manifest');
    else if (entry.sha256 !== sha256(buf)) bad.push('SHA-256 differs from manifest');
    files.push({ path: rel, bytes: buf.length, buf, entry, ok: true, problems: bad });
  }
  for (const f of manifest?.failures ?? []) problems.push(`${f.path}: ${f.error}`);
  return { files, problems };
}

const finish = (source, files, problems, notes = []) => ({
  source,
  files: files.map(({ buf, entry, ...f }) => f),
  bytes: files.reduce((n, f) => n + f.bytes, 0),
  problems: [...problems, ...files.flatMap((f) => f.problems.map((p) => `${f.path}: ${p}`))],
  notes
});

async function verifyRada(dir) {
  const manifest = await readManifest(dir);
  const { files, problems } = await checkIntegrity(dir, manifest, Object.keys(RADA_ACTS).map((a) => `${a}.html`));
  let total = 0;
  for (const f of files) {
    if (!f.buf) continue;
    const text = htmlToText(decodeBody(f.buf));
    const act = f.path.replace('.html', '');
    const title = /№\s*([\dIVX-]+)/.exec(text)?.[1];
    f.rows = radaRenames(text);
    total += f.rows;
    f.detail = `№ ${title ?? '?'}`;
    if (title !== RADA_ACTS[act]) f.problems.push(`expected № ${RADA_ACTS[act]}, page says ${title ?? 'nothing'}`);
    if (f.rows === 0) f.problems.push('no rename sentence found');
  }
  return finish('rada', files, problems, [`${total} rename sentences across ${files.length} acts`]);
}

async function verifyWikipedia(dir, set) {
  const spec = WIKI_SETS[set];
  const manifest = await readManifest(dir);
  const { files, problems } = await checkIntegrity(dir, manifest, [spec.file]);
  const notes = [];
  for (const f of files) {
    if (!f.buf) continue;
    const json = JSON.parse(f.buf.toString('utf8'));
    const pages = json.query.pages;
    if (json.continue) f.problems.push('answer has a `continue`: more pages were not returned');
    if (json.warnings) notes.push(`API warnings: ${JSON.stringify(json.warnings).slice(0, 200)}`);
    let rows = 0, chars = 0;
    for (const p of pages) {
      const text = p.revisions[0].slots.main.content;
      chars += text.length;
      if (/^\s*#(redirect|перенаправлення)/i.test(text)) f.problems.push(`${p.title} is a redirect`);
      const kyiv = (text.match(/\{\{\s*Street-table-row-Kiev/gi) ?? []).length;
      const seeRows = (text.match(/^\*.*—\s*см\./gm) ?? []).length;
      const tableRows = (text.match(/\n\|-/g) ?? []).length;
      const n = set === 'kyiv' ? kyiv : set === 'ru-odesa' ? seeRows : tableRows;
      rows += n;
      notes.push(`${p.title.replace(/^Список вулиць Києва /, 'Київ ')}: ${text.length} chars, ${n} rows, rev ${p.revisions[0].revid} (${p.revisions[0].timestamp.slice(0, 10)})`);
    }
    f.rows = rows;
    f.detail = `${pages.length} pages, ${chars} chars`;
  }
  return finish(`wikipedia-${set}`, files, problems, set === 'uk-other' || set === 'kyiv' ? notes : notes.slice(0, 3));
}

async function verifyOsm(dir) {
  const manifest = await readManifest(dir);
  const { files, problems } = await checkIntegrity(dir, manifest, OSM_AREAS.map((a) => `${a.id}.json`));
  const notes = [];
  let ways = 0;
  for (const f of files) {
    if (!f.buf) continue;
    const json = JSON.parse(f.buf.toString('utf8'));
    const s = osmStats(json);
    f.rows = s.ways;
    ways += s.ways;
    f.detail = `${s.distinctNames} names, ${s.withOldUk} old_name(:uk), ${s.withOldRu} old_name:ru, base ${s.osmBase}${f.entry?.url ? `, ${new URL(f.entry.url).host}` : ''}`;
    if (json.remark) f.problems.push(`remark: ${json.remark}`);
    if (s.ways === 0) f.problems.push('no ways');
    if (s.withCenter !== s.ways) f.problems.push(`${s.ways - s.withCenter} ways without a center`);
    if (s.ways && f.entry?.query && f.entry.ways !== s.ways) f.problems.push('way count differs from manifest');
  }
  notes.push(`${ways} ways in ${files.filter((f) => f.buf).length} files`);
  return finish('osm', files, problems, notes);
}

async function verifyFiles(source, dir, { pdf = true } = {}) {
  const spec = FILE_SOURCES[source];
  const manifest = await readManifest(dir);
  const { files, problems } = await checkIntegrity(dir, manifest, spec.files.map((f) => f.path));
  const notes = [];
  for (const f of files) {
    if (!f.buf) continue;
    const kind = spec.files.find((x) => x.path === f.path).kind;
    const bad = checkFile(kind, f.buf);
    if (bad) f.problems.push(bad);
    if (kind === 'html') {
      const rows = htmlTableRows(decodeBody(f.buf));
      f.rows = pairRows(rows).length;
      f.detail = `${rows.length} <tr>, ${f.rows} with two filled cells`;
    } else if (kind === 'docx') {
      const rows = docxRows(f.buf);
      const filled = rows.filter((r) => r.filter(Boolean).length >= 2);
      f.rows = filled.length;
      f.detail = `${rows.length} table rows, ${filled.length} with two filled cells`;
      if (source === 'brovary') {
        // header + one row per renamed street: old name and new name in cells 3 and 4
        f.rows = rows.filter((r) => r.length === 4 && r[2] && r[3] && !/^Попереднє/.test(r[2])).length;
        f.detail = `${f.rows} old → new pairs (+ header)`;
      }
      if (source === 'khmelnytskyi') {
        // object table: № | type | name | short name | place | year | previous name(s) | previous №
        const objects = rows.filter((r) => r.length === 8 && /^\d+$/.test(r[0]));
        const renamed = objects.filter((r) => r[6]);
        f.rows = renamed.length;
        f.detail = `${objects.length} objects, ${renamed.length} with previous names, ${renamed.filter((r) => r[5] === '2026').length} dated 2026`;
      }
    } else if (kind === 'json') {
      const json = JSON.parse(f.buf.toString('utf8'));
      if (source === 'rename-dp') {
        const raions = Object.entries(json).filter(([k, v]) => /^r\d+$/.test(k) && Array.isArray(v?.objects));
        f.rows = raions.reduce((n, [, v]) => n + v.objects.length, 0);
        f.detail = `${f.rows} objects in ${raions.length} raions, lastUpdate ${new Date(Number(json.lastUpdate)).toISOString().slice(0, 10)}`;
      } else {
        f.rows = Array.isArray(json) ? json.length : Object.keys(json).length;
        f.detail = `${f.rows} entries`;
      }
    } else if (kind === 'pdf' && pdf) {
      const { text, pages, error } = pdfText(join(dir, f.path));
      if (text === null) { f.problems.push(`text layer unreadable: ${error}`); continue; }
      const letters = (text.match(/\p{L}/gu) ?? []).length;
      if (letters < 1000) f.problems.push(`only ${letters} letters in the text layer (a scan?)`);
      f.detail = `${pages} pages, ${letters} letters`;
      if (source === 'odesa-oda') { f.rows = odaPairs(text); f.detail += `, ${odaLocalities(text)} locality headings`; }
      if (source === 'bucha') { f.rows = (text.match(/перейменовано/gi) ?? []).length; f.detail += ', rows = «перейменовано» notes'; }
    }
  }
  return finish(source, files, problems, notes);
}

async function verifyBilaTserkva(dir) {
  const manifest = await readManifest(dir);
  const { files, problems } = await checkIntegrity(dir, manifest, ['node-5527.html']);
  for (const f of files) {
    if (!f.buf) continue;
    const html = decodeBody(f.buf);
    const rows = htmlTableRows(html);
    f.rows = pairRows(rows).length;
    f.detail = `${rows.length} <tr>, ${f.rows} with two filled cells, Wayback capture ${f.entry?.snapshot ?? '?'}`;
    for (const needle of ['2016', '2022', '2024']) if (!html.includes(needle)) f.problems.push(`page never mentions ${needle}`);
    if (!/перейменув/i.test(html)) f.problems.push('no word перейменув');
  }
  return finish('bila-tserkva', files, problems);
}

/** Which verifier a folder name belongs to. */
export async function verifyRoot(rawRoot, { pdf = true } = {}) {
  const out = [];
  const have = new Set(await readdir(rawRoot).catch(() => []));
  const plan = [
    ['rada', (d) => verifyRada(d)],
    ...Object.keys(WIKI_SETS).map((s) => [`wikipedia-${s}`, (d) => verifyWikipedia(d, s)]),
    ['osm', (d) => verifyOsm(d)],
    ['bila-tserkva', (d) => verifyBilaTserkva(d)],
    ...Object.keys(FILE_SOURCES).map((s) => [s, (d) => verifyFiles(s, d, { pdf })])
  ];
  for (const [name, fn] of plan) {
    if (!have.has(name)) { out.push({ source: name, files: [], bytes: 0, problems: ['folder missing'], notes: [] }); continue; }
    out.push(await fn(join(rawRoot, name)));
  }
  return out;
}

if (isMain(import.meta.url)) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional[0]) { process.stderr.write('usage: verify-raw.mjs <rawRoot> [--json] [--no-pdf]\n'); process.exit(64); }
  const report = await verifyRoot(resolve(positional[0]), { pdf: !flags['no-pdf'] });
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const s of report) {
      console.log(`\n== ${s.source}  ${s.bytes} bytes  ${s.problems.length ? `${s.problems.length} PROBLEM(S)` : 'ok'}`);
      for (const f of s.files) console.log(`   ${f.path}  ${f.bytes} B  rows=${f.rows ?? '-'}  ${f.detail ?? ''}`);
      for (const n of s.notes) console.log(`   · ${n}`);
      for (const p of s.problems) console.log(`   ! ${p}`);
    }
  }
  process.exit(report.some((s) => s.problems.length) ? 2 : 0);
}
