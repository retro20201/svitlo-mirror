import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { combine, factFromPlanned, presetFromProbable, slotsToHalves } from './sources/yasno.mjs';
import { settle } from './sources/dtek.mjs';
import { halvesFromHours, validate } from './lib/canonical.mjs';
import { unchanged } from './lib/change.mjs';
import { affectsSchedule } from './lib/notify.mjs';
import { REGIONS } from './regions.mjs';

// YASNO's answers and the copies phones had, read the same afternoon (7 жовтня 2026).
const F = JSON.parse(readFileSync(new URL('./yasno.fixture.json', import.meta.url), 'utf8'));
const KYIV = REGIONS.find((region) => region.id === 'kyiv');
const DNIPRO = REGIONS.find((region) => region.id === 'dnipro');
const keepKyiv = (key) => KYIV.queuePattern.test(key);
const NOW = new Date('2026-10-07T11:00:00Z');
const YASNO_STAMP = '2026-10-07T07:17:29+00:00'; // 10:17 in Kyiv; ДТЕК's own on the other copy is 10:04

const halves = (day) => Object.fromEntries(Object.entries(day).map(([queue, hours]) => [queue, halvesFromHours(hours).join('')]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const quiet = () => {};

function kyivYasno() {
  return {
    fact: clone(factFromPlanned(F.kyivPlanned, keepKyiv).fact),
    preset: presetFromProbable(F.kyivProbable, KYIV.yasno, keepKyiv),
    update: YASNO_STAMP
  };
}
const tomorrowOf = (yasno) => Object.keys(yasno.fact).sort()[1];

test('YASNO day tables are the same schedule phones had for every Kyiv group', () => {
  const { fact, update } = factFromPlanned(F.kyivPlanned, keepKyiv);
  assert.equal(Object.keys(fact).length, 2, 'today and tomorrow');
  for (const [epoch, day] of Object.entries(fact)) {
    assert.equal(Object.keys(day).length, 60);
    const served = F.kyivUpstream.fact.data[epoch];
    assert.ok(served, `phones have ${epoch}`);
    const picked = Object.fromEntries(Object.keys(day).map((queue) => [queue, served[queue]]));
    assert.deepEqual(halves(day), halves(picked));
  }
  assert.equal(update, YASNO_STAMP);
});

test('YASNO weekly plan is ДТЕК Дніпро\'s plan, weekday for weekday', () => {
  const preset = presetFromProbable(F.dniproProbable, DNIPRO.yasno);
  assert.equal(Object.keys(preset).length, 12);
  for (const [queue, week] of Object.entries(preset)) {
    assert.deepEqual(halves(week), halves(F.dniproUpstream.preset.data[queue]), queue);
  }
});

test('agreeing copies change nothing, and Київ\'s six-group YASNO plan is left out', () => {
  const lines = [];
  const snapshot = combine({ upstream: F.kyivUpstream, yasno: kyivYasno(), previous: F.kyivUpstream, region: KYIV, log: (line) => lines.push(line) });
  assert.deepEqual(validate(snapshot), []);
  assert.ok(unchanged(F.kyivUpstream, snapshot, Date.parse(F.kyivUpstream.lastUpdated)), 'nothing to write, nobody to wake');
  assert.deepEqual(Object.keys(kyivYasno().preset), ['GPV1.1', 'GPV2.1', 'GPV3.1', 'GPV4.1', 'GPV5.1', 'GPV6.1']);
  assert.deepEqual(snapshot.preset, F.kyivUpstream.preset, 'a plan for 6 groups of 60 is no plan');
  assert.deepEqual(lines, []);
});

test('Дніпро keeps ДТЕК\'s own plan', () => {
  const yasno = { fact: {}, preset: presetFromProbable(F.dniproProbable, DNIPRO.yasno), update: null };
  const snapshot = combine({ upstream: F.dniproUpstream, yasno, previous: F.dniproUpstream, region: DNIPRO });
  assert.deepEqual(snapshot.preset.data, F.dniproUpstream.preset.data);
});

test('an all-clear YASNO plan never stands in for ДТЕК\'s dropped one', () => {
  const yasno = kyivYasno();
  yasno.preset = Object.fromEntries(Object.keys(F.kyivUpstream.preset.sch_names).map((queue) => [queue, {
    1: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [String(index + 1), 'yes']))
  }]));
  const snapshot = combine({ upstream: F.kyivUpstream, yasno, previous: F.kyivUpstream, region: KYIV, log: quiet });
  assert.deepEqual(snapshot.preset.data, {}, 'no green week');
});

