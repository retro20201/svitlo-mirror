/**
 * Writes every `aliases.json` next to the lists it points into:
 *
 *   v1/addr/kyiv/aliases.json                next to kyiv/streets.json               list = "streets"
 *   v1/addr/<region>/aliases.json            next to <region>/settlements.json       list = "settlements" (+ "cities")
 *   v1/addr/<region>/c/<c>/aliases.json      next to <region>/c/<c>/streets.json     list = "streets"
 *
 * from the reviewed source tables in tools/addr/aliases/sources and manual/. It reads the operator's
 * lists and never writes them: it hashes every list, `s/` and `x/` file before and after and stops if
 * one changed. Run it by hand or monthly, after `build-addresses.mjs --fresh` swaps a region (new
 * operator rows can turn a reverse entry into a forward one), and then run `write-index.mjs`.
 *
 *   node tools/addr/build-aliases.mjs [--built=2026-10-13] [--dry] [--addr=<dir>]
 *
 * `tools/addr/aliases/build-report/` (git-ignored) gets what could not be joined, what was ambiguous,
 * what was dropped and why, so nothing disappears without a line.
 */
import { readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTsv, writeTsv } from './aliases/tsv.mjs';
import { SOURCE_COLUMNS } from './aliases/rows.mjs';
import { loadOperator, hashLists, countHouses, REGION_IDS } from './aliases/operator.mjs';
import { buildAliases, serializeFile, MIN_YEAR } from './aliases/build-core.mjs';
import { buildIndex } from './write-index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ALIASES = join(HERE, 'aliases');
export const DEFAULT_ADDR = join(ROOT, 'firebase', 'public', 'v1', 'addr');

const exists = async (p) => !!(await stat(p).catch(() => null));

/** Every source table and the hand-written ones, as the builder takes them. */
export async function loadInputs(aliasesDir = ALIASES) {
  const rows = [];
  for (const f of (await readdir(join(aliasesDir, 'sources'))).sort()) {
    if (f.endsWith('.tsv')) rows.push(...(await readTsv(join(aliasesDir, 'sources', f))));
  }
  const manual = async (name) => ((await exists(join(aliasesDir, 'manual', name))) ? readTsv(join(aliasesDir, 'manual', name)) : []);
  rows.push(...(await manual('extra.tsv')).map((r) => ({ ...Object.fromEntries(SOURCE_COLUMNS.map((c) => [c, ''])), ...r, src: 'man' })));
  return { rows, joins: await manual('joins.tsv'), vetoes: await manual('vetoes.tsv'), russian: await manual('ru.tsv') };
}

/** Path of an output file under the addr dir. */
export function outputPath(addr, out) {
  if (out.kind === 'kyiv') return join(addr, 'kyiv', 'aliases.json');
  if (out.kind === 'settlements') return join(addr, out.region, 'aliases.json');
  return join(addr, out.region, 'c', String(out.c), 'aliases.json');
}

