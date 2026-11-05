import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAnswer, dayOfLabel, fetchRegion } from './sources/vinnytsia.mjs';
import { kyivDayStart } from './lib/canonical.mjs';

// The real answer for вулиця Магістратська 5 on 2026-10-02, out of season. In-season answers have
// not been seen yet: the ones below are built from what the site's own app.js draws, and the tests
// pin the fail-closed rules rather than any guess at real hours.
const OFF_SEASON = JSON.parse(readFileSync(new URL('./vinnytsia.fixture-offseason.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-02T09:00:00Z');
const TODAY = kyivDayStart(NOW);

function inSeason({ listnum = '1.1', cells } = {}) {
  const table = structuredClone(OFF_SEASON.tables[0]);
  table.listnum = listnum;
  table.empty = false;
  table.message = { type: 2, title: 'Застосовано ГПВ' };
  table.rows = [{ label: 'Пт 02.10', class: 'current_day', cells: cells ?? table.rows[0].cells }];
  return { ...OFF_SEASON, tables: [table] };
}

function cellsWith(byHour) {
  return Array.from({ length: 24 }, (_, h) => ({
    hour: `${String(h).padStart(2, '0')}-${String(h + 1).padStart(2, '0')}`,
    segments: byHour[h] ?? [],
    class: byHour[h] ? 'has_disconnection' : 'no_disconnection'
  }));
}

test('out of season a house names no черга, and nothing is published for it', () => {
  assert.deepEqual(parseAnswer(OFF_SEASON, '1.1', NOW), { skip: 'no outages listed' });
});

test('in season, outage segments become off half-hours of the named підчерга', () => {
  const answer = inSeason({ cells: cellsWith({
    17: [{ type: 'confirm_2', start: 0, size: 100, label: 'Заплановано' }],
    18: [{ type: 'confirm_3', start: 50, size: 50 }],
    19: [{ type: 'confirm_4', start: 0, size: 50 }]
  }) });
  const { days } = parseAnswer(answer, '1.1', NOW);
  const halves = days[TODAY];
  assert.equal(halves.length, 48);
  assert.deepEqual(halves.slice(34, 40), ['off', 'off', 'on', 'off', 'off', 'on']);
  assert.equal(halves.filter((state) => state !== 'on').length, 4);
});

test('a house the site puts in another черга publishes nothing for this one', () => {
  const answer = inSeason({ listnum: '2.1', cells: cellsWith({ 3: [{ type: 'confirm_2', start: 0, size: 100 }] }) });
  assert.deepEqual(parseAnswer(answer, '1.1', NOW), { skip: 'the site puts this house in черга 2.1' });
});

test('a черга given as a bare number is not taken for a підчерга', () => {
  const answer = inSeason({ listnum: 1, cells: cellsWith({ 3: [{ type: 'confirm_2', start: 0, size: 100 }] }) });
  assert.ok(parseAnswer(answer, '1.1', NOW).skip);
});

test('a segment kind the page did not draw reads as maybe, never as light', () => {
  const warnings = [];
  const answer = inSeason({ cells: cellsWith({ 5: [{ type: 'confirm_1', start: 0, size: 30 }] }) });
  const { days } = parseAnswer(answer, '1.1', NOW, (message) => warnings.push(message));
  assert.deepEqual(days[TODAY].slice(10, 12), ['possible', 'on']);
  assert.equal(warnings.length, 1);
});

test('a sliver under 1 % of a half does not flip it', () => {
  const answer = inSeason({ cells: cellsWith({ 7: [{ type: 'confirm_2', start: 49.5, size: 50.5 }] }) });
  assert.deepEqual(parseAnswer(answer, '1.1', NOW).days[TODAY].slice(14, 16), ['on', 'off']);
});

test('unfamiliar shapes fail the region rather than publish a guess', () => {
  assert.throws(() => parseAnswer({ ok: false, message: 'csrf' }, '1.1', NOW));
  const badHeader = inSeason();
  badHeader.tables[0].header = badHeader.tables[0].header.slice(0, 13);
  assert.throws(() => parseAnswer(badHeader, '1.1', NOW), /header/);
  const badSegment = inSeason({ cells: cellsWith({ 2: [{ type: 'confirm_2', start: 80, size: 40 }] }) });
  assert.throws(() => parseAnswer(badSegment, '1.1', NOW), /out of the hour/);
  const shortRow = inSeason({ cells: cellsWith({}).slice(0, 23) });
  assert.throws(() => parseAnswer(shortRow, '1.1', NOW), /hours/);
});

test('several addresses for one house are not guessed between', () => {
  const answer = { ...inSeason(), addresses: { a: 'one', b: 'two' } };
  assert.deepEqual(parseAnswer(answer, '1.1', NOW), { skip: 'several addresses' });
});

test('day labels take the year that puts them nearest today', () => {
  assert.equal(dayOfLabel('Пт 02.10', NOW), TODAY);
  assert.equal(dayOfLabel('Чт 01.01', new Date('2026-12-31T20:00:00Z')),
    kyivDayStart(new Date('2027-01-01T12:00:00Z')));
  assert.equal(dayOfLabel('31.02', NOW), null);
  assert.equal(dayOfLabel('завтра', NOW), null);
});

test('a cell in a shape the page does not draw fails the region instead of reading as light', () => {
  const noSegments = inSeason({ cells: cellsWith({ 3: [{ type: 'confirm_2', start: 0, size: 100 }] }) });
  delete noSegments.tables[0].rows[0].cells[17].segments;
  assert.throws(() => parseAnswer(noSegments, '1.1', NOW), /unfamiliar cell for 17-18/);
  const shifted = inSeason({ cells: cellsWith({ 3: [{ type: 'confirm_2', start: 0, size: 100 }] }) });
  shifted.tables[0].rows[0].cells[5].hour = '06-07';
  assert.throws(() => parseAnswer(shifted, '1.1', NOW), /06-07 where 05-06/);
});

test('a cell whose class says outage while its segments are empty reads as maybe, not light', () => {
  const answer = inSeason({ cells: cellsWith({ 3: [{ type: 'confirm_2', start: 0, size: 100 }] }) });
  answer.tables[0].rows[0].cells[9].class = 'has_disconnection';
  const { days } = parseAnswer(answer, '1.1', NOW, () => {});
  assert.deepEqual(days[TODAY].slice(18, 20), ['possible', 'possible']);
});

test('an answer marked empty that still draws outages is not believed', () => {
  const answer = structuredClone(OFF_SEASON);
  answer.tables[0].rows[0].cells[17].segments = [{ type: 'confirm_2', start: 0, size: 100 }];
  assert.throws(() => parseAnswer(answer, '1.1', NOW), /marked empty draws outages/);
});

/** fetchRegion against a stand-in site: the page, then one answer per house asked. */
async function offlineRun(answerFor, now = NOW) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).endsWith('search.php')) {
      return new Response('<input type="hidden" name="csrf" value="abc123">', { status: 200 });
    }
    const house = init.body.get('house_id');
    asked.push(house);
    return new Response(JSON.stringify(answerFor(house)), { status: 200 });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    return { result: await fetchRegion({ id: 'vinnytsia', title: 'Вінницька область' }, now, { wait: async () => {} }), asked };
  } catch (error) {
    return { error, asked };
  } finally {
    globalThis.fetch = real;
    console.warn = warn;
  }
}

