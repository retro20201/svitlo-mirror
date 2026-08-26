import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affectsSchedule, topicFor } from './lib/notify.mjs';

// This predicate decides whether to wake every phone in an oblast. Getting it wrong in one
// direction spams people; in the other it leaves their alerts armed against yesterday's plan.

test('a changed published schedule is worth a wake-up', () => {
  assert.equal(
    affectsSchedule({ fact: { data: [] } }, { fact: { data: { 1787691600: { 'GPV1.1': {} } } } }),
    true
  );
});

test('a revised day is worth a wake-up', () => {
  const before = { fact: { data: { 1787691600: { 'GPV1.1': { 20: 'yes' } } } } };
  const after = { fact: { data: { 1787691600: { 'GPV1.1': { 20: 'no' } } } } };
  assert.equal(affectsSchedule(before, after), true);
});

test('housekeeping timestamps are not', () => {
  // `lastUpdated` moves on every upstream poll and `mirroredAt` on every mirror run.
  const fact = { data: { 1787691600: { 'GPV1.1': { 20: 'no' } } } };
  assert.equal(
    affectsSchedule(
      { fact, lastUpdated: '2026-08-26T08:00:00Z', mirroredAt: '2026-08-26T08:00:00Z' },
      { fact, lastUpdated: '2026-08-26T09:00:00Z', mirroredAt: '2026-08-26T09:00:00Z' }
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
  assert.equal(affectsSchedule(null, { fact: { data: { 1787691600: {} } } }), true);
});

test('topic names carry no characters FCM rejects', () => {
  assert.equal(topicFor('kyiv'), 'region-kyiv');
  assert.equal(topicFor('kyiv-region'), 'region-kyiv-region');
  assert.match(topicFor('a.b'), /^[a-zA-Z0-9-_.~%]+$/);
  assert.ok(!topicFor('a.b').includes('.'));
});
