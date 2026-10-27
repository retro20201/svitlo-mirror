import test from 'node:test';
import assert from 'node:assert/strict';
import { withChannelEmergency } from './sources/dtek.mjs';
import { kyivDayStart } from './lib/canonical.mjs';
import { carriedParts } from './lib/carried.mjs';

const NOW = new Date('2026-10-24T09:00:00Z');
const TODAY = kyivDayStart(NOW);
const region = (previous) => ({ id: 'kyiv-region', emergencyTelegram: { area: 'oblast' }, previous });
const snapshot = () => ({ regionId: 'kyiv-region', fact: { data: { [TODAY]: { 'GPV1.1': {} } }, update: '24.10.2026 10:00' } });
const quiet = () => {};

test('an order that is on puts today in fact.emergency, with the districts the post named', async () => {
  const read = async (query) => {
    assert.equal(query.area, 'oblast');
    return { active: true, since: '2026-10-24T07:49:28+00:00', note: 'у Броварському районі' };
  };
  const result = await withChannelEmergency(snapshot(), region(), { read, now: NOW, log: quiet });
  assert.deepEqual(result.fact.emergency, [TODAY]);
  assert.equal(result.fact.emergencyNote, 'у Броварському районі');
  assert.deepEqual(result.fact.data, snapshot().fact.data, 'the table is left as the operator published it');
  assert.equal(carriedParts(result), null, 'a look at the channel');
});

test('an order that is over leaves the snapshot in exactly the shape it always had', async () => {
  const read = async () => ({ active: false, since: null, note: null });
  const result = await withChannelEmergency(snapshot(), region(), { read, now: NOW, log: quiet });
  assert.equal('emergency' in result.fact, false);
  assert.equal('emergencyNote' in result.fact, false);
  assert.deepEqual(result.fact, snapshot().fact);
});

test('a channel that does not answer keeps the warning phones have, as carried, for today only', async () => {
  const read = async () => { throw new Error('t.me: 502'); };
  const previous = { fact: { emergency: [TODAY - 86400, TODAY], emergencyNote: 'у Броварському районі' } };
  const result = await withChannelEmergency(snapshot(), region(previous), { read, now: NOW, log: quiet });
  assert.deepEqual(result.fact.emergency, [TODAY], 'yesterday is not carried');
  assert.equal(result.fact.emergencyNote, 'у Броварському районі');
  assert.deepEqual(carriedParts(result), ['emergency']);
});

test('a channel that does not answer, with nothing held, changes nothing', async () => {
  const read = async () => { throw new Error('t.me: 502'); };
  const result = await withChannelEmergency(snapshot(), region({ fact: {} }), { read, now: NOW, log: quiet });
  assert.deepEqual(result.fact, snapshot().fact);
  assert.equal(carriedParts(result), null);
});

test('the news pipeline sees the region as one that can have an emergency, and sees today', async () => {
  const { REGIONS, indexEntry } = await import('./regions.mjs');
  const { observeRegion } = await import('./lib/news-observe.mjs');
  const meta = REGIONS.find((candidate) => candidate.id === 'kyiv-region');
  assert.equal(indexEntry(meta).emergencySignal, true);
  const read = async () => ({ active: true, since: '2026-10-24T07:49:28+00:00', note: null });
  const served = await withChannelEmergency(snapshot(), region(), { read, now: NOW, log: quiet });
  assert.deepEqual(observeRegion(meta, served, NOW).emergency, [TODAY]);
  assert.deepEqual(observeRegion(meta, snapshot(), NOW).emergency, []);
});