test('out of season every house answers empty and the region publishes its queues and no day', async () => {
  const { result, asked } = await offlineRun(() => OFF_SEASON);
  assert.equal(asked.length, 16);   // "no outages" is silence, not proof: the second houses are asked too
  assert.deepEqual(result.fact.data, []);
});

test('an answer with no table for one house fails the region rather than tear a hole in the day', async () => {
  const { error } = await offlineRun((house) => (house === '41583' ? { ...OFF_SEASON, tables: [] } : OFF_SEASON));
  assert.match(error.message, /3\.1: no table/);
});

test('every house in an unexpected черга is the site renumbering, and fails the region', async () => {
  const renumbered = inSeason({ listnum: 'Черга 1.1', cells: cellsWith({ 3: [{ type: 'confirm_2', start: 0, size: 100 }] }) });
  const { error, asked } = await offlineRun(() => renumbered);
  assert.match(error.message, /every house is in an unexpected черга/);
  assert.equal(asked.length, 16);   // the four fallback houses tried too
});

// ---- The first in-season answers, read from a real browser on 2026-11-04 ----

/** An hour cell as the site really draws it: a `level` and a `label` on the segment, the type in the class. */
function realCells(byHour) {
  return Array.from({ length: 24 }, (_, h) => {
    const type = byHour[h];
    const hour = `${String(h).padStart(2, '0')}-${String(h + 1).padStart(2, '0')}`;
    return type
      ? {
        hour,
        segments: [{ start: 0, size: 100, type, level: Number(type.slice(-1)), label: `${hour.slice(0, 2)}:00-${hour.slice(0, 2)}:59` }],
        class: `has_disconnection ${type}`
      }
      : { hour, segments: [], class: 'no_disconnection' };
  });
}

