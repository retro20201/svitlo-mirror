import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rowsOf, streetTitle, queueKey, buildings, buildRegion, CITY } from './build-zaporizhzhia.mjs';
import { writeRegion } from './build-khmelnytskyi.mjs';

// Rows as the operator's lookup had them on 14 November 2026 (13 063 of them), a few of each kind.
const ROWS = [
  ['Балабіне', 'Депутатська 73', '', '', ''],
  ['бул. Бельфорський (Пішохідний)', '11', '6.2', '', ''],
  ['бул. Бельфорський (Пішохідний)', '1–5', '6.2', '', ''],
  ['бул. Бельфорський (Пішохідний)', '2–6', '5.1', '', ''],
  ['бул. Вінтера', '22|24', '', '', ''],
  ['бул. Вінтера', '3', '', '', ''],
  ['бул. Вінтера', '3', '1.2', 'пн-пт 8-15', ''],
  ['бул. Будівельників', '10 п.1–2', '4.2', '', ''],
  ['бул. Будівельників', '10 п.3–5', '4.1', 'пн-пт 8-15', ''],
  ['бул. Центральний', '23', '3.1', '', ''],
  ['бул. Центральний', '23', '3.2', '', '7'],
  ['вул. Барикадна', '165-171 непарні', '2.2', '', ''],
  ['вул. Барикадна', '167', '1.1', '', ''],
  ['вул. Анатолія Солов`яненка (Адмірала Ушакова)', '166А-170', '3.1', 'пн-пт 8-15', '5'],
  ['вул.Космічна', '114 п. №1-3', '3.1', '', ''],
  ['вул. Гоголя', '149 корпус 1', '5.2', '', '']
];
const ANSWER = `)]}'\n\n${JSON.stringify([['op.exec', [0, JSON.stringify(ROWS)]], ['di', 28]])}`;

test('the page\'s answer is unwrapped into its rows, and anything else is not the table', () => {
  assert.deepEqual(rowsOf(ANSWER), ROWS);
  assert.deepEqual(rowsOf(JSON.stringify([['op.exec', [0, '[["вул. А", 7, "1.1"]]']]])), [['вул. А', '7', '1.1']], 'cells are read as text');
  assert.throws(() => rowsOf(`)]}'\n[["op.exec",[0,"{}"]]]`), /not the lookup table/u);
  assert.throws(() => rowsOf('<html>Sign in</html>'));
});

test('a street keeps its former name in brackets; a first cell that is not a street is not one', () => {
  assert.equal(streetTitle('бул. Бельфорський (Пішохідний)'), 'бул. Бельфорський (Пішохідний)');
  assert.equal(streetTitle('вул. Анатолія Солов`яненка (Адмірала Ушакова)'), 'вул. Анатолія Солов’яненка (Адмірала Ушакова)');
  assert.equal(streetTitle('вул.Космічна'), 'вул. Космічна');
  assert.equal(streetTitle('шосе Південне'), 'шосе Південне');
  for (const cell of ['Балабіне', 'Квартал №2', 'Оріхова Бухта', '']) assert.equal(streetTitle(cell), null, cell);
});

test('«3.1» is a черга, and the empty «Не вимикається» is none', () => {
  assert.equal(queueKey('3.1'), 'GPV3.1');
  for (const label of ['', 'Не вимикається', '7.1', '3', '3.3']) assert.equal(queueKey(label), null, label);
});

