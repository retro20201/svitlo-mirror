import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryOf, powerOf, isRestricted, localAddrFetch, onSeveralLines } from './build-toka.mjs';

const row = { id: 1824, lat: 50.496052, lng: 30.360931, is_public: true, is_worked: true };
const detail = {
  name: ' TOKA #2212 Auchan Fast Charger ', address: 'м. Київ, вул. Берковецька, 6 ',
  ports: [{ title: 'CCS2', power: 160 }, { title: 'Type 2', power: 22 }]
};

test('a station is what the app needs of it: where, which queue, how strong', () => {
  assert.deepEqual(entryOf(row, detail, { region: 'kyiv', queue: 'GPV8.1', match: 'exact' }), {
    id: 1824, name: 'TOKA #2212 Auchan Fast Charger', address: 'м. Київ, вул. Берковецька, 6',
    lat: 50.49605, lng: 30.36093, region: 'kyiv', queue: 'GPV8.1', kw: 160, dc: true
  });
  // No queue, no address or no place on the map: not a row.
  assert.equal(entryOf(row, detail, null), null);
  assert.equal(entryOf(row, { ...detail, address: '' }, { region: 'kyiv', queue: 'GPV8.1' }), null);
  assert.equal(entryOf({ id: 1 }, detail, { region: 'kyiv', queue: 'GPV8.1' }), null);
  assert.equal(entryOf(row, { address: 'м. Київ, вул. Берковецька, 6' }, { region: 'kyiv', queue: 'GPV8.1' }).name, 'TOKA #1824');
});

test('the strongest port speaks for the station, and forty kilowatts make it a fast one', () => {
  assert.deepEqual(powerOf({ ports: [{ power: 22 }, { power: 7 }] }), { kw: 22, dc: false });
  assert.deepEqual(powerOf({ ports: [{ power: 40 }] }), { kw: 40, dc: true });
  assert.deepEqual(powerOf({ ports: [{ power: null }, {}] }), { kw: null, dc: false });
  assert.deepEqual(powerOf(undefined), { kw: null, dc: false });
});

test('a station only its residents can use is told by its name', () => {
  assert.ok(isRestricted('TOKA #1488 Kryshtalevi dzherela  [тільки для мешканців]'));
  assert.ok(isRestricted('TOKA #16 KOGA [доступ за перепускою]'));
  assert.ok(isRestricted('TOKA #77 [обмежений доступ]'));
  assert.ok(!isRestricted('TOKA #2212 Auchan Fast Charger'));
  assert.ok(!isRestricted('TOKA #300 [Peugeot]'));
});

test('the dictionary is answered from the tree, and nothing else is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ev-addr-'));
  await mkdir(join(root, 'kyiv', 's'), { recursive: true });
  await writeFile(join(root, 'kyiv', 'streets.json'), JSON.stringify(['вул. Берковецька']));
  const fetchLocal = localAddrFetch(root, 'https://example.test/v1/addr');
  const found = await fetchLocal('https://example.test/v1/addr/kyiv/streets.json');
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), ['вул. Берковецька']);
  assert.equal((await fetchLocal('https://example.test/v1/addr/kyiv/s/9.json')).status, 404);
  assert.equal((await fetchLocal('https://elsewhere.test/v1/addr/kyiv/streets.json')).status, 404);
});

test('a house the operator feeds by several lines is known by the street\'s x/ file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ev-lines-'));
  await mkdir(join(root, 'kyiv', 'x'), { recursive: true });
  await writeFile(join(root, 'kyiv', 'streets.json'), JSON.stringify(['вул. Перша', 'вул. Друга']));
  await writeFile(join(root, 'kyiv', 'x', '1.json'), JSON.stringify({ 9: ['GPV6.1', 'GPV31.1'] }));
  assert.equal(await onSeveralLines({ region: 'kyiv', street: 'вул. Друга', key: '9' }, root), true);
  assert.equal(await onSeveralLines({ region: 'kyiv', street: 'вул. Друга', key: '10' }, root), false);
  assert.equal(await onSeveralLines({ region: 'kyiv', street: 'вул. Перша', key: '9' }, root), false);
  // An oblast: the street's file is under its settlement.
  await mkdir(join(root, 'odesa', 'c', '0', 'x'), { recursive: true });
  await writeFile(join(root, 'odesa', 'settlements.json'), JSON.stringify(['м. Одеса']));
  await writeFile(join(root, 'odesa', 'c', '0', 'streets.json'), JSON.stringify(['вул. Велика Арнаутська']));
  await writeFile(join(root, 'odesa', 'c', '0', 'x', '0.json'), JSON.stringify({ 53: ['GPV4.1', 'GPV4.2'] }));
  assert.equal(await onSeveralLines({ region: 'odesa', settlement: 'м. Одеса', street: 'вул. Велика Арнаутська', key: '53' }, root), true);
  assert.equal(await onSeveralLines({ region: 'odesa', settlement: 'с. Інше', street: 'вул. Велика Арнаутська', key: '53' }, root), false);
  assert.equal(await onSeveralLines(null, root), false);
});
