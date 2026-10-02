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
async function offlineRun(answerFor) {
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
    return { result: await fetchRegion({ id: 'vinnytsia', title: 'Вінницька область' }, NOW, { wait: async () => {} }), asked };
  } catch (error) {
    return { error, asked };
  } finally {
    globalThis.fetch = real;
    console.warn = warn;
  }
}

test('out of season every house answers empty and the region publishes its queues and no day', async () => {
  const { result, asked } = await offlineRun(() => OFF_SEASON);
  assert.equal(asked.length, 12);
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
  assert.equal(asked.length, 15);   // the three fallback houses tried too
});
