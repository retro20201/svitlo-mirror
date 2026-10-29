import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, MIN_AGE_MS, MAX_AGE_MS } from './lib/health-alert.mjs';

const NOW = new Date('2026-10-29T19:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const stale = (id, ms, extra = {}) => ({ id, title: id, stale: true, staleSince: ago(ms), ...extra });
const fine = (id) => ({ id, title: id, status: 'live' });
const MIN = 60 * 1000;

test('a region failing for half an hour is told once, with its name and how long', () => {
  const { messages, state } = decide([fine('kyiv'), stale('poltava', 35 * MIN, { title: 'Полтавська область' })], {}, NOW);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, '⚠️ Не читається: Полтавська область');
  assert.equal(messages[0].body, 'Уже 35 хв. У застосунку стара копія.');
  assert.deepEqual(state, { poltava: ago(35 * MIN) });
});

test('the same episode is not told again on the next cycle', () => {
  const first = decide([stale('poltava', 35 * MIN)], {}, NOW);
  const later = decide([stale('poltava', 37 * MIN)].map((row) => ({ ...row, staleSince: ago(35 * MIN) })), first.state, NOW);
  assert.deepEqual(later.messages, []);
  assert.deepEqual(later.state, first.state, 'still remembered, so it is not told when it ages past a day either');
});

test('a failure younger than half an hour is an operator\'s site having a moment', () => {
  const { messages, state } = decide([stale('poltava', MIN_AGE_MS - MIN)], {}, NOW);
  assert.deepEqual(messages, []);
  assert.deepEqual(state, {});
});

test('an episode older than a day is a known state of things — Вінниця since 16 October', () => {
  const { messages, state } = decide([stale('vinnytsia', MAX_AGE_MS + MIN)], {}, NOW);
  assert.deepEqual(messages, []);
  assert.deepEqual(state, {});
});

test('a region skipped for time, not refused, is not a failure to tell of', () => {
  const { messages } = decide([stale('odesa', 3 * 60 * MIN, { notStarted: true })], {}, NOW);
  assert.deepEqual(messages, []);
});

test('a region that reads whole again is said so once, with how long it was out', () => {
  const told = { poltava: ago(130 * MIN) };
  const { messages, state } = decide([fine('poltava')], told, NOW);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, '✅ Знову читається: poltava');
  assert.equal(messages[0].body, 'Не читалося 2.2 год.');
  assert.deepEqual(state, {});
  assert.deepEqual(decide([fine('poltava')], state, NOW).messages, [], 'and not again');
});

test('a new episode of a region told about before is told again', () => {
  const told = { poltava: ago(5 * 3600 * 1000) };
  const { messages, state } = decide([stale('poltava', 40 * MIN)], told, NOW);
  assert.equal(messages.length, 1);
  assert.equal(state.poltava, ago(40 * MIN));
});
