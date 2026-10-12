/**
 * The publish gate for `aliases.json`: a non-zero exit blocks publishing. Run it after
 * `build-aliases.mjs` and before committing (the tests run it over the committed files too, so CI does).
 *
 *   node tools/addr/check-aliases.mjs [--addr=<dir>] [--against=HEAD] [--no-git]
 *
 * It checks the files as the phone reads them:
 *   schema        version, list, `n` equal to the sibling list's length, every code in `src`, `cities` both ways
 *   entries       keys of at least 3 Cyrillic letters and no placeholder names, 1 to 12 targets, every
 *                 target an index below `n` and an eligible row (never a corner record), `d` on every
 *                 target when there are two or more, every target with source codes, none resting on
 *                 rename.dp.ua alone, no entry twice, no alias of itself
 *   sure          only on a lone, unflagged target backed by an official source or by Wikipedia and OSM
 *                 together, and never on a name that is the current name of a row of the same kind
 *   size          no file over 400 KB, all of them together under 2 MB
 *   index.json    `aliases` and `aliasKeys` where there are files, and nowhere else
 *   permanence    (git) every target still points at the row it pointed at in the published copy
 *   corpus        the audit's renamed-name queries still find their street (tools/addr/aliases/corpus)
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readTsv } from './aliases/tsv.mjs';
import { readRow, REGION_IDS } from './aliases/operator.mjs';
import { nameKey, isJunkName, isCyrillicName, isPlausibleKey, letterCount, parseName } from './aliases/text.mjs';
import { queryFindsTitle } from './aliases/fold.mjs';
import { SOURCE_LEGEND, SOURCE_ORDER } from './aliases/build-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
export const DEFAULT_ADDR = join(ROOT, 'firebase', 'public', 'v1', 'addr');
export const CORPUS = join(HERE, 'aliases', 'corpus', 'rename-cases.tsv');

export const MAX_FILE_BYTES = 400 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const FLAGS = new Set(['part', 'merge', 'twin', 'both', 'retype']);
const OFFICIAL = new Set(['vr', 'loc', 'cad']);
const KINDS = new Set(['вул.', 'просп.', 'бул.', 'пров.', 'пл.', 'узвіз', 'проїзд', 'тупик', 'шосе', 'наб.', 'алея', 'майдан', 'лінія', 'м.', 'смт', 'с.', 'хут.']);

const readJSON = async (p) => JSON.parse(await readFile(p, 'utf8'));
const exists = async (p) => !!(await stat(p).catch(() => null));

/** Every aliases.json under the addr dir, with the list file beside it. */
export async function findAliasFiles(addr) {
  const found = [];
  for (const region of REGION_IDS) {
    const dir = join(addr, region);
    if (!(await exists(dir))) continue;
    if (await exists(join(dir, 'aliases.json'))) {
      found.push({ region, kind: region === 'kyiv' ? 'streets' : 'settlements', file: join(dir, 'aliases.json'), list: join(dir, region === 'kyiv' ? 'streets.json' : 'settlements.json'), rel: `${region}/aliases.json` });
    }
    for (const c of (await readdir(join(dir, 'c')).catch(() => [])).sort((a, b) => Number(a) - Number(b))) {
      const file = join(dir, 'c', c, 'aliases.json');
      if (await exists(file)) found.push({ region, kind: 'streets', c: Number(c), file, list: join(dir, 'c', c, 'streets.json'), rel: `${region}/c/${c}/aliases.json` });
    }
  }
  return found;
}

