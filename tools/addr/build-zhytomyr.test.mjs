import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAddressPage, decodePage, buildings, bareName, settlementTitles, buildRegion, calm, settlementName, streetTitle, NO_STREET
} from './build-zhytomyr.mjs';
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

// What the first live run (14 November 2026, 22 623 household rows) showed that the made-up rows above did not.

test('«0», «00» and «000» are the operator saying "no number", and a plot number loses its colon', () => {
  assert.deepEqual(buildings('0'), []);
  assert.deepEqual(buildings('000, 12, 00'), ['12']);
  assert.deepEqual(buildings(':1390, 156, : 1802, 10'), ['1390', '156', '1802', '10']);
  assert.deepEqual(buildings('16, :16'), ['16'], 'the same number twice is one building');
  // A two-flat house as Малин lists it is kept as written: which flat is on which line is the point.
  assert.deepEqual(buildings('98-1, 98-2'), ['98-1', '98-2']);
});

test('a name typed in capitals is calmed down, an abbreviation and a number are left alone', () => {
  assert.equal(calm('вул. ВАСИЛЯ СТУСА'), 'вул. Василя Стуса');
  assert.equal(calm('вул. 8-ГО БЕРЕЗНЯ'), 'вул. 8-го Березня');
  assert.equal(calm('вул. ГЕРОЇВ УПА'), 'вул. Героїв УПА');
  assert.equal(calm('пров. ІІ ШЕВЧЕНКА'), 'пров. ІІ Шевченка');
  assert.equal(calm('вул. Г.ЛОГАНІВСЬКА'), 'вул. Г.Логанівська');
  assert.equal(calm('вул. СІМ’Ї СОСНІНИХ'), 'вул. Сім’ї Сосніних');
  assert.equal(calm('с. ГЛИБОЧИЦЯ'), 'с. Глибочиця');
  // Nothing to calm: left exactly as written, abbreviations nobody listed included.
  assert.equal(calm('вул. Героїв УПА'), 'вул. Героїв УПА');
  assert.equal(calm('вул. ПМК-5'), 'вул. ПМК-5');
  assert.equal(calm('садове товариство "Джерело"'), 'садове товариство "Джерело"');
});

test('a street cell with «N/A» loses it, and one that names no street says so in one way', () => {
  assert.equal(streetTitle('N/A Лісова'), 'Лісова');
  assert.equal(streetTitle('N/A садове товариство "Джерело"'), 'садове товариство "Джерело"');
  assert.equal(streetTitle('N/A квартал № 47 виділ № 4'), 'квартал № 47 виділ № 4');
  for (const cell of ['N/A Не Вказано', 'вул. N/A', 'N/A N/A', 'вул. .', 'вул. не указана']) {
    assert.equal(streetTitle(cell), NO_STREET, cell);
  }
  assert.equal(streetTitle('вул.  Закам\'янська'), 'вул. Закам’янська');
  assert.equal(streetTitle('вул. 1 ЛІСНА'), 'вул. 1 Лісна');
  assert.equal(streetTitle('вул. Миру'), 'вул. Миру');
});

test('land of a village council is named as that, not as a village of the same root', () => {
  assert.equal(settlementName('с/рада Тетерівська'), 'Тетерівська сільрада');
  assert.equal(settlementName('с/рада Оліївська станція Світин'), 'Оліївська сільрада, станція Світин');
  assert.equal(settlementName('с. ОЛІЇВКА'), 'с. Оліївка');
  assert.equal(settlementName('місто Баранівка'), 'місто Баранівка');
});

test('one village under two apostrophes is one village, and its street under two is one street', () => {
  const live = page(
    row('Хорошівський', 'с. Кам’янка', 'вул. Об’їздна', '1, 2', '3', '1', home),
    row('Хорошівський', "с. Кам'янка", "вул. Об'їздна", '3', '3', '1', home),
    row('Хорошівський', "с. Кам'янка", 'N/A Не Вказано', '0', '3', '1', home),
    row('Хорошівський', "с. Кам'янка", 'вул. N/A', '7', '3', '1', home),
    row('Житомирський', 'с/рада Оліївська', 'масив Крок', '4, 000', '3', '1', home),
    row('Житомирський', 'с. ОЛІЇВКА', 'вул. ЛЕСІ УКРАЇНКИ', '5', '3', '1', home)
  );
  const { merged, dropped } = buildRegion([parseAddressPage(live)]);
  assert.deepEqual([...merged.keys()].sort(), ['Кам’янка', 'Оліївка', 'Оліївська сільрада']);
  assert.deepEqual(Object.keys(merged.get('Кам’янка').get('вул. Об’їздна')), ['1', '2', '3']);
  assert.deepEqual(Object.keys(merged.get('Кам’янка').get(NO_STREET)), ['7'], 'the row with no number at all is dropped');
  assert.equal(dropped.noHouses, 1);
  assert.deepEqual(Object.keys(merged.get('Оліївська сільрада').get('масив Крок')), ['4']);
  assert.deepEqual([...merged.get('Оліївка').keys()], ['вул. Лесі Українки']);
});