test('a range runs along one side of the street unless the operator says otherwise', () => {
  assert.deepEqual(buildings('1–5').houses, ['1', '3', '5']);
  assert.deepEqual(buildings('46-54|58-64').houses, ['46', '48', '50', '52', '54', '58', '60', '62', '64']);
  assert.deepEqual(buildings('2-8 парні').houses, ['2', '4', '6', '8']);
  assert.deepEqual(buildings('165-171 непарні').houses, ['165', '167', '169', '171']);
  assert.deepEqual(buildings('1-6 поспіль').houses, ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(buildings('7–10').houses, ['7', '8', '9', '10'], 'ends of different parity: every number');
  // An end with a letter is that building; the bare number beside it is not promised.
  assert.deepEqual(buildings('167а–173').houses, ['167А', '169', '171', '173']);
  assert.deepEqual(buildings('13–17Б').houses, ['13', '15', '17Б']);
  assert.deepEqual(buildings('2-1800'), { houses: [], left: ['2-1800'] }, 'a slip of the pen is not nine hundred houses');
});

test('entrances, floors and blocks of one building are that building', () => {
  assert.deepEqual(buildings('10 п.1–2').houses, ['10']);
  assert.deepEqual(buildings('114 п. №1-3').houses, ['114']);
  assert.deepEqual(buildings('85 (9 пов) під.1-3').houses, ['85']);
  assert.deepEqual(buildings('12 (під. 1, 2)|14').houses, ['12', '14'], 'the commas inside the brackets are not a list of houses');
  assert.deepEqual(buildings('50а(будинок№8)').houses, ['50А']);
});

test('a building\'s own number is kept as written, and what is no number at all is left out', () => {
  assert.deepEqual(buildings('4/1|4/2|6').houses, ['4/1', '4/2', '6']);
  assert.deepEqual(buildings('22 (1 пов),26-1,26-2 (2 пов)').houses, ['22', '26-1', '26-2'], '«26-1» is not houses 26 down to 1');
  assert.deepEqual(buildings('106/В').houses, ['106/В']);
  assert.deepEqual(buildings('123-а').houses, ['123А']);
  assert.deepEqual(buildings('21а|б|в').houses, ['21А', '21Б', '21В'], 'letters of the number before them');
  assert.deepEqual(buildings('1\\4').houses, ['1/4']);
  assert.deepEqual(buildings('7, 7 ,7').houses, ['7']);
  for (const cell of ['149 корпус 1', '119кв8', '3 блокА', '19/нов№66', 'Депутатська 73', '']) {
    assert.deepEqual(buildings(cell).houses, [], cell);
  }
  assert.deepEqual(buildings('5|149 корпус 1'), { houses: ['5'], left: ['149 корпус 1'] });
});

test('the table becomes one city: a house gets every черга its rows and ranges give it, and none from «Не вимикається»', () => {
  const { merged, dropped, left } = buildRegion(ROWS);
  assert.deepEqual([...merged.keys()], [CITY]);
  const city = merged.get(CITY);
  assert.deepEqual(city.get('бул. Бельфорський (Пішохідний)'), { 11: ['GPV6.2'], 1: ['GPV6.2'], 3: ['GPV6.2'], 5: ['GPV6.2'], 2: ['GPV5.1'], 4: ['GPV5.1'], 6: ['GPV5.1'] });
  assert.deepEqual(city.get('бул. Вінтера'), { 3: ['GPV1.2'] }, 'the черга it does have; 22 and 24 are only «Не вимикається»');
  assert.deepEqual(city.get('бул. Будівельників'), { 10: ['GPV4.2', 'GPV4.1'] }, 'two entrances on two lines');
  assert.deepEqual(city.get('бул. Центральний'), { 23: ['GPV3.1', 'GPV3.2'] });
  assert.deepEqual(city.get('вул. Барикадна'), { 165: ['GPV2.2'], 167: ['GPV2.2', 'GPV1.1'], 169: ['GPV2.2'], 171: ['GPV2.2'] }, 'a house inside a range and listed apart has both');
  assert.deepEqual(city.get('вул. Анатолія Солов’яненка (Адмірала Ушакова)'), { '166А': ['GPV3.1'], 168: ['GPV3.1'], 170: ['GPV3.1'] });
  assert.deepEqual(city.get('вул. Космічна'), { 114: ['GPV3.1'] });
  assert.equal(city.has('вул. Гоголя'), false, 'nothing read, no street');
  assert.deepEqual(dropped, { notStreet: 1, notSwitchedOff: 2, unread: 1 });
  assert.deepEqual(left, ['вул. Гоголя: 149 корпус 1']);
});

test('the dictionary is written in the shape the app reads', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'addr-zaporizhzhia-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const stats = await writeRegion(out, buildRegion(ROWS).merged);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'settlements.json'), 'utf8')), [CITY]);
  const streets = JSON.parse(await readFile(join(out, 'c', '0', 'streets.json'), 'utf8'));
  assert.equal(streets.length, 7);
  assert.equal(stats.multiLine, 3);
  const at = streets.indexOf('вул. Барикадна');
  assert.deepEqual(JSON.parse(await readFile(join(out, 'c', '0', 's', `${at}.json`), 'utf8')), { 165: 'GPV2.2', 169: 'GPV2.2', 171: 'GPV2.2' });
  assert.deepEqual(JSON.parse(await readFile(join(out, 'c', '0', 'x', `${at}.json`), 'utf8')), { 167: ['GPV2.2', 'GPV1.1'] });
});