function realTable(listnum, byHour) {
  const header = OFF_SEASON.tables[0].header;
  return {
    listnum,
    header,
    rows: [{ date: '2026-11-04', label: 'Ср 04.11', class: 'current_day', cells: realCells(byHour) }],
    message: { type: 1, title: 'Застосування ГПВ', queue: listnum, from: '16:00 2026.11.04', to: '18:00 2026.11.04' },
    reserve: 1,
    empty: false
  };
}

function realAnswer(...tables) {
  return { ok: true, type: 'address', addresses: [], tables };
}

const NOV4 = new Date('2026-11-04T15:30:00Z');
// Queue 2.1 on 4 November, as the site gave it: ended 02–04 and 08–10, under way 12–16, planned 20–22.
const HOURS_2_1 = { 2: 'confirm_4', 3: 'confirm_4', 8: 'confirm_4', 9: 'confirm_4', 12: 'confirm_3', 13: 'confirm_3', 14: 'confirm_3', 15: 'confirm_3', 20: 'confirm_2', 21: 'confirm_2' };
const HOURS_3_2 = { 4: 'confirm_2', 5: 'confirm_2', 8: 'confirm_4', 9: 'confirm_4', 10: 'confirm_4', 11: 'confirm_4', 16: 'confirm_3', 17: 'confirm_3', 20: 'confirm_2', 21: 'confirm_2', 22: 'confirm_2', 23: 'confirm_2' };

test('a real in-season table: ended, applied and planned hours are all outage, on the named підчерга', () => {
  const { days } = parseAnswer(realAnswer(realTable('2.1', HOURS_2_1)), '2.1', NOV4);
  const halves = days[kyivDayStart(NOV4)];
  assert.equal(halves.length, 48);
  assert.equal(halves.filter((state) => state === 'off').length, 20);
  assert.deepEqual([halves[4], halves[7], halves[8], halves[24], halves[43], halves[44]], ['off', 'off', 'on', 'off', 'off', 'on']);
});

test('a house on two черги is read from the table that names the expected one', () => {
  const answer = realAnswer(realTable('2.1', HOURS_2_1), realTable('3.2', HOURS_3_2));
  const own = parseAnswer(answer, '2.1', NOV4).days[kyivDayStart(NOV4)];
  const other = parseAnswer(answer, '3.2', NOV4).days[kyivDayStart(NOV4)];
  assert.equal(own.filter((state) => state === 'off').length, 20);
  assert.equal(other.filter((state) => state === 'off').length, 24);
});