test('a day only YASNO has is published at once, in the operator\'s queue order', () => {
  const yasno = kyivYasno();
  const tomorrow = tomorrowOf(yasno);
  const upstream = clone(F.kyivUpstream);
  delete upstream.fact.data[tomorrow];
  const snapshot = combine({ upstream, yasno, previous: upstream, region: KYIV, log: quiet });
  assert.deepEqual(halves(snapshot.fact.data[tomorrow]), halves(yasno.fact[tomorrow]));
  assert.deepEqual(Object.keys(snapshot.fact.data[tomorrow]), Object.keys(F.kyivUpstream.preset.sch_names));

  // outage-data-ua catches up with the same table: nobody is woken a second time.
  const caughtUp = combine({ upstream: F.kyivUpstream, yasno, previous: snapshot, region: KYIV, log: quiet });
  assert.equal(affectsSchedule(snapshot, caughtUp), false);
});

test('when the copies disagree, the later operator stamp wins', () => {
  // YASNO has the revision, stamped 10:17 against ДТЕК's 10:04 on the other copy.
  const yasno = kyivYasno();
  const tomorrow = tomorrowOf(yasno);
  yasno.fact[tomorrow]['GPV1.1']['3'] = 'no';
  let snapshot = combine({ upstream: F.kyivUpstream, yasno, previous: F.kyivUpstream, region: KYIV, log: quiet });
  assert.equal(snapshot.fact.data[tomorrow]['GPV1.1']['3'], 'no');
  assert.equal(snapshot.fact.update, '07.10.2026 10:17');

  // outage-data-ua has it, with ДТЕК's 12:00 stamp; YASNO still has the 10:17 table.
  const upstream = clone(F.kyivUpstream);
  upstream.fact.data[tomorrow]['GPV1.1']['3'] = 'no';
  upstream.fact.update = '07.10.2026 12:00';
  snapshot = combine({ upstream, yasno: kyivYasno(), previous: F.kyivUpstream, region: KYIV, log: quiet });
  assert.equal(snapshot.fact.data[tomorrow]['GPV1.1']['3'], 'no');
  assert.equal(snapshot.fact.update, '07.10.2026 12:00');
});

test('while the copies disagree, the served schedule holds still from cycle to cycle', () => {
  for (const yasnoFirst of [true, false]) {
    const yasno = kyivYasno();
    const tomorrow = tomorrowOf(yasno);
    const upstream = clone(F.kyivUpstream);
    if (yasnoFirst) yasno.fact[tomorrow]['GPV1.1']['3'] = 'no';
    else { upstream.fact.data[tomorrow]['GPV1.1']['3'] = 'no'; upstream.fact.update = '07.10.2026 12:00'; }

    let previous = F.kyivUpstream;
    const served = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      const snapshot = combine({ upstream, yasno, previous, region: KYIV, log: quiet });
      served.push(JSON.stringify(snapshot.fact));
      if (cycle > 0) assert.equal(affectsSchedule(previous, snapshot), false, `cycle ${cycle} woke phones`);
      previous = snapshot;
    }
    assert.equal(new Set(served).size, 1, yasnoFirst ? 'YASNO first' : 'outage-data-ua first');
    assert.equal(JSON.parse(served[0]).data[tomorrow]['GPV1.1']['3'], 'no');
  }
});

