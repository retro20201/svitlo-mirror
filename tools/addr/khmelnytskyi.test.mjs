import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueKey, houseList, assignHouse, mergeHouse, splitLines, parseWorkbook, stableList, writeRegion, outputDir }
  from './build-khmelnytskyi.mjs';

test('a черга is read out of the operator\'s wording', () => {
  assert.equal(queueKey('1.1. підчерга'), 'GPV1.1');
  assert.equal(queueKey(' 6.2 підчерга '), 'GPV6.2');
});

test('a row that does not name a черга is refused rather than guessed', () => {
  // Inheriting the row above would put a whole street on someone else's schedule.
  assert.equal(queueKey(''), null);
  assert.equal(queueKey('уточнюється'), null);
  assert.equal(queueKey(undefined), null);
});

test('houses are split into keys the app can match exactly', () => {
  assert.deepEqual(houseList(' 1, 10, 2а, 16А '), ['1', '10', '2а', '16А']);
  assert.deepEqual(houseList('267'), ['267']);
  assert.deepEqual(houseList(', ,'), []);
});

test('a house listed twice on the same черга is not multi-line', () => {
  const map = {};
  assignHouse(map, '4', 'GPV1.1');
  assignHouse(map, '4', 'GPV1.1');
  assert.deepEqual(splitLines(map), { single: { 4: 'GPV1.1' }, lines: {} });
});

test('a house the operator puts on two черги is published as lines, not decided', () => {
  // вул. Центральна in Пирогівці really is listed under both 1.1 and 1.2, house 4 in each: a
  // building on two lines. Picking one would tell half of its flats the wrong hours.
  const map = {};
  assignHouse(map, '4', 'GPV1.1');
  assignHouse(map, '4', 'GPV1.2');
  const { single, lines } = splitLines(map);
  assert.deepEqual(lines, { 4: ['GPV1.1', 'GPV1.2'] });
  // Kept out of s/: app 1.0.2 reads s/ as the one черга of a house and must not see half of it.
  assert.deepEqual(single, {});
});

test('the черги of a multi-line house keep the order the operator first lists them in', () => {
  const map = {};
  for (const q of ['GPV2.1', 'GPV1.2', 'GPV2.1', 'GPV1.1']) assignHouse(map, '4', q);
  assert.deepEqual(map['4'], ['GPV2.1', 'GPV1.2', 'GPV1.1']);
});

test('two РЕМ files agreeing on a house, in any order, merge into it', () => {
  const map = {}, problems = { conflicts: [] };
  mergeHouse(map, '4', ['GPV1.1', 'GPV1.2'], problems, 'тест');
  mergeHouse(map, '4', ['GPV1.2', 'GPV1.1'], problems, 'тест');
  assert.equal(problems.conflicts.length, 0);
  assert.deepEqual(splitLines(map).lines, { 4: ['GPV1.1', 'GPV1.2'] });
});

test('two РЕМ files disagreeing about a house withhold it rather than call it two lines', () => {
  // Two districts each with an Антонівці and a вул. Польова are two houses, not one on two lines.
  const map = {}, problems = { conflicts: [] };
  mergeHouse(map, '1', ['GPV1.1'], problems, 'Антонівці, вул. Польова');
  mergeHouse(map, '1', ['GPV2.2'], problems, 'Антонівці, вул. Польова');
  mergeHouse(map, '1', ['GPV3.1'], problems, 'Антонівці, вул. Польова');
  assert.equal(problems.conflicts.length, 1);
  assert.deepEqual(splitLines(map), { single: {}, lines: {} });
});

const grid = (rows) => [undefined, ...rows.map((r) => [undefined, ...r])];

test('the header is located rather than assumed', () => {
  // An inserted note row above the header would otherwise shift every column by one.
  const { bySettlement } = parseWorkbook(grid([
    ['Хмельницький РЕМ (побутові споживачі)', '', '', ''],
    ['примітка від оператора', '', '', ''],
    ['Населений пункт', 'Вулиця', 'Список будинків', 'Черга/підчерга'],
    ['Антонівці', 'вул. Польова', '1, 2', '1.1. підчерга']
  ]));
  assert.deepEqual([...bySettlement.keys()], ['Антонівці']);
  assert.deepEqual(bySettlement.get('Антонівці').get('вул. Польова'), { 1: ['GPV1.1'], 2: ['GPV1.1'] });
});

test('two rows for one street are merged, keeping each row\'s черга', () => {
  const { bySettlement } = parseWorkbook(grid([
    ['Населений пункт', 'Вулиця', 'Список будинків', 'Черга/підчерга'],
    ['Пирогівці', 'вул. Центральна', '1, 4', '1.1. підчерга'],
    ['Пирогівці', 'вул. Центральна', '3, 4', '1.2. підчерга']
  ]));
  assert.deepEqual(splitLines(bySettlement.get('Пирогівці').get('вул. Центральна')), {
    single: { 1: 'GPV1.1', 3: 'GPV1.2' },
    lines: { 4: ['GPV1.1', 'GPV1.2'] }
  });
});

