import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLocations, keysOf, merge, countHouses } from './build-cek.mjs';
import { writeRegion } from './build-khmelnytskyi.mjs';

// The page of ПрАТ «ПЕЕМ «ЦЕК» with the table of the lookup form inlined in a script, cut down to a few streets of the real one
// (checked 10 November 2026: 14 settlements, 442 streets, 9 065 houses).
const locations = {
  'м. Дніпро': {
    'пров. Енергетичний': { 1: 'Черга 5.2', 2: 'Черга 5.2', 3: 'Черга 2', 4: 'Група 5.1 (АТ "ДТЕК ДЕМ")' },
    'вул. Центральна': { 7: 'Черга 1.1', 9: 'Черга 2.1 та 6.1' }
  },
  'м. Жовті Води': {
    'бульв. Свободи': { 43: 'Черга 4.1', 45: 'Черга 6.1 та 2.1', 47: 'уточнюється' }
  },
  'с. Петриківка': { 'вул. Козацька': { 1: '4.1' } }
};
const PAGE = `<html><head><script>function x() {}</script><script>
const locations = ${JSON.stringify(locations)};
function filterCity() { const input = 1; }
</script></head></html>`;

test('the table is taken out of the page\'s script', () => {
  assert.deepEqual(parseLocations(PAGE), locations);
});

test('a page without the table, or with one that is not JSON, is refused with a reason', () => {
  assert.throws(() => parseLocations('<html>нова сторінка</html>'), /немає const locations/);
  assert.throws(() => parseLocations('<script>\nconst locations = {"м. Дніпро": {oops}};\n</script>'), /не розбирається/);
});

test('the operator\'s wording of a queue becomes the keys of the schedule', () => {
  assert.deepEqual(keysOf('Черга 1.1'), ['GPV1.1']);
  assert.deepEqual(keysOf('4.1'), ['GPV4.1']);
  assert.deepEqual(keysOf(' Черга  6.2 '), ['GPV6.2']);
  assert.deepEqual(keysOf('Черга 2.1 та 6.1'), ['GPV2.1', 'GPV6.1'], 'a house on two lines');
  assert.deepEqual(keysOf('Черга 6.1 та 2.1'), ['GPV6.1', 'GPV2.1'], 'in the operator\'s order');
  assert.deepEqual(keysOf('Черга 1.2 та 3.1'), ['GPV1.2', 'GPV3.1']);
  assert.deepEqual(keysOf('Черга 2.1 та 2.1'), ['GPV2.1'], 'a queue named twice is one');
});

test('a whole «Черга N» is both its sub-queues: they differ on some days, so neither one alone is the house\'s', () => {
  assert.deepEqual(keysOf('Черга 2'), ['GPV2.1', 'GPV2.2']);
  assert.deepEqual(keysOf('Черга 6'), ['GPV6.1', 'GPV6.2']);
});

test('ДТЕК\'s groups, and wording that is not a queue, are not guessed at', () => {
  assert.equal(keysOf('Група 5.1 (АТ "ДТЕК ДЕМ")'), null);
  assert.equal(keysOf('уточнюється'), null);
  assert.equal(keysOf('Черга 7.1'), null, 'there is no queue 7');
  assert.equal(keysOf('Черга 2.3'), null);
  assert.equal(keysOf(''), null);
  assert.equal(keysOf(undefined), null);
});

test('the dictionary keeps what it can read and counts what it leaves out', () => {
  const { merged, problems } = merge(locations);
  assert.deepEqual([...merged.keys()], ['м. Дніпро', 'м. Жовті Води', 'с. Петриківка']);
  assert.deepEqual(merged.get('м. Дніпро').get('пров. Енергетичний'), { 1: ['GPV5.2'], 2: ['GPV5.2'], 3: ['GPV2.1', 'GPV2.2'] });
  assert.deepEqual(merged.get('м. Жовті Води').get('бульв. Свободи'), { 43: ['GPV4.1'], 45: ['GPV6.1', 'GPV2.1'] });
  assert.equal(problems.dtek, 1);
  assert.equal(problems.unreadable.length, 1);
  assert.match(problems.unreadable[0], /уточнюється/);
  assert.equal(countHouses(merged), 8);
});

test('a street whose every house is left out is not a street of the dictionary', () => {
  const { merged, problems } = merge({ 'м. Дніпро': { 'вул. Порожня': { 1: 'Група 3.1 (АТ "ДТЕК ДЕМ")' } , 'вул. Є': { 1: 'Черга 1.1' } } });
  assert.deepEqual([...merged.get('м. Дніпро').keys()], ['вул. Є']);
  assert.equal(problems.emptyStreets, 1);
});

test('written out, a house on one queue is in s/ and a house on several is in x/ alone', async () => {
  const out = await mkdtemp(join(tmpdir(), 'addr-cek-'));
  try {
    const { merged } = merge(locations);
    const stats = await writeRegion(out, merged);
    const read = async (file) => JSON.parse(await readFile(join(out, file), 'utf8'));
    assert.deepEqual(await read('settlements.json'), ['м. Дніпро', 'м. Жовті Води', 'с. Петриківка']);
    assert.deepEqual(await read('c/0/streets.json'), ['вул. Центральна', 'пров. Енергетичний']);
    // вул. Центральна: 7 on one queue, 9 on two
    assert.deepEqual(await read('c/0/s/0.json'), { 7: 'GPV1.1' });
    assert.deepEqual(await read('c/0/x/0.json'), { 9: ['GPV2.1', 'GPV6.1'] });
    // пров. Енергетичний: 1, 2 on 5.2; 3 on both 2.x
    assert.deepEqual(await read('c/0/s/1.json'), { 1: 'GPV5.2', 2: 'GPV5.2' });
    assert.deepEqual(await read('c/0/x/1.json'), { 3: ['GPV2.1', 'GPV2.2'] });
    assert.equal(stats.multiLine, 3);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
