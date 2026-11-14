import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kyivDayStart } from './lib/canonical.mjs';
import { dateOf, dayFile, dayTable, narrowed, noted, publishArchive, KEEP_DAYS } from './lib/archive.mjs';
import { regionFiles } from './fast-deploy.mjs';

const at = (iso) => new Date(iso);
const NOV_13 = kyivDayStart(at('2026-11-13T10:00:00Z'));
const NOV_14 = kyivDayStart(at('2026-11-14T10:00:00Z'));
const NOV_15 = kyivDayStart(at('2026-11-15T10:00:00Z'));

const hours = (off) => Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [String(hour + 1), off.includes(hour) ? 'no' : 'yes']));
/** A region file as the mirror writes it: today's table, tomorrow's when the operator has published it. */
const region = (id, days, extra = {}) => ({
  regionId: id,
  lastUpdated: '2026-11-14T09:00:00.000Z',
  fact: { data: Object.fromEntries(days.map(([day, off]) => [String(day), { 'GPV1.1': hours(off), 'GPV1.2': hours([]) }])), update: '14.11.2026 11:00', today: days[0]?.[0] ?? NOV_14, ...extra },
  preset: { sch_names: { 'GPV1.1': 'Черга 1.1', 'GPV1.2': 'Черга 1.2' }, data: {} },
  meta: { schemaVersion: '1.0.0', source: id },
  mirroredAt: '2026-11-14T09:02:00.000Z'
});

async function site() {
  const root = await mkdtemp(join(tmpdir(), 'archive-'));
  const outDir = join(root, 'tree', 'v1');
  const stateDir = join(root, 'state');
  await mkdir(outDir, { recursive: true });
  const put = (id, file) => writeFile(join(outDir, `${id}.json`), JSON.stringify(file), 'utf8');
  const cycle = (now, regions = ['zhytomyr']) => publishArchive({ outDir, stateDir, regions, now: at(now) });
  const read = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));
  return { outDir, stateDir, put, cycle, read };
}

test('a day is named by its date in Kyiv, either side of the clock change', () => {
  assert.equal(dateOf(NOV_14), '2026-11-14');
  assert.equal(dateOf(kyivDayStart(at('2026-07-01T10:00:00Z'))), '2026-07-01');
  assert.equal(dateOf(kyivDayStart(at('2026-10-25T10:00:00Z'))), '2026-10-25', 'the day of 25 hours');
});

test('a table is a day with queues in it; an empty day and ДТЕК\'s empty list are none', () => {
  assert.ok(dayTable(region('kyiv', [[NOV_14, [3]]]), NOV_14));
  assert.equal(dayTable(region('kyiv', [[NOV_14, [3]]]), NOV_15), null);
  assert.equal(dayTable({ fact: { data: [] } }, NOV_14), null);
  assert.equal(dayTable({ fact: { data: { [NOV_14]: {} } } }, NOV_14), null);
  assert.equal(dayTable({ fact: { data: { [NOV_14]: [] } } }, NOV_14), null);
  assert.equal(dayTable(null, NOV_14), null);
});

test('what is put away is the region file with that one day in it', () => {
  const file = region('zhytomyr', [[NOV_14, [8, 9]], [NOV_15, [1]]], { pendingChange: { at: 'x' }, emergency: [NOV_15], emergencyNote: 'завтра' });
  const day = narrowed(file, NOV_14, dayTable(file, NOV_14));
  assert.deepEqual(Object.keys(day.fact.data), [String(NOV_14)]);
  assert.equal(day.fact.today, NOV_14);
  assert.equal(day.fact.update, '14.11.2026 11:00');
  assert.equal(day.fact.pendingChange, undefined, 'a change still awaited is not a fact of the day');
  assert.equal(day.fact.emergency, undefined, 'tomorrow\'s emergency is not this day\'s');
  assert.equal(day.fact.emergencyNote, undefined);
  assert.deepEqual(day.preset, file.preset, 'the queues keep their names');
  const declared = narrowed({ ...file, fact: { ...file.fact, emergency: [NOV_14, NOV_15] } }, NOV_14, dayTable(file, NOV_14));
  assert.deepEqual(declared.fact.emergency, [NOV_14]);
  assert.equal(declared.fact.emergencyNote, 'завтра');
});