test('a YASNO read that fails once takes nothing back and wakes nobody', () => {
  for (const kind of ['a day only YASNO has', 'a newer YASNO revision']) {
    const yasno = kyivYasno();
    const tomorrow = tomorrowOf(yasno);
    const upstream = clone(F.kyivUpstream);
    if (kind === 'a day only YASNO has') delete upstream.fact.data[tomorrow];
    else yasno.fact[tomorrow]['GPV1.1']['3'] = 'no';

    let previous = upstream;
    const served = [];
    for (const [cycle, answer] of [yasno, null, yasno, null].entries()) {
      const snapshot = combine({ upstream, yasno: answer, previous, region: KYIV, now: NOW, log: quiet });
      if (cycle > 0) assert.equal(affectsSchedule(previous, snapshot), false, `${kind}: cycle ${cycle} woke phones`);
      served.push(JSON.stringify(snapshot.fact.data[tomorrow]));
      previous = snapshot;
    }
    assert.equal(new Set(served).size, 1, kind);
  }

  // Once outage-data-ua has a newer table of its own, that is served even with YASNO silent.
  const yasno = kyivYasno();
  const tomorrow = tomorrowOf(yasno);
  yasno.fact[tomorrow]['GPV1.1']['3'] = 'no';
  const held = combine({ upstream: F.kyivUpstream, yasno, previous: F.kyivUpstream, region: KYIV, now: NOW, log: quiet });
  const upstream = clone(F.kyivUpstream);
  upstream.fact.data[tomorrow]['GPV1.1']['3'] = 'first';
  upstream.fact.update = '07.10.2026 12:00';
  const later = combine({ upstream, yasno: null, previous: held, region: KYIV, now: NOW, log: quiet });
  assert.equal(later.fact.data[tomorrow]['GPV1.1']['3'], 'first');
});

test('a malformed YASNO plan never fails a region outage-data-ua can serve', () => {
  const yasno = kyivYasno();
  yasno.preset = Object.fromEntries(Object.keys(F.kyivUpstream.preset.sch_names).map((queue) => [queue, {
    1: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [String(index + 1), 'maybe']))
  }]));
  const snapshot = settle({ status: 'fulfilled', value: F.kyivUpstream }, { status: 'fulfilled', value: yasno }, { ...KYIV, previous: F.kyivUpstream }, quiet);
  assert.deepEqual(validate(snapshot), []);
  assert.deepEqual(snapshot.preset.data, {}, 'one weekday of seven is no plan');
});

test('without outage-data-ua, YASNO refreshes what phones have only where it is newer', () => {
  const yasno = kyivYasno();
  const tomorrow = tomorrowOf(yasno);
  yasno.fact[tomorrow]['GPV1.1']['3'] = 'no';
  const kyiv = combine({ upstream: null, yasno, previous: F.kyivUpstream, region: KYIV, now: NOW });
  assert.deepEqual(validate(kyiv), []);
  assert.equal(Object.keys(kyiv.preset.sch_names).length, 60);
  assert.equal(kyiv.fact.data[tomorrow]['GPV1.1']['3'], 'no', 'YASNO\'s 10:17 revision over the 10:04 copy');
  assert.equal(kyiv.fact.update, '07.10.2026 10:17');
  assert.equal(kyiv.mirroredAt, undefined);

  // Phones already have a 12:00 revision; YASNO's 10:17 table must not undo it.
  const newer = clone(F.kyivUpstream);
  newer.fact.data[tomorrow]['GPV2.1']['5'] = 'no';
  newer.fact.update = '07.10.2026 12:00';
  const kept = combine({ upstream: null, yasno: kyivYasno(), previous: newer, region: KYIV, now: NOW });
  assert.equal(kept.fact.data[tomorrow]['GPV2.1']['5'], 'no');
  assert.equal(kept.fact.update, '07.10.2026 12:00');

  // Дніпро: YASNO knows 12 of its 24 queues and has no day today; the rest, and the plan, stay.
  const dnipro = combine({
    upstream: null,
    yasno: { fact: factFromPlanned(F.dniproPlanned).fact, preset: presetFromProbable(F.dniproProbable, DNIPRO.yasno), update: null },
    previous: F.dniproUpstream,
    region: DNIPRO,
    now: NOW
  });
  assert.deepEqual(validate(dnipro), []);
  assert.deepEqual(dnipro.preset, F.dniproUpstream.preset);
});

test('with no copy at all yet, YASNO alone is a valid region — without a partial plan', () => {
  const snapshot = combine({ upstream: null, yasno: kyivYasno(), previous: null, region: KYIV, now: NOW });
  assert.deepEqual(validate(snapshot), []);
  assert.equal(Object.keys(snapshot.preset.sch_names).length, 60);
  assert.equal(snapshot.preset.sch_names['GPV1.1'], 'Черга 1.1');
  assert.deepEqual(snapshot.preset.data, {});
  assert.equal(snapshot.fact.update, '07.10.2026 10:17');
});

