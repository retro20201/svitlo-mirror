import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFragment, hoursFromHalves, kyivDate, settleSwitching, fetchRegion } from './sources/poltava.mjs';
import { kyivDayStart, validate } from './lib/canonical.mjs';

// Verbatim answers of poe.pl.ua's own `newgpv-info.php`, fetched from Kyiv on 1 жовтня 2026: two
// real in-season grids, the quiet day it returned that afternoon, and the empty body it gives for
// a day not yet published.
const FRAGMENTS = JSON.parse(readFileSync(new URL('./poltava.fixture.json', import.meta.url), 'utf8'));

const offHours = (hours) => Object.fromEntries(Object.entries(hours).filter(([, state]) => state !== 'yes'));

test('a published grid becomes twelve subqueues of half-hours', () => {
  const { halves, update } = parseFragment(FRAGMENTS['16-11-2025'], '16-11-2025');
  assert.equal(Object.keys(halves).length, 12);
  assert.equal(update, '16 листопада 2025 19:34');
  // 1.1 opens the day dark for an hour, then the yellow "час на перемикання" half-hour.
  assert.deepEqual(halves['GPV1.1'].slice(0, 4), ['off', 'off', 'possible', 'on']);
});

test('the switching half-hour after a cut is the light coming back', () => {
  const hours = hoursFromHalves(parseFragment(FRAGMENTS['16-11-2025'], '16-11-2025').halves);
  assert.equal(hours['GPV1.1']['1'], 'no');
  // 1.1: dark 00:00–01:00, then the yellow half — no «можливе вимкнення» after the cut.
  assert.equal(hours['GPV1.1']['2'], 'yes');
  // 6.1: off, then the yellow half — the cut ends at 00:30, not at 01:00.
  assert.equal(hours['GPV6.1']['1'], 'first');
});

test('no «можливе» is left anywhere in a real grid', () => {
  for (const date of ['16-11-2025', '15-01-2026']) {
    const hours = hoursFromHalves(parseFragment(FRAGMENTS[date], date).halves);
    const states = new Set(Object.values(hours).flatMap((queue) => Object.values(queue)));
    assert.ok(![...states].some((state) => state.startsWith('m')), `${date}: ${[...states]}`);
  }
});

test('a yellow half that does not close a cut stays possible', () => {
  assert.deepEqual(
    settleSwitching(['possible', 'on', 'off', 'possible', 'possible', 'on', 'possible', 'on']),
    ['on', 'on', 'off', 'on', 'possible', 'on', 'possible', 'on']
  );
});

test('a second real grid parses the same way', () => {
  const hours = hoursFromHalves(parseFragment(FRAGMENTS['15-01-2026'], '15-01-2026').halves);
  assert.equal(Object.keys(hours).length, 12);
  assert.ok(Object.values(hours).every((queue) => Object.keys(offHours(queue)).length > 0));
});

test('"не прогнозується" is a quiet day, and an empty body is a day not yet published', () => {
  assert.deepEqual(parseFragment(FRAGMENTS['01-10-2026'], '01-10-2026'), { quiet: true, update: '30 вересня 2026 20:47' });
  assert.equal(parseFragment(FRAGMENTS['02-10-2026'], '02-10-2026'), null);
});

test('a fragment for a different day than the one asked for is refused', () => {
  assert.throws(() => parseFragment(FRAGMENTS['16-11-2025'], '17-11-2025'), /dated 16 листопада 2025/);
});

test('an unknown cell class fails the region instead of guessing', () => {
  const changed = FRAGMENTS['16-11-2025'].replace('class="light_2"', 'class="light_9"');
  assert.throws(() => parseFragment(changed, '16-11-2025'), /unknown cell state/);
});

test('a table missing a subqueue fails the region', () => {
  const html = FRAGMENTS['16-11-2025'];
  const lastRow = html.lastIndexOf('<tr');
  const truncated = html.slice(0, lastRow) + html.slice(html.indexOf('</tr>', lastRow) + 5);
  assert.throws(() => parseFragment(truncated, '16-11-2025'), /table names/);
});

test('the request date is the Kyiv calendar day, across midnight UTC', () => {
  // 22:30 UTC on 30 вересня is already 1 жовтня in Kyiv.
  assert.equal(kyivDate(new Date('2026-09-30T22:30:00Z')), '01-10-2026');
  assert.equal(kyivDate(new Date('2026-09-30T22:30:00Z'), 1), '02-10-2026');
});

/** fetchRegion against a stand-in poe.pl.ua: the fragment for each date asked, no network, no waiting. */
async function offlineRun(fragmentFor, now) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const date = JSON.parse(new URLSearchParams(init.body).get('seldate')).date_in;
    asked.push(date);
    return new Response(fragmentFor(date), { status: 200 });
  };
  try {
    const snapshot = await fetchRegion({ id: 'poltava', title: 'Полтавська область' }, now, { wait: async () => {} });
    return { snapshot, asked };
  } finally {
    globalThis.fetch = real;
  }
}

/** The 16 листопада grid as another day's answer, every dark cell turned light. */
const lightGrid = (date) => {
  const [day] = date.split('-');
  return FRAGMENTS['16-11-2025'].replaceAll('light_2', 'light_1').replaceAll('16 листопада 2025', `${Number(day)} листопада 2025`);
};

