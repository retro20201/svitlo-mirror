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

// Київ is a region YASNO also carries: the channel adds to what YASNO says, and never takes it back.
// 29 October 2026: ДТЕК's post («запроваджено екстрені відключення в частині Голосієвського та Соломʼянського районів»)
// at 08:45 Kyiv time, YASNO's feed still empty at 10:02.
const CITY = (previous) => ({ id: 'kyiv', yasno: { regionId: 25, dsoId: 902 }, emergencyTelegram: { area: 'city' }, previous });
const cityFrom = (emergency, note) => ({
  regionId: 'kyiv',
  fact: { data: { [TODAY]: { 'GPV1.1': {} } }, update: '24.10.2026 10:00', ...(emergency ? { emergency } : {}), ...(note ? { emergencyNote: note } : {}) }
});

test('Київ: an order the channel announced and YASNO has not marked yet puts today in fact.emergency', async () => {
  const read = async (query) => {
    assert.equal(query.area, 'city');
    return { active: true, since: '2026-10-24T06:45:00+00:00', note: 'в частині Голосієвського та Соломʼянського районів' };
  };
  const result = await withChannelEmergency(cityFrom(), CITY(), { read, now: NOW, log: quiet });
  assert.deepEqual(result.fact.emergency, [TODAY]);
  assert.equal(result.fact.emergencyNote, 'в частині Голосієвського та Соломʼянського районів');
  assert.deepEqual(result.fact.data, cityFrom().fact.data, 'the table is left as it was');
});

test('Київ: a day YASNO marked stays, tomorrow too, and the channel adds today without doubling it', async () => {
  const tomorrow = TODAY + 86400;
  const read = async () => ({ active: true, since: '2026-10-24T06:45:00+00:00', note: null });
  const both = await withChannelEmergency(cityFrom([TODAY, tomorrow]), CITY(), { read, now: NOW, log: quiet });
  assert.deepEqual(both.fact.emergency, [TODAY, tomorrow]);
  const onlyTomorrow = await withChannelEmergency(cityFrom([tomorrow]), CITY(), { read, now: NOW, log: quiet });
  assert.deepEqual(onlyTomorrow.fact.emergency, [TODAY, tomorrow]);
  assert.equal('emergencyNote' in onlyTomorrow.fact, false, 'no districts named, none invented');
});

test('Київ: a note that is there is not replaced by the channel\'s', async () => {
  const read = async () => ({ active: true, since: '2026-10-24T06:45:00+00:00', note: 'у Дарницькому районі' });
  const result = await withChannelEmergency(cityFrom([TODAY], 'в частині Голосієвського району'), CITY(), { read, now: NOW, log: quiet });
  assert.equal(result.fact.emergencyNote, 'в частині Голосієвського району');
});

test('Київ: a silent channel, or one that says nothing is on, takes nothing back from YASNO', async () => {
  const marked = () => cityFrom([TODAY]);
  const failed = await withChannelEmergency(marked(), CITY(), { read: async () => { throw new Error('t.me: 502'); }, now: NOW, log: quiet });
  assert.deepEqual(failed, marked());
  const over = await withChannelEmergency(marked(), CITY(), { read: async () => ({ active: false, since: null, note: null }), now: NOW, log: quiet });
  assert.deepEqual(over, marked());
  const nothing = await withChannelEmergency(cityFrom(), CITY({ fact: { emergency: [TODAY] } }), { read: async () => { throw new Error('x'); }, now: NOW, log: quiet });
  assert.deepEqual(nothing, cityFrom(), 'a held warning is YASNO\'s to carry, not the channel\'s');
});

test('Київ reads the channel for the city, and the real post of 29 October is an order for it and not for Київщина', async () => {
  const { REGIONS } = await import('./regions.mjs');
  const { readEmergency } = await import('./lib/dtek-emergency.mjs');
  const kyiv = REGIONS.find((candidate) => candidate.id === 'kyiv');
  assert.deepEqual(kyiv.emergencyTelegram, { area: 'city' });
  const posts = [{ id: 4712, postedAt: '2026-10-29T06:45:12+00:00',
    text: '‼️Київ: за командою Укренерго запроваджено екстрені відключення в частині Голосієвського та Соломʼянського районів. Нагадаємо, під час екстрених відключень графіки не діють.' }];
  const now = new Date('2026-10-29T07:30:00Z');
  const city = readEmergency(posts, { now, area: 'city' });
  assert.equal(city.active, true);
  assert.equal(city.note, 'в частині Голосієвського та Соломʼянського районів');
  assert.equal(readEmergency(posts, { now, area: 'oblast' }).active, false);
});
