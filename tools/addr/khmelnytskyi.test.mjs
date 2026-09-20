import test from 'node:test';
import assert from 'node:assert/strict';
import { queueKey, houseList, assignHouse, withoutContradictions, parseWorkbook }
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

test('a house listed twice on the same черга is not a contradiction', () => {
  const map = {}, problems = { conflicts: [] };
  assignHouse(map, '4', 'GPV1.1', problems, 'тест');
  assignHouse(map, '4', 'GPV1.1', problems, 'тест');
  assert.equal(map['4'], 'GPV1.1');
  assert.equal(problems.conflicts.length, 0);
});

test('a house the operator puts on two черги is dropped, not decided', () => {
  // вул. Центральна in Пирогівці really is listed under both 1.1 and 1.2, house 4 in each.
  // Half of those people would be told the wrong hours, and they would believe it.
  const map = {}, problems = { conflicts: [] };
  assignHouse(map, '4', 'GPV1.1', problems, 'Пирогівці, вул. Центральна');
  assignHouse(map, '4', 'GPV1.2', problems, 'Пирогівці, вул. Центральна');
  assert.equal(problems.conflicts.length, 1);
  assert.deepEqual(withoutContradictions(map), {});
});

test('a third mention of an already contradicted house does not re-report it', () => {
  const map = {}, problems = { conflicts: [] };
  for (const q of ['GPV1.1', 'GPV1.2', 'GPV2.1']) assignHouse(map, '4', q, problems, 'тест');
  assert.equal(problems.conflicts.length, 1);
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
  assert.deepEqual(bySettlement.get('Антонівці').get('вул. Польова'), { 1: 'GPV1.1', 2: 'GPV1.1' });
});

test('two rows for one street are merged, keeping each row\'s черга', () => {
  const { bySettlement, problems } = parseWorkbook(grid([
    ['Населений пункт', 'Вулиця', 'Список будинків', 'Черга/підчерга'],
    ['Пирогівці', 'вул. Центральна', '1, 4', '1.1. підчерга'],
    ['Пирогівці', 'вул. Центральна', '3, 4', '1.2. підчерга']
  ]));
  const street = bySettlement.get('Пирогівці').get('вул. Центральна');
  assert.equal(problems.conflicts.length, 1);
  assert.deepEqual(withoutContradictions(street), { 1: 'GPV1.1', 3: 'GPV1.2' });
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