test('«не прогнозується» is a quiet day; an empty answer is a day not yet published', async () => {
  // The answers of 1 жовтня 2026: today quiet, tomorrow not out yet.
  const { snapshot, asked } = await offlineRun((date) => FRAGMENTS[date], new Date('2026-10-01T15:00:00+03:00'));
  assert.deepEqual(asked, ['01-10-2026', '02-10-2026']);
  assert.deepEqual(snapshot.fact.quiet, [kyivDayStart(new Date('2026-10-01T12:00:00+03:00'))]);
  assert.deepEqual(snapshot.fact.data, []);
  assert.deepEqual(validate(snapshot), []);
});

test('a grid without a dark cell is quiet too; a real grid is published as it always was', async () => {
  const grid = FRAGMENTS['16-11-2025'];
  const { snapshot } = await offlineRun((date) => (date === '16-11-2025' ? grid : lightGrid(date)), new Date('2025-11-16T12:00:00+02:00'));
  const sixteenth = kyivDayStart(new Date('2025-11-16T12:00:00+02:00'));
  const seventeenth = kyivDayStart(new Date('2025-11-17T12:00:00+02:00'));
  assert.deepEqual(snapshot.fact.quiet, [seventeenth]);
  assert.deepEqual(Object.keys(snapshot.fact.data), [String(sixteenth)]);
  assert.deepEqual(snapshot.fact.data[sixteenth], hoursFromHalves(parseFragment(grid, '16-11-2025').halves));
  assert.deepEqual(validate(snapshot), []);
});

test('days of outages and days not yet published leave the file without a quiet key', async () => {
  const outages = await offlineRun((date) => (date === '16-11-2025' ? FRAGMENTS[date] : ''), new Date('2025-11-16T12:00:00+02:00'));
  assert.equal('quiet' in outages.snapshot.fact, false);
  const nothing = await offlineRun(() => '', new Date('2026-10-02T12:00:00+03:00'));
  assert.equal('quiet' in nothing.snapshot.fact, false);
  assert.deepEqual(nothing.snapshot.fact.data, []);
});

// The page the operator put up on 27 October 2026, fetched from Kyiv the same morning (09:35): the grid is
// the same twelve rows × 48 half-hours, but each cell says what it is in `title` and the `light_N` classes
// are gone. The app stopped seeing changes until this was read (Влад's letter, 27 October).
const NEW_GRID = readFileSync(new URL('./poltava.fixture-2026-10-27.html', import.meta.url), 'utf8');

test('the grid of 27 October 2026 is read: twelve subqueues, the label off the stamp', () => {
  const { halves, update } = parseFragment(NEW_GRID, '27-10-2026');
  assert.equal(Object.keys(halves).length, 12);
  assert.ok(Object.values(halves).every((slots) => slots.length === 48));
  assert.equal(update, '27 жовтня 2026 09:35');
});

test('a cell of the new grid means what its class says, in the order its title gives', () => {
  const { halves } = parseFragment(NEW_GRID, '27-10-2026');
  // 4.2 on that day: dark 06:00–07:00, the yellow half after it, dark 11:00–12:30, yellow, dark 17:00–18:30, yellow, dark 23:30–24:00.
  const row = halves['GPV4.2'].map((state) => ({ on: '.', off: '#', possible: 'm' })[state]).join('');
  assert.equal(row, '............##m........###m........###m........#');
  assert.equal(halves['GPV4.2'][12], 'off', '06:00');
  assert.equal(halves['GPV4.2'][47], 'off', '23:30–24:00');
});

test('the new grid goes through the same rules: the yellow half after a cut is the light coming back', () => {
  const hours = hoursFromHalves(parseFragment(NEW_GRID, '27-10-2026').halves);
  assert.equal(hours['GPV4.2']['7'], 'no', '06:00–07:00');
  assert.equal(hours['GPV4.2']['8'], 'yes', 'the yellow half does not stretch the cut');
  assert.equal(validate({ regionId: 'poltava', preset: { sch_names: { a: 'a' }, time_zone: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i + 1, ['', '', '']])), data: {} }, fact: { data: { [kyivDayStart(new Date('2026-10-27T10:00:00Z'))]: hours } } }).length, 0);
});

test('a grid that misses a cell, or has them out of order, is refused rather than shifted', () => {
  const short = NEW_GRID.replace(/<td class="gpv-c [^"]*" title="1\.1: 00:30–01:00[^"]*"><\/td>/, '');
  assert.notEqual(short, NEW_GRID);
  assert.throws(() => parseFragment(short, '27-10-2026'), /out of order|cells/);
  const odd = NEW_GRID.replace(/gpv-s1( gpv-h)? gpv-past" title="2\.1: 00:00/, 'gpv-s9$1 gpv-past" title="2.1: 00:00');
  assert.notEqual(odd, NEW_GRID);
  assert.throws(() => parseFragment(odd, '27-10-2026'), /unknown cell class/);
});

test('a fragment of another day than asked is still refused with the new grid', () => {
  assert.throws(() => parseFragment(NEW_GRID, '28-10-2026'), /dated 27/);
});
