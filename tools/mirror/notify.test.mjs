import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affectsSchedule, topicFor } from './lib/notify.mjs';

// This predicate decides whether to wake every phone in an oblast. Getting it wrong in one
// direction spams people; in the other it leaves their alerts armed against yesterday's plan.

// Only today and later count, so a test about day 1787691600 (26 серпня 2026) runs on that day.
const ON_THE_DAY = new Date('2026-08-26T08:00:00Z');

test('a changed published schedule is worth a wake-up', () => {
  assert.equal(
    affectsSchedule({ fact: { data: [] } }, { fact: { data: { 1787691600: { 'GPV1.1': {} } } } }, ON_THE_DAY),
    true
  );
});

test('a revised day is worth a wake-up', () => {
  const before = { fact: { data: { 1787691600: { 'GPV1.1': { 20: 'yes' } } } } };
  const after = { fact: { data: { 1787691600: { 'GPV1.1': { 20: 'no' } } } } };
  assert.equal(affectsSchedule(before, after, ON_THE_DAY), true);
});

test('housekeeping timestamps are not', () => {
  // `lastUpdated` moves on every upstream poll and `mirroredAt` on every mirror run.
  const fact = { data: { 1787691600: { 'GPV1.1': { 20: 'no' } } } };
  assert.equal(
    affectsSchedule(
      { fact, lastUpdated: '2026-08-26T08:00:00Z', mirroredAt: '2026-08-26T08:00:00Z' },
      { fact, lastUpdated: '2026-08-26T09:00:00Z', mirroredAt: '2026-08-26T09:00:00Z' },
      ON_THE_DAY
    ),
    false
  );
});

test('a changed weekly preset is not', () => {
  // The preset is a forecast the app already holds; only the published day changes anyone's evening.
  const fact = { data: [] };
  assert.equal(
    affectsSchedule({ fact, preset: { data: { a: 1 } } }, { fact, preset: { data: { a: 2 } } }),
    false
  );
});

test('a first-ever mirror of a region counts as a change', () => {
  assert.equal(affectsSchedule(null, { fact: { data: { 1787691600: {} } } }, ON_THE_DAY), true);
});

test('topic names carry no characters FCM rejects', () => {
  assert.equal(topicFor('kyiv'), 'region-kyiv');
  assert.equal(topicFor('kyiv-region'), 'region-kyiv-region');
  assert.match(topicFor('a.b'), /^[a-zA-Z0-9-_.~%]+$/);
  assert.ok(!topicFor('a.b').includes('.'));
});

test('a region seen for the first time with nothing published wakes no one', () => {
  // Out of season a new region's first file has `[]`; with no served copy to compare against it
  // used to count as changed on every run.
  assert.equal(affectsSchedule(null, { fact: { data: [] } }), false);
  assert.equal(affectsSchedule({ fact: { data: {} } }, { fact: { data: [] } }), false);
  assert.equal(affectsSchedule({ fact: { data: [] } }, { fact: { data: { 1787691600: {} } } }, ON_THE_DAY), true);
});

// Days as the mirror keys them: 25, 26 and 27 серпня 2026, Kyiv midnight.
const YESTERDAY = 1787605200;
const TODAY = 1787691600;
const TOMORROW = 1787778000;
const day = (state) => ({ 'GPV1.1': { 20: state }, 'GPV1.2': { 20: 'yes' } });

test('yesterday dropping off at midnight wakes no one', () => {
  // Every region lost a day at Kyiv midnight (Тернопіль at 00:00 UTC), and every phone in it was
  // woken to refetch a schedule it already held.
  const before = { fact: { data: { [YESTERDAY]: day('no'), [TODAY]: day('no') } } };
  const after = { fact: { data: { [TODAY]: day('no') } } };
  assert.equal(affectsSchedule(before, after, ON_THE_DAY), false);
});

test('tomorrow being published is worth a wake-up', () => {
  const before = { fact: { data: { [TODAY]: day('no') } } };
  const after = { fact: { data: { [TODAY]: day('no'), [TOMORROW]: day('yes') } } };
  assert.equal(affectsSchedule(before, after, ON_THE_DAY), true);
});

test('the same day with its queues listed in another order is not', () => {
  // A YASNO-merged day can come back with the same queues in a different order.
  const before = { fact: { data: { [TODAY]: { 'GPV1.1': { 20: 'no' }, 'GPV1.2': { 20: 'yes' } } } } };
  const after = { fact: { data: { [TODAY]: { 'GPV1.2': { 20: 'yes' }, 'GPV1.1': { 20: 'no' } } } } };
  assert.equal(affectsSchedule(before, after, ON_THE_DAY), false);
});

test('tomorrow withdrawn is worth a wake-up', () => {
  const before = { fact: { data: { [TODAY]: day('no'), [TOMORROW]: day('no') } } };
  const after = { fact: { data: { [TODAY]: day('no') } } };
  assert.equal(affectsSchedule(before, after, ON_THE_DAY), true);
});

test('a quiet day being marked is not: no shipped build reads it', () => {
  const before = { fact: { data: { [TODAY]: day('no') } } };
  const after = { fact: { data: { [TODAY]: day('no') }, quiet: [TOMORROW] } };
  assert.equal(affectsSchedule(before, after, ON_THE_DAY), false);
  assert.equal(affectsSchedule({ fact: { data: [] } }, { fact: { data: [], quiet: [TODAY] } }, ON_THE_DAY), false);
});
