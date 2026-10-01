import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFragment, hoursFromHalves, kyivDate } from './sources/poltava.mjs';

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

test('switching time is "maybe", never folded into light or dark', () => {
  const hours = hoursFromHalves(parseFragment(FRAGMENTS['16-11-2025'], '16-11-2025').halves);
  assert.equal(hours['GPV1.1']['1'], 'no');
  assert.equal(hours['GPV1.1']['2'], 'mfirst');
  // 6.1: off, possible — the dark half wins the hour.
  assert.equal(hours['GPV6.1']['1'], 'no');
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