function gitShow(rev, path) {
  const r = spawnSync('git', ['show', `${rev}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

export async function checkAliases({ addr = DEFAULT_ADDR, against = 'HEAD', useGit = true, corpus = CORPUS, knownMisses = new Set() } = {}) {
  const errors = [];
  const fail = (rel, message) => errors.push(`${rel}: ${message}`);
  const stats = { files: 0, entries: 0, sure: 0, multi: 0, namesakes: 0, bytes: 0, perRegion: {} };
  const files = await findAliasFiles(addr);
  const lists = new Map(); // rel → { titles, rows }
  const loadList = async (f) => {
    if (!lists.has(f.list)) {
      const titles = await readJSON(f.list);
      const kind = f.kind === 'streets' ? 'street' : 'settlement';
      const rows = titles.map((t, i) => readRow(t, i, kind));
      const typeless = kind === 'settlement' && rows.filter((r) => r.parsed.type).length / Math.max(1, rows.length) < 0.05;
      lists.set(f.list, { titles, rows, typeless, current: new Map() });
      const entry = lists.get(f.list);
      for (const r of rows) {
        if (!r.eligible && !typeless) continue;
        const key = typeless ? nameKey(r.parsed.tokens) : r.key;
        if (!entry.current.has(key)) entry.current.set(key, []);
        entry.current.get(key).push(r);
      }
    }
    return lists.get(f.list);
  };

  const regionKeys = new Map();
  const regionFiles = new Map();
  for (const f of files) {
    const info = await stat(f.file);
    stats.files++;
    stats.bytes += info.size;
    if (info.size > MAX_FILE_BYTES) fail(f.rel, `${info.size} bytes is over the ${MAX_FILE_BYTES} limit`);
    let data;
    try { data = await readJSON(f.file); } catch (e) { fail(f.rel, `not JSON (${e.message})`); continue; }
    const list = await loadList(f);
    const n = list.titles.length;

    if (data.v !== 1) fail(f.rel, `v is ${data.v}`);
    if (data.list !== f.kind) fail(f.rel, `list is "${data.list}", the file beside it is the ${f.kind} list`);
    if (data.n !== n) fail(f.rel, `n is ${data.n}, the list has ${n} rows`);
    if (!/^\d{4}-\d\d-\d\d$/.test(data.built ?? '')) fail(f.rel, `built is "${data.built}"`);
    if (!Array.isArray(data.a)) { fail(f.rel, 'a is not an array'); continue; }
    const src = data.src && typeof data.src === 'object' ? data.src : {};
    for (const code of Object.keys(src)) if (!SOURCE_LEGEND[code]) fail(f.rel, `src has an unknown code "${code}"`);
    if (f.c === undefined && f.region !== 'kyiv') {
      if (!Array.isArray(data.cities)) fail(f.rel, 'a region file needs cities');
      else regionFiles.set(f.region, data.cities);
    } else if (data.cities !== undefined) fail(f.rel, 'only the region file has cities');

    const seen = new Set();
    let used = 0;
    for (const [at, e] of data.a.entries()) {
      const label = `${f.rel} #${at} «${e?.k}»`;
      if (!e || typeof e.k !== 'string') { fail(f.rel, `entry ${at} has no k`); continue; }
      stats.entries++;
      used++;
      if (!isCyrillicName(e.k) || letterCount(e.k) < 3) fail(label, 'a key needs at least 3 Cyrillic letters');
      if (isJunkName(e.k)) fail(label, 'a placeholder name');
      if (!isPlausibleKey(e.k)) fail(label, 'a key that is a sentence, a list or a note, not a name');
      if (e.ty !== undefined && !KINDS.has(e.ty)) fail(label, `unknown ty "${e.ty}"`);
      if (e.is !== undefined && e.is !== 'current') fail(label, `unknown is "${e.is}"`);
      if (e.sure !== undefined && e.sure !== true) fail(label, 'sure is true or absent');
      if (e.ru !== undefined && (!Array.isArray(e.ru) || e.ru.length > 4 || e.ru.some((r) => typeof r !== 'string' || !isCyrillicName(r)))) fail(label, 'ru is up to 4 Cyrillic strings');
      const dup = `${nameKey(parseName(e.k).tokens)}|${e.ty ?? ''}|${e.is ?? ''}`;
      if (seen.has(dup)) fail(label, 'the same key, kind and direction twice');
      seen.add(dup);
      if (!Array.isArray(e.t) || e.t.length < 1 || e.t.length > 12) { fail(label, `${e.t?.length} targets`); continue; }
      if (e.t.length > 1) stats.multi++;
      const keyTokens = parseName(e.k, f.kind === 'streets' ? 'street' : 'settlement').tokens;
      let official = false;
      for (const t of e.t) {
        if (!Number.isInteger(t.i) || t.i < 0 || t.i >= n) { fail(label, `target ${t.i} is outside 0..${n - 1}`); continue; }
        const row = list.rows[t.i];
        if (!list.typeless && !row.eligible) fail(label, `target ${t.i} «${row.title}» is not a street (a corner record, a society, no type)`);
        if (nameKey(row.parsed.tokens) === nameKey(keyTokens) && (!e.ty || row.parsed.type === e.ty)) fail(label, `target «${row.title}» is the key itself`);
        if (e.t.length > 1 && !(typeof t.d === 'string' && t.d.trim())) fail(label, `target ${t.i} has no d among ${e.t.length}`);
        if (t.d !== undefined && typeof t.d !== 'string') fail(label, 'd is a string');
        if (t.y !== undefined && !(Number.isInteger(t.y) && t.y >= 1900 && t.y <= 2100)) fail(label, `y ${t.y}`);
        if (t.h !== undefined && !(Number.isInteger(t.h) && t.h >= 0)) fail(label, `h ${t.h}`);
        if (t.f !== undefined && (!Array.isArray(t.f) || t.f.some((x) => !FLAGS.has(x)))) fail(label, `flags ${JSON.stringify(t.f)}`);
        if (!Array.isArray(t.s) || !t.s.length) fail(label, `target ${t.i} has no source codes`);
        else {
          for (const code of t.s) if (!src[code]) fail(label, `code "${code}" is not in src`);
          if (t.s.every((c) => c === 'rdp')) fail(label, `target ${t.i} rests on rename.dp.ua alone`);
          if (t.s.some((c) => OFFICIAL.has(c)) || (t.s.includes('wp') && t.s.includes('osm'))) official = true;
        }
      }
      // A name that is also the current name of a row of the same kind.
      const key = list.typeless ? nameKey(keyTokens) : `${e.ty ?? ''}|${nameKey(keyTokens)}`;
      const namesake = e.is !== 'current' && (list.current.has(key) || (!e.ty && !list.typeless && [...list.current.keys()].some((k) => k.endsWith(`|${nameKey(keyTokens)}`))));
      if (namesake) stats.namesakes++;
      if (e.sure) {
        stats.sure++;
        if (e.t.length !== 1) fail(label, 'sure needs exactly one target');
        else if (e.t[0].f?.length) fail(label, 'sure with a flagged target');
        if (!official) fail(label, 'sure without an official source or Wikipedia and OSM together');
        if (namesake) fail(label, 'sure on a name that is a current street of the same kind');
      }
    }
    regionKeys.set(f.region, (regionKeys.get(f.region) ?? 0) + used);
    stats.perRegion[f.rel] = used;
  }
  if (stats.bytes > MAX_TOTAL_BYTES) errors.push(`all files together are ${stats.bytes} bytes, over ${MAX_TOTAL_BYTES}`);

  // cities ↔ c/<c>/aliases.json
  for (const [region, cities] of regionFiles) {
    const have = new Set(files.filter((f) => f.region === region && f.c !== undefined).map((f) => f.c));
    for (const c of cities) if (!have.has(c)) errors.push(`${region}/aliases.json: city ${c} has no c/${c}/aliases.json`);
    for (const c of have) if (!cities.includes(c)) errors.push(`${region}/aliases.json: c/${c}/aliases.json exists but city ${c} is not in cities`);
  }
  for (const f of files) {
    if (f.c !== undefined && !regionFiles.has(f.region)) errors.push(`${f.rel}: the region has no aliases.json to list it`);
  }

  // index.json
  const indexFile = join(addr, 'index.json');
  if (await exists(indexFile)) {
    const index = await readJSON(indexFile);
    for (const [region, entry] of Object.entries(index)) {
      const keys = regionKeys.get(region);
      if (keys) {
        if (entry.aliases !== true) errors.push(`index.json: ${region} has aliases files but no "aliases": true`);
        if (entry.aliasKeys !== keys) errors.push(`index.json: ${region} aliasKeys is ${entry.aliasKeys}, the files hold ${keys}`);
      } else if ('aliases' in entry || 'aliasKeys' in entry) errors.push(`index.json: ${region} has no aliases files but carries aliases fields`);
    }
  }

  // Permanence: the published copy's targets still name the same rows.
  if (useGit) {
    const rel = (p) => p.slice(ROOT.length + 1);
    for (const f of files) {
      if (!f.file.startsWith(`${ROOT}/`)) continue; // a copy outside this checkout has no history here
      const old = gitShow(against, rel(f.file));
      if (!old) continue;
      const oldList = gitShow(against, rel(f.list));
      if (!oldList) continue;
      let oldData, oldTitles;
      try { oldData = JSON.parse(old); oldTitles = JSON.parse(oldList); } catch { continue; }
      const nowTitles = (await loadList(f)).titles;
      for (const e of oldData.a ?? []) {
        for (const t of e.t ?? []) {
          if (oldTitles[t.i] !== undefined && nowTitles[t.i] !== oldTitles[t.i]) errors.push(`${f.rel}: «${e.k}» points at ${t.i}, which was «${oldTitles[t.i]}» in ${against} and is «${nowTitles[t.i]}» now`);
        }
      }
    }
  }

  // Corpus regression.
  const corpusStats = await checkCorpus({ addr, corpus, files, knownMisses });
  stats.corpus = corpusStats.summary;
  errors.push(...corpusStats.errors);
  return { errors, stats };
}

