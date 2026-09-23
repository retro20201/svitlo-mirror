import test from 'node:test';
import assert from 'node:assert/strict';
import { statusFor, hasSchedule, buildSnapshot, kyivDayStart, queueNames, NATIONAL_QUEUES }
  from './lib/canonical.mjs';

const region = (over = {}) => ({ id: 'test', status: 'seasonal', ...over });
const snapshot = (over = {}) => buildSnapshot({
  regionId: 'test', title: 'Тест', queues: queueNames(NATIONAL_QUEUES), source: 'test', ...over
});

test('a region with nothing published is not offered as working', () => {
  const snap = snapshot();
  assert.equal(hasSchedule(snap), false);
  assert.equal(statusFor(region(), snap), 'seasonal');
});

test('a weekly plan is enough to be live — it covers every day', () => {
  const snap = snapshot({ preset: { '1': { '1': 'yes' } } });
  assert.equal(statusFor(region(), snap), 'live');
});

test('a published day turns a seasonal region live', () => {
  const snap = snapshot({ fact: { [kyivDayStart()]: { GPV1: {} } } });
  assert.equal(statusFor(region(), snap), 'live');
});

test('a region that publishes pictures gets its own status, never live', () => {
  // No countdown, no alerts, no widget can be built from an image, and `live` promises all three.
  const snap = snapshot({ sheets: [{ dayStart: kyivDayStart(), url: 'x' }], sheetBased: true });
  assert.equal(statusFor(region(), snap), 'image');
});

test('an archive-only source never turns a region live, however much it publishes', () => {
  // Прикарпаття's archive is the record of a day that has already happened. Going live on it would
  // promise a countdown and then say "вимкнень не заплановано" to someone sitting in the dark.
  const snap = snapshot({ fact: { [kyivDayStart() - 86400]: { GPV1: {} } } });
  assert.equal(hasSchedule(snap), true);
  assert.equal(statusFor(region({ archiveOnly: true }), snap), 'seasonal');
});

test('an archive-only region keeps a status that is not about the season', () => {
  // blocked/occupied/noFeed say something true that "seasonal" would paper over.
  const snap = snapshot({ fact: { [kyivDayStart()]: { GPV1: {} } } });
  assert.equal(statusFor(region({ status: 'blocked', archiveOnly: true }), snap), 'blocked');
});

test('a region configured live but publishing nothing falls back to seasonal', () => {
  assert.equal(statusFor(region({ status: 'live' }), snapshot()), 'seasonal');
});
