import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRegion, withheld } from './sources/zhytomyr.mjs';
import { REGIONS } from './regions.mjs';
import { hasSchedule, kyivDayStart, statusFor, validate } from './lib/canonical.mjs';

// 27 November 2026: ztoe.com.ua answered this reader's User-Agent with a table its visitors did not see (regions.mjs).
const zhytomyr = REGIONS.find((r) => r.id === 'zhytomyr');
const now = new Date('2026-11-27T19:00:00Z');
const quiet = { read: async () => ({ active: false }), now, log: () => {} };

test('Житомир: the withheld table goes out as twelve queues and no day, unreadable since the day it was last real', async () => {
  const error = await withheld(zhytomyr, quiet);
  const held = error.fallback;

  assert.ok(held, 'something is offered to the mirror, so the invented table leaves the phones');
  assert.equal(Object.keys(held.preset.sch_names).length, 12);
  assert.deepEqual(held.fact.data, [], 'no day at all');
  assert.equal(hasSchedule(held), false);
  assert.deepEqual(validate(held), []);
  // Not «live» with an empty day, which the app reads as «вимкнень не заплановано»: seasonal and, by the mirror, stale.
  assert.equal(statusFor(zhytomyr, held), 'seasonal');
  assert.equal(error.since, zhytomyr.tableWithheld.since);
  // The app calls a region unreadable after three hours of it (OutageRegion.unreadableAfter).
  assert.ok(now.getTime() - Date.parse(error.since) > 3 * 3600 * 1000);
});

test('Житомир: an order of Укренерго the channel announces is still said over the withheld table', async () => {
  const read = async () => ({ active: true, since: '2026-11-27T16:10:00+00:00', note: null });
  const { fallback } = await withheld(zhytomyr, { ...quiet, read });
  assert.deepEqual(fallback.fact.emergency, [kyivDayStart(now)]);
  assert.deepEqual(fallback.fact.data, []);

  const silent = await withheld(zhytomyr, { ...quiet, read: async () => { throw new Error('t.me: 502'); } });
  assert.equal(silent.fallback.fact.emergency, undefined, 'a silent channel claims nothing');
  assert.deepEqual(validate(silent.fallback), []);
});

test('Житомир: the operator\'s page is not asked while the table is withheld', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => { asked.push(String(url)); throw new Error('no network in tests'); });

  await assert.rejects(fetchRegion({ ...zhytomyr, previous: null }), (error) => {
    assert.match(error.message, /withheld/);
    assert.deepEqual(error.fallback.fact.data, []);
    return true;
  });
  assert.deepEqual(asked.filter((url) => url.includes('ztoe.com.ua')), []);
});
