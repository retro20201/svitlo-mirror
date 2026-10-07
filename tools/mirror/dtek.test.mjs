import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, upstreamBase } from './sources/dtek.mjs';
import { validate } from './lib/canonical.mjs';
import { REGIONS } from './regions.mjs';

const week = (marks = {}) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) =>
  [String(day), Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), marks[i + 1] ?? 'yes']))]));
const hours = (marks = {}) => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), marks[i + 1] ?? 'yes']));
const timeZone = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), ['', '', '']]));
const kyiv = REGIONS.find((r) => r.id === 'kyiv');

// ДТЕК Київ as published on 6 October 2026, cut down: groups «N.1» clear all week in the template,
// a leftover «1.2» row with possible hours, and a day table that uses only «N.1».
const payload = () => ({
  regionId: 'kyiv',
  fact: { data: { 1791234000: { 'GPV1.1': hours({ 17: 'no' }), 'GPV2.1': hours() } }, update: '06.10.2026 12:41', today: 1791234000 },
  preset: {
    sch_names: { 'GPV1.1': 'Черга 1.1', 'GPV1.2': 'Черга 1.2', 'GPV2.1': 'Черга 2.1', 'GPV2.2': 'Черга 2.2' },
    time_zone: timeZone,
    data: { 'GPV1.1': week(), 'GPV1.2': week({ 10: 'maybe' }), 'GPV2.1': week() }
  }
});

test('a template that marks nothing for the groups in use is dropped, and so are the old queues', () => {
  const snapshot = shape(payload(), kyiv);
  assert.deepEqual(snapshot.preset.data, {});
  assert.deepEqual(Object.keys(snapshot.preset.sch_names), ['GPV1.1', 'GPV2.1']);
  assert.equal(snapshot.fact.data[1791234000]['GPV1.1']['17'], 'no', 'the day table is untouched');
  assert.deepEqual(validate(snapshot), []);
});

test('the moment the template marks anything again, it is kept', () => {
  const marked = payload();
  marked.preset.data['GPV2.1'] = week({ 19: 'maybe' });
  const snapshot = shape(marked, kyiv);
  assert.deepEqual(Object.keys(snapshot.preset.data), ['GPV1.1', 'GPV2.1']);
});

test('a region without a pattern keeps its template and every queue', () => {
  const region = { id: 'odesa', title: 'Одеса' };
  const snapshot = shape(payload(), region);
  assert.deepEqual(Object.keys(snapshot.preset.data), ['GPV1.1', 'GPV1.2', 'GPV2.1']);
  assert.equal(Object.keys(snapshot.preset.sch_names).length, 4);
});

test('outage-data-ua is read at its newest commit, past the raw cache, and by branch if that fails', async () => {
  const sha = 'c89ea99d615f0123456789abcdef0123456789ab';
  const asked = [];
  const base = await upstreamBase(async (url, options) => { asked.push([url, options.headers.accept]); return sha + '\n'; }, 1_000_000_000);
  assert.equal(base, `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/${sha}/data`);
  assert.deepEqual(asked, [['https://api.github.com/repos/Baskerville42/outage-data-ua/commits/main', 'application/vnd.github.sha']]);
  // Within the minute the same hash serves every region, without asking again.
  assert.equal(await upstreamBase(async () => { throw new Error('asked twice'); }, 1_000_030_000), base);
  // Later, a failed lookup falls back to the branch path.
  assert.equal(
    await upstreamBase(async () => { throw new Error('403 rate limited'); }, 1_000_200_000),
    'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data'
  );
});