test('the running day is noted in its last form; an emergency once declared and a table taken down are remembered', () => {
  const morning = noted(null, region('kyiv', [[NOV_14, [8]]]), NOV_14);
  assert.equal(morning.day, NOV_14);
  assert.deepEqual([morning.emergency, morning.withdrawn], [false, false]);
  const noon = noted(morning, region('kyiv', [[NOV_14, [8, 12]]], { emergency: [NOV_14] }), NOV_14);
  assert.equal(noon.snapshot.fact.data[NOV_14]['GPV1.1']['13'], 'no', 'the later table stands');
  assert.equal(noon.emergency, true);
  const evening = noted(noon, region('kyiv', [[NOV_14, [8, 12]]]), NOV_14);
  assert.equal(evening.emergency, true, 'lifted by the evening, declared all the same');
  const gone = noted(evening, region('kyiv', []), NOV_14);
  assert.equal(gone.withdrawn, true);
  assert.deepEqual(gone.snapshot, evening.snapshot, 'the last table is kept');
  const back = noted(gone, region('kyiv', [[NOV_14, [20]]]), NOV_14);
  assert.equal(back.withdrawn, false);
  // A region file that could not be read says nothing: the note stays as it was.
  assert.deepEqual(noted(evening, null, NOV_14), evening);
  // Yesterday's note is not today's.
  assert.equal(noted(evening, region('kyiv', []), NOV_15), null);
  assert.deepEqual(dayFile(noon).archive, { date: '2026-11-14', emergency: true, withdrawn: false });
});

test('nothing is published while the day runs; the first cycle after midnight puts it away', async () => {
  const { outDir, stateDir, put, cycle, read } = await site();
  await put('zhytomyr', region('zhytomyr', [[NOV_14, [8, 9]]]));
  assert.deepEqual(await cycle('2026-11-14T09:02:00Z'), { closed: 0, offered: 0 });
  await assert.rejects(readdir(join(outDir, 'archive')), 'nothing in the tree');

  // The table changes in the afternoon, and tomorrow's appears beside it.
  await put('zhytomyr', region('zhytomyr', [[NOV_14, [8, 9, 18]], [NOV_15, [2]]]));
  assert.deepEqual(await cycle('2026-11-14T21:58:00Z'), { closed: 0, offered: 0 });

  // 00:01 in Kyiv: the region file now opens on the 15th.
  await put('zhytomyr', region('zhytomyr', [[NOV_15, [2]]]));
  assert.deepEqual(await cycle('2026-11-14T22:01:00Z'), { closed: 1, offered: 1 });
  const day = await read(outDir, 'archive', 'zhytomyr', '2026-11-14.json');
  assert.deepEqual(Object.keys(day.fact.data), [String(NOV_14)]);
  assert.equal(day.fact.data[NOV_14]['GPV1.1']['19'], 'no', 'the afternoon\'s table, not the morning\'s');
  assert.deepEqual(day.archive, { date: '2026-11-14', emergency: false, withdrawn: false });
  assert.deepEqual(await read(outDir, 'archive', 'zhytomyr', 'index.json'), { days: ['2026-11-14'] });
  assert.deepEqual(await read(stateDir, 'v1', 'zhytomyr', '2026-11-14.json'), day, 'and kept outside the tree');
  assert.equal((await read(stateDir, 'open', 'zhytomyr.json')).day, NOV_15, 'the new day is being noted');

  // The cycles after it put nothing away again, and keep offering the day.
  assert.deepEqual(await cycle('2026-11-14T22:03:00Z'), { closed: 0, offered: 1 });
});