test('rows missing a settlement, a street or houses are skipped', () => {
  const { bySettlement, problems } = parseWorkbook(grid([
    ['Населений пункт', 'Вулиця', 'Список будинків', 'Черга/підчерга'],
    ['', 'вул. Садова', '1', '1.1. підчерга'],
    ['Лапківці', '', '1', '1.1. підчерга'],
    ['Лапківці', 'вул. Садова', '', '1.1. підчерга'],
    ['Лапківці', 'вул. Садова', '1', '']
  ]));
  assert.equal(bySettlement.size, 0);
  assert.equal(problems.noHouses, 1);
  assert.equal(problems.noQueue, 1);
});

test('a published index never changes meaning: new names go to the end', () => {
  // "вул. Березова" sorts before everything already published; slotting it in alphabetically
  // would shift every street after it, and a phone's cached list would open the wrong houses.
  const merged = stableList(['вул. Абрикосова', 'вул. Вишнева'], ['вул. Березова', 'вул. Вишнева', 'вул. Абрикосова']);
  assert.deepEqual(merged.list, ['вул. Абрикосова', 'вул. Вишнева', 'вул. Березова']);
  assert.equal(merged.added, 1);
  assert.equal(merged.gone, 0);
});

test('a name the operator stops listing keeps its slot and is not live', () => {
  const merged = stableList(['вул. Абрикосова', 'вул. Вишнева', 'вул. Гоголя'], ['вул. Гоголя', 'вул. Абрикосова']);
  assert.deepEqual(merged.list, ['вул. Абрикосова', 'вул. Вишнева', 'вул. Гоголя']);
  assert.equal(merged.live.has('вул. Вишнева'), false);
  assert.equal(merged.gone, 1);
  assert.equal(merged.added, 0);
});

test('a first run publishes the operator\'s names in the order given', () => {
  const merged = stableList([], ['вул. Абрикосова', 'вул. Вишнева']);
  assert.deepEqual(merged.list, ['вул. Абрикосова', 'вул. Вишнева']);
  assert.equal(merged.added, 2);
});

/** `{settlement: {street: {house: [черга…]}}}` → the Map-of-Maps main() hands to writeRegion. */
const region = (spec) => new Map(Object.entries(spec).map(([c, streets]) => [c, new Map(Object.entries(streets))]));
const read = (root, path) => readFile(join(root, path), 'utf8').then(JSON.parse);
const exists = (root, path) => stat(join(root, path)).then(() => true, () => false);

test('a rebuild keeps every index, empties names no longer listed and drops stale lines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'addr-khm-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeRegion(root, region({
    Пирогівці: {
      'вул. Центральна': { 1: ['GPV1.1'], 4: ['GPV1.1', 'GPV1.2'] },
      'вул. Шкільна': { 2: ['GPV2.1'], 6: ['GPV2.1', 'GPV3.2'] }
    },
    Антонівці: { 'вул. Польова': { 7: ['GPV3.1'], 9: ['GPV3.1', 'GPV4.2'] } }
  }));
  assert.deepEqual(await read(root, 'settlements.json'), ['Антонівці', 'Пирогівці']);
  assert.deepEqual(await read(root, 'c/1/streets.json'), ['вул. Центральна', 'вул. Шкільна']);
  assert.deepEqual(await read(root, 'c/1/s/0.json'), { 1: 'GPV1.1' });
  assert.deepEqual(await read(root, 'c/1/x/0.json'), { 4: ['GPV1.1', 'GPV1.2'] });
  assert.deepEqual(await read(root, 'c/1/x/1.json'), { 6: ['GPV2.1', 'GPV3.2'] });
  assert.deepEqual((await readdir(root)).sort(), ['c', 'settlements.json'], 'no temp file is left behind');
  assert.deepEqual((await readdir(join(root, 'c/1/s'))).sort(), ['0.json', '1.json']);

  // Next quarter: a new village and a new street that both sort first, вул. Шкільна gone, house 4
  // back on one line, Антонівці no longer listed at all.
  const built = await writeRegion(root, region({
    Андріївка: { 'вул. Миру': { 3: ['GPV5.1'] } },
    Пирогівці: {
      'вул. Березова': { 5: ['GPV6.2'] },
      'вул. Центральна': { 1: ['GPV1.1'], 4: ['GPV1.2'] }
    }
  }));
  assert.deepEqual(await read(root, 'settlements.json'), ['Антонівці', 'Пирогівці', 'Андріївка']);
  assert.deepEqual(await read(root, 'c/1/streets.json'), ['вул. Центральна', 'вул. Шкільна', 'вул. Березова']);
  assert.deepEqual(await read(root, 'c/1/s/0.json'), { 1: 'GPV1.1', 4: 'GPV1.2' });
  assert.equal(await exists(root, 'c/1/x/0.json'), false, 'a second черга the operator dropped');
  // A dropped street keeps its slot but not last quarter's черги: the redraw may have moved them,
  // and its old name must not keep answering with them next to the new one.
  assert.deepEqual(await read(root, 'c/1/s/1.json'), {}, 'a dropped street keeps no houses');
  assert.equal(await exists(root, 'c/1/x/1.json'), false, 'nor any lines');
  assert.deepEqual(await read(root, 'c/1/s/2.json'), { 5: 'GPV6.2' });
  // Same for a dropped village, street by street.
  assert.deepEqual(await read(root, 'c/0/streets.json'), ['вул. Польова']);
  assert.deepEqual(await read(root, 'c/0/s/0.json'), {}, 'a dropped village keeps no houses');
  assert.equal(await exists(root, 'c/0/x/0.json'), false);
  assert.deepEqual(await read(root, 'c/2/s/0.json'), { 3: 'GPV5.1' });
  assert.equal(await exists(root, 'c/2/x/0.json'), false);
  assert.deepEqual(
    { ...built, queues: [...built.queues].sort(), examples: undefined },
    {
      settlements: 3, settlementsAdded: 1, settlementsGone: 1,
      streets: 5, streetsAdded: 2, streetsGone: 2, addresses: 4, multiLine: 0,
      queues: ['GPV1.1', 'GPV1.2', 'GPV5.1', 'GPV6.2'], examples: undefined
    }
  );
});