/** Atomic write, like the harvest's: a dot-file beside it, renamed over it. */
async function writeWhole(file, text) {
  const { rename } = await import('node:fs/promises');
  const temp = join(dirname(file), `.${file.split('/').pop()}.tmp`);
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

async function existingAliasFiles(addr) {
  const found = [];
  for (const id of REGION_IDS) {
    const dir = join(addr, id);
    if (await exists(join(dir, 'aliases.json'))) found.push(join(dir, 'aliases.json'));
    for (const c of await readdir(join(dir, 'c')).catch(() => [])) {
      const f = join(dir, 'c', c, 'aliases.json');
      if (await exists(f)) found.push(f);
    }
  }
  return found;
}

export const BASELINE = join(ALIASES, 'baseline.json');
/** Pairs left unmatched may grow by this much between builds before a person has to look (a source changed shape, a parser broke). */
export const UNMATCHED_GROWTH = 0.05;

export async function run({ addr = DEFAULT_ADDR, built, dry = false, aliasesDir = ALIASES, reportDir = join(ALIASES, 'build-report') } = {}) {
  const before = await hashLists(addr);
  const operator = await loadOperator(addr);
  const inputs = await loadInputs(aliasesDir);
  const houses = async (dir, i) => countHouses(dir, i);
  const { outputs, report } = await buildAliases({ operator, ...inputs, houses });

  // Every source row is either used or dropped for a named reason: nothing disappears without a line.
  const droppedTotal = Object.values(report.dropped).reduce((a, b) => a + b, 0);
  if (report.used + droppedTotal !== report.input) {
    throw new Error(`the report does not add up: ${report.used} used + ${droppedTotal} dropped is not ${report.input} source rows`);
  }

  // Region files: the settlements' own aliases, and which cities have street aliases.
  const byRegion = new Map();
  for (const o of outputs) {
    if (!byRegion.has(o.region)) byRegion.set(o.region, { settlements: null, cities: [] });
    const r = byRegion.get(o.region);
    if (o.kind === 'settlements') r.settlements = o;
    else if (o.kind === 'city') r.cities.push(o.c);
  }
  const files = [];
  for (const o of outputs) files.push({ path: outputPath(addr, o), out: o });
  for (const [region, r] of byRegion) {
    if (region === 'kyiv') continue;
    const cities = r.cities.sort((a, b) => a - b);
    if (!r.settlements) files.push({ path: join(addr, region, 'aliases.json'), out: { id: `${region}/settlements`, region, kind: 'settlements', list: operator.get(region).settlements, entries: [] } });
    const f = files.find((x) => x.out.region === region && x.out.kind === 'settlements');
    f.cities = cities;
  }

  const texts = new Map();
  for (const f of files) {
    texts.set(f.path, serializeFile({ list: f.out.list, entries: f.out.entries.map((e) => e.entry), built, cities: f.cities }));
  }

  if (!dry) {
    for (const [path, text] of texts) {
      await mkdir(dirname(path), { recursive: true });
      await writeWhole(path, text);
    }
    // A file an earlier build wrote that this build has no entries for is stale.
    for (const old of await existingAliasFiles(addr)) if (!texts.has(old)) await rm(old);
  }

  const after = await hashLists(addr);
  if (before.sha256 !== after.sha256) throw new Error('a list, s/ or x/ file changed during the build; this program must never write them');

  if (reportDir) {
    await mkdir(reportDir, { recursive: true });
    await writeTsv(join(reportDir, 'unmatched.tsv'), ['scope', 'old', 'new', 'src', 'reason'], report.unmatched);
    await writeTsv(join(reportDir, 'ambiguous.tsv'), ['scope', 'old', 'new', 'candidates'], report.ambiguous);
    await writeTsv(join(reportDir, 'dropped.tsv'), ['reason', 'scope', 'old', 'new', 'src', 'detail'], report.droppedRows);
    await writeTsv(join(reportDir, 'joined-short.tsv'), ['scope', 'new', 'row'], report.joinedShort);
    const namesakes = [];
    for (const f of files) for (const e of f.out.entries) if (e.namesake) namesakes.push({ file: f.out.id, k: e.entry.k, ty: e.entry.ty ?? '', targets: e.entry.t.length });
    await writeTsv(join(reportDir, 'namesakes.tsv'), ['file', 'k', 'ty', 'targets'], namesakes);
    await writeFile(join(reportDir, 'counts.json'), JSON.stringify({ input: report.input, used: report.used, dropped: report.dropped, perSource: report.perSource, ruAttached: report.ruAttached, notes: report.notes }, null, 1));
  }
  return { files, texts, report, before, after, minYear: MIN_YEAR };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
  const built = typeof args.built === 'string' ? args.built : new Date().toISOString().slice(0, 10);
  const addr = typeof args.addr === 'string' ? args.addr : DEFAULT_ADDR;
  const { files, report } = await run({ addr, built, dry: !!args.dry });
  const baseline = (await exists(BASELINE)) ? JSON.parse(await readFile(BASELINE, 'utf8')) : null;
  const unmatched = report.unmatched.length;
  if (baseline && unmatched > baseline.unmatched * (1 + UNMATCHED_GROWTH) && !args['update-baseline']) {
    console.error(`unmatched pairs grew from ${baseline.unmatched} to ${unmatched} (over ${UNMATCHED_GROWTH * 100}%): look at build-report/unmatched.tsv, then --update-baseline if it is right`);
    process.exitCode = 1;
  }
  if (args['update-baseline']) await writeFile(BASELINE, `${JSON.stringify({ input: report.input, used: report.used, unmatched }, null, 1)}\n`, 'utf8');
  let total = 0;
  const perRegion = new Map();
  for (const f of files) {
    const n = f.out.entries.length;
    total += n;
    perRegion.set(f.out.region, (perRegion.get(f.out.region) ?? 0) + n);
    if (n) console.log(`${f.out.id.padEnd(30)} ${String(n).padStart(5)} entries, ${f.out.entries.filter((e) => e.entry.sure).length} sure`);
  }
  console.log(`\n${total} entries in ${files.length} files; ${report.used} of ${report.input} source rows used`);
  console.log('dropped:', JSON.stringify(report.dropped));
  if (!args.dry) {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(addr, 'index.json'), JSON.stringify(await buildIndex(addr), null, 1), 'utf8');
    console.log('index.json updated');
  }
}