test('the tree is cleaned every cycle: the last days and the index are laid into it again from the kept files', async () => {
  const { outDir, stateDir, put, cycle, read } = await site();
  const kept = join(stateDir, 'v1', 'zhytomyr');
  await mkdir(kept, { recursive: true });
  for (const date of ['2026-11-08', '2026-11-11', '2026-11-12', '2026-11-13']) await writeFile(join(kept, `${date}.json`), `{"archive":{"date":"${date}"}}`);
  await put('zhytomyr', region('zhytomyr', [[NOV_14, [8]]]));
  assert.deepEqual(await cycle('2026-11-14T09:00:00Z'), { closed: 0, offered: 3 });
  assert.deepEqual((await readdir(join(outDir, 'archive', 'zhytomyr'))).sort(), ['2026-11-11.json', '2026-11-12.json', '2026-11-13.json', 'index.json']);
  assert.deepEqual(await read(outDir, 'archive', 'zhytomyr', 'index.json'), { days: ['2026-11-08', '2026-11-11', '2026-11-12', '2026-11-13'] });
  // What the fast deploy carries is what is in the tree.
  const paths = (await regionFiles(outDir)).map(([path]) => path);
  assert.deepEqual(paths, [
    '/v1/zhytomyr.json',
    '/v1/archive/zhytomyr/2026-11-11.json', '/v1/archive/zhytomyr/2026-11-12.json', '/v1/archive/zhytomyr/2026-11-13.json', '/v1/archive/zhytomyr/index.json'
  ]);
});

test('a day with no table makes no file, and a region the server was away from for days is put away under its own date', async () => {
  const { outDir, stateDir, put, cycle, read } = await site();
  await put('lviv', region('lviv', []));
  await put('zhytomyr', region('zhytomyr', [[NOV_13, [5]]]));
  await cycle('2026-11-13T12:00:00Z', ['lviv', 'zhytomyr']);
  // Nothing runs on the 14th; the next cycle is on the 15th.
  await put('zhytomyr', region('zhytomyr', [[NOV_15, [7]]]));
  assert.deepEqual(await cycle('2026-11-15T06:00:00Z', ['lviv', 'zhytomyr']), { closed: 1, offered: 1 });
  assert.deepEqual(await read(outDir, 'archive', 'zhytomyr', 'index.json'), { days: ['2026-11-13'] });
  await assert.rejects(readdir(join(stateDir, 'v1', 'lviv')), 'no table, no file');
  await assert.rejects(readFile(join(stateDir, 'open', 'lviv.json'), 'utf8'));
});

test('a table taken down before midnight is put away as the last one seen, and says so', async () => {
  const { outDir, put, cycle, read } = await site();
  await put('zhytomyr', region('zhytomyr', [[NOV_14, [8, 9]]], { emergency: [NOV_14], emergencyNote: 'аварійні відключення' }));
  await cycle('2026-11-14T09:00:00Z');
  await put('zhytomyr', region('zhytomyr', []));
  await cycle('2026-11-14T15:00:00Z');
  await cycle('2026-11-14T22:05:00Z');
  const day = await read(outDir, 'archive', 'zhytomyr', '2026-11-14.json');
  assert.deepEqual(day.archive, { date: '2026-11-14', emergency: true, withdrawn: true });
  assert.equal(day.fact.data[NOV_14]['GPV1.1']['9'], 'no');
  assert.deepEqual(day.fact.emergency, [NOV_14]);
  assert.equal(day.fact.emergencyNote, 'аварійні відключення');
});

test('days older than the keeping are dropped from the store and from the index', async () => {
  const { stateDir, put, cycle, read } = await site();
  const kept = join(stateDir, 'v1', 'zhytomyr');
  await mkdir(kept, { recursive: true });
  const old = dateOf(NOV_14 - (KEEP_DAYS + 2) * 86400);
  const inside = dateOf(NOV_14 - (KEEP_DAYS - 2) * 86400);
  await writeFile(join(kept, `${old}.json`), '{}');
  await writeFile(join(kept, `${inside}.json`), '{}');
  await put('zhytomyr', region('zhytomyr', [[NOV_14, [8]]]));
  await cycle('2026-11-14T09:00:00Z');
  assert.deepEqual(await read(kept, 'index.json'), { days: [inside] });
  assert.deepEqual((await readdir(kept)).sort(), [`${inside}.json`, 'index.json']);
});