test('a slot a dead run filled for one new village is cleared before another takes it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'addr-khm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pyrohivtsi = { 'вул. Центральна': { 1: ['GPV1.1'] } };

  await writeRegion(root, region({ Пирогівці: pyrohivtsi }));
  const published = await readFile(join(root, 'settlements.json'), 'utf8');
  // A run that adds Шумівці writes c/1/ and dies before settlements.json…
  await writeRegion(root, region({ Пирогівці: pyrohivtsi, Шумівці: { 'вул. Шкільна': { 5: ['GPV2.1'] } } }));
  await writeFile(join(root, 'settlements.json'), published, 'utf8');
  // …and by the rerun another РЕМ's file is out, so the new name in that slot is Андріївка.
  await writeRegion(root, region({ Пирогівці: pyrohivtsi, Андріївка: { 'вул. Миру': { 7: ['GPV4.2'] } } }));

  assert.deepEqual(await read(root, 'settlements.json'), ['Пирогівці', 'Андріївка']);
  assert.deepEqual(await read(root, 'c/1/streets.json'), ['вул. Миру'], 'not Шумівці\'s streets');
  assert.deepEqual(await read(root, 'c/1/s/0.json'), { 7: 'GPV4.2' });
  assert.equal(await exists(root, 'c/1/s/1.json'), false);
});

test('a published list that does not parse stops the run rather than renumbering the region', async (t) => {
  // Read as "no list yet", it would re-sort the settlements, and each would then inherit the
  // street list of whichever one used to hold its index.
  const root = await mkdtemp(join(tmpdir(), 'addr-khm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = { Пирогівці: { 'вул. Центральна': { 1: ['GPV1.1'] } }, Антонівці: { 'вул. Польова': { 7: ['GPV3.1'] } } };

  await writeRegion(root, region(spec));
  await writeFile(join(root, 'settlements.json'), '["Антонівці"', 'utf8');
  await assert.rejects(writeRegion(root, region(spec)), /settlements\.json/);
  assert.equal(await readFile(join(root, 'settlements.json'), 'utf8'), '["Антонівці"', 'left for a person to restore');
  assert.deepEqual(await read(root, 'c/0/streets.json'), ['вул. Польова']);
});

test('--only checks one РЕМ in a temp dir and never writes over the published region', async (t) => {
  // One file merged over the region would replace every shared street's houses with that РЕМ's
  // alone and publish the houses a full run withholds because two РЕМ disagree.
  const published = await outputDir(null);
  assert.ok(published.endsWith(join('firebase', 'public', 'v1', 'addr', 'khmelnytskyi')), published);
  const check = await outputDir('Шепетівський');
  t.after(() => rm(check, { recursive: true, force: true }));
  assert.notEqual(check, published);
  assert.ok(!check.includes(join('firebase', 'public')), check);
  assert.deepEqual(await readdir(check), [], 'a fresh dir, not one an earlier check filled');
});
