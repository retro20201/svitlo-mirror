import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAddressPage, decodePage, buildings, bareName, settlementTitles, buildRegion } from './build-zhytomyr.mjs';
import { writeRegion } from './build-khmelnytskyi.mjs';

// Rows as unhooking-search.php?pidcherga_id=… prints them (3 November 2026 shape), shortened.
const row = (...cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
const HEADER = row('РЕМ', 'Населений пункт', 'Назва вулиці, провулка, тощо', 'Будинки', 'Черга', 'Підчерга', 'Примітка');
const GRID = row('Черга', 'Підчерга', ...Array(48).fill('00:00-00:30'));
const page = (...rows) => `<table>${GRID}${HEADER}${rows.join('')}</table>`;
const home = 'побутові споживачі';

const PAGE_11 = page(
  row('Баранівський', 'місто Баранівка', '1 пров. Битий шлях', '7, 9, 4, 2, 6', '1', '1', home),
  row('Баранівський', 'місто Баранівка', '2 пров. Садовий', '16, 17, 42-, . , , 25, б/н, а', '1', '1', home),
  row('Баранівський', 'місто Баранівка', 'вул. Центральна', '1, 3', '1', '1', 'непобутові (юридичні) споживачі'),
  row('Звягельський', 'м. Звягель', 'вул. Шевченка', '20, 22А, 26/1', '1', '1', home),
  row('Звягельський', 'с. Березівка', 'вул. Лісова', '5', '1', '1', home),
  row('Житомирський', 'с. Березівка', 'вул. Лісова', '9', '1', '1', home)
);
const PAGE_12 = page(
  row('Звягельський', 'м. Звягель', 'вул. Шевченка', '26/1, 30', '1', '2', home),
  row('Баранівський', 'місто Баранівка', 'вул. Порожня', '', '1', '2', home)
);

test('a page gives its household address rows only, never the grid or the header', () => {
  const { rows, problems } = parseAddressPage(PAGE_11);
  assert.equal(rows.length, 5);
  assert.equal(problems.notHousehold, 1, 'a business at the same street is not read');
  assert.deepEqual(rows[0], { rem: 'Баранівський', settlement: 'місто Баранівка', street: '1 пров. Битий шлях', houses: '7, 9, 4, 2, 6', key: 'GPV1.1' });
  assert.equal(parseAddressPage(PAGE_12).rows.at(-1).key, 'GPV1.2');
  assert.equal(parseAddressPage('<p>nothing</p>').rows.length, 0);
});

test('the page is windows-1251 and is read as such', () => {
  // «Житомир» in windows-1251.
  assert.equal(decodePage(Uint8Array.from([0xc6, 0xe8, 0xf2, 0xee, 0xec, 0xe8, 0xf0])), 'Житомир');
});

test('stray pieces of a house cell are not buildings', () => {
  assert.deepEqual(buildings('16, 17, 42-, . , , 25, б/н, а, 6-А, 3а'), ['16', '17', '42', '25', '6-А', '3а']);
  assert.deepEqual(buildings(''), []);
  assert.deepEqual(buildings('7, 7, 9'), ['7', '9']);
});

test('a settlement is named without its type, and with its РЕМ only where two share the name', () => {
  assert.equal(bareName('місто Баранівка'), 'Баранівка');
  assert.equal(bareName('м. Звягель'), 'Звягель');
  assert.equal(bareName('с. Рудня'), 'Рудня');
  assert.equal(bareName('селище Нова Борова'), 'Нова Борова');
  const rows = parseAddressPage(PAGE_11).rows;
  const title = settlementTitles(rows);
  assert.equal(title(rows[0]), 'Баранівка');
  assert.equal(title(rows.find((r) => r.rem === 'Звягельський' && r.settlement.includes('Березівка'))), 'Березівка (Звягельський РЕМ)');
  assert.equal(title(rows.find((r) => r.rem === 'Житомирський')), 'Березівка (Житомирський РЕМ)');
});

test('a building listed on two підчерги has both lines, and each street keeps its own houses', () => {
  const { merged, dropped } = buildRegion([parseAddressPage(PAGE_11), parseAddressPage(PAGE_12)]);
  assert.equal(dropped.noHouses, 1);
  const zvyahel = merged.get('Звягель').get('вул. Шевченка');
  assert.deepEqual(zvyahel['26/1'], ['GPV1.1', 'GPV1.2']);
  assert.deepEqual(zvyahel['20'], ['GPV1.1']);
  assert.deepEqual(zvyahel['30'], ['GPV1.2']);
  assert.deepEqual(merged.get('Баранівка').get('2 пров. Садовий'), { 16: ['GPV1.1'], 17: ['GPV1.1'], 42: ['GPV1.1'], 25: ['GPV1.1'] });
  assert.equal(merged.get('Баранівка').has('вул. Центральна'), false);
  assert.deepEqual(Object.keys(merged.get('Березівка (Житомирський РЕМ)').get('вул. Лісова')), ['9']);
});

test('the dictionary is written in the shape the app reads, and a rebuild keeps every index', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'addr-zhytomyr-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const first = buildRegion([parseAddressPage(PAGE_11), parseAddressPage(PAGE_12)]).merged;
  const stats = await writeRegion(out, first);
  const settlements = JSON.parse(await readFile(join(out, 'settlements.json'), 'utf8'));
  assert.deepEqual(settlements, ['Баранівка', 'Березівка (Житомирський РЕМ)', 'Березівка (Звягельський РЕМ)', 'Звягель']);
  assert.equal(stats.multiLine, 1);
  const z = settlements.indexOf('Звягель');
  assert.deepEqual(JSON.parse(await readFile(join(out, 'c', String(z), 'streets.json'), 'utf8')), ['вул. Шевченка']);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'c', String(z), 's', '0.json'), 'utf8')), { 20: 'GPV1.1', '22А': 'GPV1.1', 30: 'GPV1.2' });
  assert.deepEqual(JSON.parse(await readFile(join(out, 'c', String(z), 'x', '0.json'), 'utf8')), { '26/1': ['GPV1.1', 'GPV1.2'] });

  // A new village appears, and one name sorts before everything: the old indices do not move.
  const extra = page(row('Андрушівський', 'м. Андрушівка', 'вул. Перша', '1', '2', '1', home));
  const second = buildRegion([parseAddressPage(PAGE_11), parseAddressPage(PAGE_12), parseAddressPage(extra)]).merged;
  await writeRegion(out, second);
  const again = JSON.parse(await readFile(join(out, 'settlements.json'), 'utf8'));
  assert.deepEqual(again.slice(0, 4), settlements, 'a new settlement is appended');
  assert.equal(again[4], 'Андрушівка');
});