test('two tables, none of them the expected підчерга, are not guessed between', () => {
  const answer = realAnswer(realTable('2.1', HOURS_2_1), realTable('3.2', HOURS_3_2));
  assert.deepEqual(parseAnswer(answer, '5.2', NOV4), { skip: '2 tables' });
});

test('two tables that both name the expected підчерга are not guessed between either', () => {
  const answer = realAnswer(realTable('2.1', HOURS_2_1), realTable('2.1', HOURS_3_2));
  assert.deepEqual(parseAnswer(answer, '2.1', NOV4), { skip: '2 tables' });
});

test('a house with no outage today answers empty with no черга, and publishes nothing', () => {
  const quiet = { ...realTable(null, {}), empty: true, message: { type: 3, title: 'Активних відключень не знайдено', text: '…' } };
  assert.deepEqual(parseAnswer(realAnswer(quiet), '1.1', NOV4), { skip: 'no outages listed' });
});

test('the first in-season day end to end: eight queues published, the quiet and misfiled ones left out', async () => {
  const quiet = { ...realTable(null, {}), empty: true };
  const byHouse = {
    33197: realAnswer(realTable('1.2', { 2: 'confirm_4', 14: 'confirm_3', 18: 'confirm_2' })),
    32311: realAnswer(realTable('2.1', HOURS_2_1), realTable('3.2', HOURS_3_2)),
    41583: realAnswer(realTable('3.1', HOURS_3_2)),
    31155: realAnswer({ ...realTable(null, {}), empty: true }),
    37970: realAnswer(realTable('4.1', { 4: 'confirm_2', 10: 'confirm_4' })),
    45203: realAnswer(realTable('4.2', { 4: 'confirm_2', 10: 'confirm_4' })),
    40403: realAnswer(realTable('6.1', { 0: 'confirm_4', 16: 'confirm_3' })),
    31963: realAnswer(realTable('5.2', { 0: 'confirm_4', 18: 'confirm_2' })),
    674459: realAnswer(realTable('6.1', { 0: 'confirm_4', 16: 'confirm_3' }))
  };
  const { result, error } = await offlineRun((house) => byHouse[house] ?? realAnswer(quiet), NOV4);
  assert.equal(error, undefined);
  const [today] = Object.values(result.fact.data);
  assert.deepEqual(Object.keys(today).sort(), ['GPV1.2', 'GPV2.1', 'GPV3.1', 'GPV3.2', 'GPV4.1', 'GPV4.2', 'GPV5.2', 'GPV6.1']);
});

test('a house the site calls quiet does not settle its підчерга: the next house is asked (6.2 on 5 November)', async () => {
  const quiet = { ...realTable(null, {}), empty: true };
  const byHouse = {
    640796: realAnswer(quiet),                                                          // 600-Річчя 16: «Активних відключень не знайдено»
    48390: realAnswer(realTable('6.2', { 0: 'confirm_4', 6: 'confirm_4', 10: 'confirm_2' }))   // 600-Річчя 42: a 6.2 table
  };
  const { result, error, asked } = await offlineRun((house) => byHouse[house] ?? realAnswer(quiet), NOV4);
  assert.equal(error, undefined);
  assert.ok(asked.includes('48390'));
  const [today] = Object.values(result.fact.data);
  assert.deepEqual(Object.keys(today), ['GPV6.2']);
});

test('a quiet first house and a second house the site files elsewhere publish nothing for the підчерга', async () => {
  const quiet = { ...realTable(null, {}), empty: true };
  const byHouse = { 48390: realAnswer(realTable('6.1', { 0: 'confirm_4' })) };
  const { result, error } = await offlineRun((house) => byHouse[house] ?? realAnswer(quiet), NOV4);
  assert.equal(error, undefined);
  assert.deepEqual(result.fact.data, []);
});