/** Replays the audit's renamed-name queries: each must find its street among the alias targets. */
export async function checkCorpus({ addr, corpus, files, knownMisses = new Set() }) {
  const errors = [];
  if (!(await exists(corpus))) return { errors, summary: null };
  const cases = await readTsv(corpus);
  const byDir = new Map(files.map((f) => [f.file, f]));
  const rescued = [];
  const missed = [];
  for (const c of cases) {
    const [region, city] = c.list.split(':');
    const dir = join(addr, region);
    let listFile, aliasFile, vocabulary = 'street';
    if (region === 'kyiv') { listFile = join(dir, 'streets.json'); aliasFile = join(dir, 'aliases.json'); }
    else if (city) {
      const settlements = await readJSON(join(dir, 'settlements.json'));
      const squash = (s) => s.replace(/['’ʼ`]/g, '');
      const idx = settlements.findIndex((s) => squash(s) === squash(city));
      if (idx < 0) { errors.push(`corpus ${c.id}: no settlement «${city}» in ${region}`); continue; }
      listFile = join(dir, 'c', String(idx), 'streets.json');
      aliasFile = join(dir, 'c', String(idx), 'aliases.json');
    } else { listFile = join(dir, 'settlements.json'); aliasFile = join(dir, 'aliases.json'); vocabulary = 'settlement'; }
    if (!byDir.has(aliasFile)) { missed.push(c.id); continue; }
    const titles = await readJSON(listFile);
    const data = await readJSON(aliasFile);
    const expected = c.expected.split(/\s*\|\|\s*/).map((s) => s.replace(/[\s ]+/g, ' ').trim());
    let hit = false;
    for (const e of data.a) {
      const forms = [`${e.ty ?? ''} ${e.k}`, ...(e.ru ?? []).map((r) => `${e.ty ?? ''} ${r}`)];
      if (!forms.some((form) => queryFindsTitle(c.query, form, vocabulary))) continue;
      if (e.t.some((t) => expected.includes(String(titles[t.i]).replace(/[\s ]+/g, ' ').trim()))) { hit = true; break; }
    }
    (hit ? rescued : missed).push(c.id);
  }
  for (const id of missed) if (!knownMisses.has(id)) errors.push(`corpus ${id} no longer finds its street`);
  return { errors, summary: { cases: cases.length, rescued: rescued.length, missed } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
  const known = new Set();
  const knownFile = join(HERE, 'aliases', 'corpus', 'known-misses.tsv');
  if (await exists(knownFile)) for (const r of await readTsv(knownFile)) known.add(r.id);
  const { errors, stats } = await checkAliases({
    addr: typeof args.addr === 'string' ? args.addr : DEFAULT_ADDR,
    against: typeof args.against === 'string' ? args.against : 'HEAD',
    useGit: !args['no-git'],
    knownMisses: known
  });
  console.log(`${stats.files} files, ${stats.entries} entries (${stats.sure} sure, ${stats.multi} with several targets, ${stats.namesakes} namesakes), ${stats.bytes} bytes`);
  if (stats.corpus) console.log(`corpus: ${stats.corpus.rescued} of ${stats.corpus.cases} renamed-name queries find their street${stats.corpus.missed.length ? ` (missed: ${stats.corpus.missed.join(', ')})` : ''}`);
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):`);
    for (const e of errors.slice(0, 80)) console.error(`  ${e}`);
    if (errors.length > 80) console.error(`  … and ${errors.length - 80} more`);
    process.exit(1);
  }
  console.log('ok');
}
void SOURCE_ORDER;