test('without YASNO, the outage-data-ua copy is served as before', () => {
  assert.equal(combine({ upstream: F.kyivUpstream, yasno: null, previous: null, region: KYIV }), F.kyivUpstream);
});

test('outage-data-ua down: the region fails, offering YASNO\'s part for the mirror to mark stale', () => {
  const region = { ...KYIV, previous: F.kyivUpstream };
  const down = new Error('outage-data-ua: 503');
  assert.throws(
    () => settle({ status: 'rejected', reason: down }, { status: 'fulfilled', value: kyivYasno() }, region, quiet),
    (error) => error === down && validate(error.fallback).length === 0
  );
  const alsoDown = new Error('outage-data-ua: 503');
  assert.throws(
    () => settle({ status: 'rejected', reason: alsoDown }, { status: 'rejected', reason: new Error('yasno: 500') }, region, quiet),
    (error) => error === alsoDown && !error.fallback
  );
  const fine = settle({ status: 'fulfilled', value: F.kyivUpstream }, { status: 'rejected', reason: new Error('yasno: 500') }, region, quiet);
  assert.equal(fine, F.kyivUpstream);
});

test('an emergency day is carried for the app, wakes phones, and outlasts a silent YASNO', () => {
  const planned = clone(F.kyivPlanned);
  for (const group of Object.values(planned)) group.today.status = 'EmergencyShutdowns';
  const read = factFromPlanned(planned, keepKyiv);
  const today = Object.keys(kyivYasno().fact).sort()[0];
  assert.deepEqual(read.emergency, [Number(today)]);
  assert.equal(read.fact[today], undefined, 'YASNO\'s own table for an emergency day is not used');

  const yasno = { ...kyivYasno(), emergency: read.emergency };
  const snapshot = combine({ upstream: F.kyivUpstream, yasno, previous: F.kyivUpstream, region: KYIV, now: NOW, log: quiet });
  assert.deepEqual(validate(snapshot), []);
  assert.deepEqual(snapshot.fact.emergency, [Number(today)]);
  assert.deepEqual(snapshot.fact.data, F.kyivUpstream.fact.data, 'ДТЕК\'s table is still shown');
  assert.equal(affectsSchedule(F.kyivUpstream, snapshot, NOW), true, 'phones hear of it at once');

  // YASNO silent next cycle: the warning stays rather than flickering off.
  const silent = combine({ upstream: F.kyivUpstream, yasno: null, previous: snapshot, region: KYIV, now: NOW, log: quiet });
  assert.deepEqual(silent.fact.emergency, [Number(today)]);
  assert.equal(affectsSchedule(snapshot, silent, NOW), false);

  // Over: YASNO answers without it, and the key is gone — the shape phones always had.
  const over = combine({ upstream: F.kyivUpstream, yasno: kyivYasno(), previous: silent, region: KYIV, now: NOW, log: quiet });
  assert.equal('emergency' in over.fact, false);
  assert.equal(affectsSchedule(silent, over, NOW), true);

  // A past day's emergency is dropped — without waking anyone for it.
  const tomorrowMorning = new Date(NOW.getTime() + 24 * 3600 * 1000);
  const later = combine({ upstream: F.kyivUpstream, yasno: null, previous: snapshot, region: KYIV, now: tomorrowMorning, log: quiet });
  assert.equal('emergency' in later.fact, false);
  assert.equal(affectsSchedule(snapshot, later, tomorrowMorning), false);
});

test('a slot off the half-hour grid or of an unknown type fails the read', () => {
  assert.throws(() => slotsToHalves([{ start: 0, end: 45, type: 'Definite' }], 'off'), /half-hour grid/);
  assert.throws(() => slotsToHalves([{ start: 0, end: 60, type: 'Possible' }], 'off'), /unknown yasno slot type/);
  assert.deepEqual(slotsToHalves([{ start: 360, end: 450, type: 'Definite' }], 'off').slice(11, 16), ['on', 'off', 'off', 'off', 'on']);
});

test('a quiet or not-yet-published YASNO day is not taken as a clear day', () => {
  const { fact } = factFromPlanned(F.dniproPlanned);
  assert.deepEqual(fact, {}, 'NoOutages today and WaitingForSchedule tomorrow add nothing');
});
