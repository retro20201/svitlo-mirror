import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  encQueue, newsTopic, sheetTopic, emergencyTopic, offMask, kyivClock, windowStart, sheetKey,
  observeRegion, decide, render, buildMessage, recordSent, isNight, dayLabel, BREAKER, GAP_MS
} from './lib/news.mjs';
import { buildSnapshot, kyivDayStart, kyivTomorrowStart, queueNames, NATIONAL_QUEUES } from './lib/canonical.mjs';
import { parseFragment, hoursFromHalves } from './sources/poltava.mjs';
import { regionById } from './regions.mjs';

// These alerts reach people who switched them on at the moment they matter, and wake them at night
// if wrong. Every case below is one that once spammed or misled in a design review: a flap, a
// midnight, a picture turning into a table, a Mykolaiv flag in the current hour.

const FRAGMENTS = JSON.parse(readFileSync(new URL('./poltava.fixture.json', import.meta.url), 'utf8'));
const YASNO = JSON.parse(readFileSync(new URL('./yasno.fixture.json', import.meta.url), 'utf8'));

const POLTAVA = regionById('poltava');
const KYIV = regionById('kyiv');
const SUMY = regionById('sumy');
const VOLYN = regionById('volyn');
const KHMELNYTSKYI = regionById('khmelnytskyi');

/** Kyiv wall clock in October before the 25th (+03:00), as epoch ms. */
const at = (local) => Date.parse(`${local.replace(' ', 'T')}:00+03:00`);
const MIN = 60_000;
const TODAY = 1791406800;      // чт, 8 жовтня 2026
const TOMORROW = 1791493200;   // пт, 9 жовтня 2026

/** Hours of a queue dark in the given wall-clock ranges, e.g. '07:00-10:00'; light otherwise. */
function dark(...ranges) {
  const off = new Set();
  for (const range of ranges) {
    const [from, to] = range.split('-').map((time) => {
      const [hour, minute] = time.split(':').map(Number);
      return hour * 2 + minute / 30;
    });
    for (let slot = from; slot < to; slot++) off.add(slot);
  }
  const hours = {};
  for (let hour = 1; hour <= 24; hour++) {
    const first = off.has(hour * 2 - 2);
    const second = off.has(hour * 2 - 1);
    hours[hour] = first && second ? 'no' : first ? 'first' : second ? 'second' : 'yes';
  }
  return hours;
}

/** A day of Полтава's twelve підчерги: all light but for the ones given. */
const day = (queues = {}) => Object.fromEntries(NATIONAL_QUEUES.map((label) => [`GPV${label}`, queues[`GPV${label}`] ?? dark()]));

/** A served Полтава file. */
function poltava(days = {}, { quiet = [] } = {}) {
  const snapshot = buildSnapshot({ regionId: 'poltava', title: POLTAVA.title, queues: queueNames(NATIONAL_QUEUES), fact: days, source: 'poltava' });
  if (quiet.length) snapshot.fact.quiet = quiet;
  return snapshot;
}

/** One region read cycle after cycle, every due alert sent and recorded as the `on` mode does. */
function reader(meta, { fingerprint = 'fp1' } = {}) {
  let ledger = null;
  return {
    read(time, snapshot, { fp = fingerprint } = {}) {
      const now = new Date(time);
      const result = decide({ ledger, observations: { [meta.id]: observeRegion(meta, snapshot, now) }, now, fingerprint: fp, freshIds: [meta.id] });
      ledger = result.ledger;
      const sent = result.due.map((event) => {
        const text = render(event, now);
        const message = buildMessage(event, text, now);
        recordSent(ledger, event, time);
        return { ...event, text, message };
      });
      return { sent, log: result.log, breaker: result.breaker };
    },
    get ledger() {
      return ledger;
    }
  };
}

const outcomes = (log) => log.map((entry) => entry.outcome);

// --- Topics

test('topics match the app byte for byte, on the shared vectors', () => {
  const vectors = [
    ['poltava', 'GPV3.1', 'q_poltava_GPV3-1'],
    ['kyiv-region', 'GPV6.2', 'q_kyiv-region_GPV6-2'],
    ['chernivtsi', 'CV12', 'q_chernivtsi_CV12'],
    ['kyiv', 'GPV1-1', 'q_kyiv_GPV1%2D1'],
    ['ternopil', 'Черга 1', 'q_ternopil_%D0%A7%D0%B5%D1%80%D0%B3%D0%B0%201']
  ];
  for (const [region, queue, topic] of vectors) {
    assert.equal(newsTopic(region, queue), topic);
    assert.match(topic, /^[a-zA-Z0-9-_.~%]{1,900}$/);
  }
  assert.equal(sheetTopic('sumy'), 's_sumy');
  assert.equal(emergencyTopic('kyiv'), 'e_kyiv');
});

test('no two queue labels share a topic', () => {
  // Тернопіль's labels are free strings: `-`, `_` and `%` are escaped so nothing collides.
  const labels = ['GPV1.1', 'GPV1-1', 'GPV1_1', 'GPV1%2D1', 'GPV1%2E1', 'GPV11', 'Черга 1', 'Черга 1.', 'Черга_1'];
  assert.equal(new Set(labels.map(encQueue)).size, labels.length);
  assert.ok(labels.every((label) => !encQueue(label).includes('_')));
});

// --- Masks

test('only a definite outage counts as dark', () => {
  assert.equal(offMask(dark()), '000000000000');
  // A missing hour is light, as in the app — never the dark default of halvesFromHours.
  assert.equal(offMask({}), '000000000000');
  assert.equal(offMask({ 1: 'maybe', 2: 'mfirst', 3: 'msecond', 4: 'weird' }), '000000000000');
  assert.equal(offMask({ 1: 'no' }), '000000000003');
  assert.equal(offMask({ 1: 'first' }), '000000000001');
  assert.equal(offMask({ 1: 'second' }), '000000000002');
  assert.equal(offMask({ 24: 'no' }), 'c00000000000');
  // No queue at all is not a clear queue.
  assert.equal(offMask(undefined), null);
});

test('a queue missing from a published day is absent, not clear', () => {
  const snapshot = poltava({ [TOMORROW]: { 'GPV1.1': dark('07:00-10:00') } });
  const seen = observeRegion(POLTAVA, snapshot, new Date(at('2026-10-08 20:45')));
  assert.deepEqual(Object.keys(seen.days[TOMORROW].masks), ['GPV1.1']);
});

// --- Clock

test('the Kyiv clock is wall clock, h23, across the October change', () => {
  assert.deepEqual(kyivClock(new Date('2026-10-25T00:30:00Z')), { hour: 3, minute: 30 });
  assert.deepEqual(kyivClock(new Date('2026-10-25T01:30:00Z')), { hour: 3, minute: 30 });
  assert.deepEqual(kyivClock(new Date('2026-10-08T21:00:00Z')), { hour: 0, minute: 0 });
  // Tomorrow is the next Kyiv midnight, never +86400.
  assert.equal(kyivTomorrowStart(new Date('2026-10-24T19:00:00Z')), 1792875600);
  assert.equal(kyivTomorrowStart(new Date('2026-10-25T19:00:00Z')), 1792965600);
  assert.equal(windowStart(1792965600, new Date('2026-10-25T19:00:00Z')), 0);
  // Today counts from the next full hour; at 23:xx, not at all.
  assert.equal(windowStart(TODAY, new Date(at('2026-10-08 14:10'))), 30);
  assert.equal(windowStart(TODAY, new Date(at('2026-10-08 23:40'))), 48);
  assert.equal(windowStart(TODAY - 86400, new Date(at('2026-10-08 14:10'))), null);
});

test('the long October day reads tomorrow under its own key, and its last half-hour ends at 24:00', () => {
  const evening = Date.parse('2026-10-25T18:00:00Z');   // 20:00 in Kyiv, winter time
  const snapshot = poltava({ 1792965600: day({ 'GPV3.1': dark('23:00-24:00') }) });
  const kyiv = reader(POLTAVA);
  kyiv.read(evening - 4 * MIN, poltava());
  kyiv.read(evening - 2 * MIN, snapshot);
  const { sent } = kyiv.read(evening, snapshot);
  const alert = sent.find((event) => event.queue === 'GPV3.1');
  assert.equal(alert.day, 1792965600);
  assert.equal(alert.text.body, 'Пн, 26 жовтня: без світла 23:00–24:00 (разом 1 год).');
});

// --- The normal evening

test('bootstrap tells no one about what is already out', () => {
  const kyiv = reader(POLTAVA);
  const { sent, log } = kyiv.read(at('2026-10-08 20:45'), poltava({ [TODAY]: day({ 'GPV3.1': dark('18:00-21:00') }), [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) }));
  assert.equal(sent.length, 0);
  assert.ok(outcomes(log).every((outcome) => outcome === 'adopted(rebaseline)'));
  assert.equal(outcomes(log).length, 24);
});

test('tomorrow appearing is told once, after a second read, in the app\'s words', () => {
  const kyiv = reader(POLTAVA);
  const evening = at('2026-10-08 20:45');
  const tomorrow = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00', '13:00-16:30', '20:00-22:00') }) });
  kyiv.read(evening - 2 * MIN, poltava());
  assert.equal(kyiv.read(evening, tomorrow).sent.length, 0);
  const { sent } = kyiv.read(evening + 2 * MIN, tomorrow);
  const alert = sent.find((event) => event.queue === 'GPV3.1');
  assert.deepEqual(alert.text, {
    title: 'Зʼявився графік на завтра',
    subtitle: 'Полтавська область · Черга 3.1',
    body: 'Пт, 9 жовтня: без світла 07:00–10:00, 13:00–16:30, 20:00–22:00 (разом 8 год 30 хв).'
  });
  assert.equal(alert.message.message.topic, 'q_poltava_GPV3-1');
  // The rest of the region has outages that day, so a clear queue hears that it is clear.
  const clear = sent.find((event) => event.queue === 'GPV1.1');
  assert.equal(clear.text.body, 'Пт, 9 жовтня: вимкнень для вашої черги не заплановано.');
  assert.equal(sent.length, 12);
  assert.equal(kyiv.read(evening + 4 * MIN, tomorrow).sent.length, 0);
});

test('a real Полтава grid: more than three intervals end in «і ще»', () => {
  const grid = hoursFromHalves(parseFragment(FRAGMENTS['16-11-2025'], '16-11-2025').halves);
  const kyiv = reader(POLTAVA);
  const evening = at('2026-10-08 20:45');
  kyiv.read(evening - 2 * MIN, poltava());
  kyiv.read(evening, poltava({ [TOMORROW]: grid }));
  const { sent } = kyiv.read(evening + 2 * MIN, poltava({ [TOMORROW]: grid }));
  assert.equal(sent.find((event) => event.queue === 'GPV3.1').text.body,
    'Пт, 9 жовтня: без світла 01:00–04:00, 08:00–11:00, 14:00–18:00 і ще 1 (разом 12 год).');
  assert.equal(sent.length, 12);
});

test('Київ\'s sixty groups from the YASNO fixture: one alert per group', () => {
  const upstream = YASNO.kyivUpstream;
  const evening = at('2026-10-07 20:00');
  const todayOnly = structuredClone(upstream);
  delete todayOnly.fact.data['1791406800'];
  const kyiv = reader(KYIV);
  kyiv.read(evening - 2 * MIN, todayOnly);
  kyiv.read(evening, upstream);
  const { sent } = kyiv.read(evening + 2 * MIN, upstream);
  assert.equal(sent.length, 60);
  assert.ok(sent.every((event) => /^q_kyiv_GPV\d+-1$/.test(event.message.message.topic)));
  assert.ok(sent.every((event) => event.day === 1791406800 && event.text.title === 'Зʼявився графік на завтра'));
  assert.ok(sent.every((event) => event.text.subtitle.startsWith('Київ · ')));
});

// --- Flaps and midnight

test('a day that vanishes and comes back as it was is not news', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 18:00');
  const out = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) });
  kyiv.read(t, poltava());
  kyiv.read(t + 2 * MIN, out);
  assert.equal(kyiv.read(t + 4 * MIN, out).sent.length, 12);
  for (const gone of [1, 2, 3]) {
    let minute = 10 * gone;
    for (let i = 0; i < gone; i++) assert.equal(kyiv.read(t + (minute += 2) * MIN, poltava()).sent.length, 0);
    assert.equal(kyiv.read(t + (minute += 2) * MIN, out).sent.length, 0);
    assert.equal(kyiv.read(t + (minute += 2) * MIN, out).sent.length, 0);
  }
  // Back with one future slot changed: one revision for that queue, never a cancellation. A
  // vanish between two sightings starts the settle again.
  const changed = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:30') }) });
  kyiv.read(t + 58 * MIN, changed);
  kyiv.read(t + 60 * MIN, poltava());
  assert.equal(kyiv.read(t + 62 * MIN, changed).sent.length, 0);
  const { sent } = kyiv.read(t + 64 * MIN, changed);
  assert.deepEqual(sent.map((event) => [event.queue, event.kind]), [['GPV3.1', 'revised']]);
  assert.equal(sent[0].text.title, 'Графік на завтра змінено');
  assert.equal(sent[0].text.body, 'Пт, 9 жовтня, тепер: без світла 07:00–10:30 (разом 3 год 30 хв, на 30 хв більше).');
});

test('midnight changes nothing, drops yesterday, and a change settling across it is today\'s', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 23:30');
  const tomorrowOut = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('00:00-02:00', '09:00-11:00') }) });
  kyiv.read(t, poltava({ [TODAY]: day({ 'GPV3.1': dark('18:00-20:00') }) }));
  kyiv.read(t + 2 * MIN, tomorrowOut);
  assert.equal(kyiv.read(t + 4 * MIN, tomorrowOut).sent.length, 12);
  // 23:59 and 00:01: the same plan on either side of midnight.
  assert.equal(kyiv.read(at('2026-10-08 23:59'), tomorrowOut).sent.length, 0);
  assert.equal(kyiv.read(at('2026-10-09 00:01'), tomorrowOut).sent.length, 0);
  assert.ok(Object.keys(kyiv.ledger.entries).every((key) => !key.endsWith(`|${TODAY}`)));

  // Changed at 23:56, read again at 00:01: decided as tomorrow's change, told as today's.
  const revised = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('00:00-02:00', '09:00-12:00') }) });
  const late = reader(POLTAVA);
  late.read(at('2026-10-08 23:20'), tomorrowOut);
  late.read(at('2026-10-08 23:56'), revised);
  const { sent } = late.read(at('2026-10-09 00:01'), revised);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text.title, 'Оперативні зміни в графіку');
  // Only from 01:00 on: the cut under way at 00:01 is not repeated back.
  assert.equal(sent[0].text.body, 'Далі сьогодні без світла 01:00–02:00, 09:00–12:00 (на 1 год більше).');
});

// --- Today

test('today counts from the next full hour: past slots, the current hour and Миколаїв\'s flag are silent', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 14:10');
  const base = { 'GPV3.1': dark('08:00-10:00', '18:00-20:00') };
  kyiv.read(t - 2 * MIN, poltava({ [TODAY]: day(base) }));
  const quietly = [
    { 'GPV3.1': dark('08:00-11:00', '18:00-20:00') },                    // a past slot drifts
    { 'GPV3.1': dark('08:00-10:00', '14:00-15:00', '18:00-20:00') },     // the current hour
    { 'GPV3.1': dark('08:00-10:00', '14:00-14:30', '18:00-20:00') },     // the live flag on…
    base                                                                  // …and off again
  ];
  let minute = 0;
  for (const queues of quietly) {
    for (let i = 0; i < 3; i++) assert.equal(kyiv.read(t + (minute += 2) * MIN, poltava({ [TODAY]: day(queues) })).sent.length, 0);
  }
  const later = poltava({ [TODAY]: day({ 'GPV3.1': dark('08:00-10:00', '17:00-20:00') }) });
  kyiv.read(t + 30 * MIN, later);
  const { sent } = kyiv.read(t + 32 * MIN, later);
  assert.deepEqual(sent.map((event) => event.kind), ['revised']);
  assert.deepEqual(sent[0].text, {
    title: 'Оперативні зміни в графіку',
    subtitle: 'Полтавська область · Черга 3.1',
    body: 'Далі сьогодні без світла 17:00–20:00 (на 1 год більше).'
  });
});

test('today published the same day is told from the next hour on', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 13:10');
  const out = poltava({ [TODAY]: day({ 'GPV3.1': dark('10:00-12:00', '14:00-17:30', '21:00-24:00') }) });
  kyiv.read(t - 2 * MIN, poltava());
  kyiv.read(t, out);
  const { sent } = kyiv.read(t + 2 * MIN, out);
  // Only GPV3.1: a clear queue today is never news.
  assert.deepEqual(sent.map((event) => event.text), [{
    title: 'Зʼявився графік на сьогодні',
    subtitle: 'Полтавська область · Черга 3.1',
    body: 'Далі сьогодні без світла 14:00–17:30, 21:00–24:00 (разом 6 год 30 хв).'
  }]);
});

test('possible outages coming and going are not news', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 18:00');
  const with_ = (hours) => poltava({ [TOMORROW]: day({ 'GPV3.1': { ...dark('07:00-10:00'), ...hours } }) });
  kyiv.read(t, with_({}));
  let minute = 0;
  // Чернігів's open-ended amendments land as `maybe`/`msecond`; so do Київ's possible hours.
  for (const hours of [{ 14: 'maybe' }, { 14: 'maybe', 15: 'mfirst' }, { 20: 'msecond' }, {}]) {
    for (let i = 0; i < 2; i++) assert.equal(kyiv.read(t + (minute += 2) * MIN, with_(hours)).sent.length, 0);
  }
});

// --- Rates and caps

test('one alert per quarter hour, the latest state after it, five a day, sound on three', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 10:00');
  const plan = (...ranges) => poltava({ [TOMORROW]: day({ 'GPV3.1': dark(...ranges), 'GPV1.1': dark('01:00-02:00') }) });
  const step = (minute, snapshot) => kyiv.read(t + minute * MIN, snapshot).sent.filter((event) => event.queue === 'GPV3.1');
  step(0, plan('07:00-10:00'));                              // bootstrap

  step(2, plan('07:00-11:00'));
  const first = step(4, plan('07:00-11:00'));
  assert.equal(first.length, 1);
  assert.equal(first[0].message.message.apns.payload.aps.sound, 'default');
  step(6, plan('07:00-12:00'));
  assert.equal(step(8, plan('07:00-12:00')).length, 0);     // held: four minutes after the first
  step(13, plan('07:00-13:00'));
  assert.equal(step(15, plan('07:00-13:00')).length, 0);    // still held
  const latest = step(19, plan('07:00-13:00'));             // fifteen minutes on: the latest state
  assert.equal(latest.length, 1);
  assert.match(latest[0].text.body, /07:00–13:00/);

  // A revert to what was told, inside the gap: nothing, then or after.
  step(21, plan('07:00-14:00'));
  assert.equal(step(23, plan('07:00-14:00')).length, 0);
  assert.equal(step(25, plan('07:00-13:00')).length, 0);
  assert.equal(step(40, plan('07:00-13:00')).length, 0);

  const third = (step(41, plan('07:00-15:00')), step(43, plan('07:00-15:00')));
  assert.equal(third[0].message.message.apns.payload.aps.sound, 'default');
  const fourth = (step(60, plan('07:00-16:00')), step(62, plan('07:00-16:00')));
  const fifth = (step(80, plan('07:00-17:00')), step(82, plan('07:00-17:00')));
  for (const quiet of [fourth[0], fifth[0]]) {
    assert.equal(quiet.message.message.apns.payload.aps.sound, undefined);
    assert.equal(quiet.message.message.apns.payload.aps['interruption-level'], 'passive');
  }
  step(100, plan('07:00-18:00'));
  const { sent, log } = kyiv.read(t + 102 * MIN, plan('07:00-18:00'));
  assert.equal(sent.length, 0);
  assert.ok(log.some((entry) => entry.key === `poltava|GPV3.1|${TOMORROW}` && entry.outcome === 'adopted(cap)'));
});

// --- Cancellations and quiet days

test('a cancellation needs three reads over four minutes of a day still published', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 14:10');
  kyiv.read(t - 2 * MIN, poltava({ [TODAY]: day({ 'GPV3.1': dark('18:00-20:00') }) }));
  const clear = poltava({ [TODAY]: day() });
  assert.equal(kyiv.read(t, clear).sent.length, 0);
  // Two reads five minutes apart are not enough for this one.
  assert.equal(kyiv.read(t + 5 * MIN, clear).sent.length, 0);
  const { sent } = kyiv.read(t + 7 * MIN, clear);
  assert.deepEqual(sent.map((event) => [event.kind, event.text.title, event.text.body]),
    [['cancelled', 'Оперативні зміни в графіку', 'Далі сьогодні вимкнень не заплановано.']]);
});

test('tomorrow cancelled says so; a day withdrawn says nothing', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 21:00');
  kyiv.read(t, poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) }));
  const clear = poltava({ [TOMORROW]: day() });
  kyiv.read(t + 2 * MIN, clear);
  kyiv.read(t + 4 * MIN, clear);
  const { sent } = kyiv.read(t + 6 * MIN, clear);
  assert.deepEqual(sent.map((event) => event.text.title), ['Вимкнення на завтра скасовано']);
  assert.equal(sent[0].text.body, 'Пт, 9 жовтня: за оновленим графіком вимкнень не заплановано.');

  const withdrawn = reader(POLTAVA);
  withdrawn.read(t, poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) }));
  for (let minute = 2; minute <= 12; minute += 2) assert.equal(withdrawn.read(t + minute * MIN, poltava()).sent.length, 0);
});

test('an all-light day never announced is not news', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 21:00');
  kyiv.read(t, poltava());
  for (let minute = 2; minute <= 8; minute += 2) {
    assert.equal(kyiv.read(t + minute * MIN, poltava({ [TODAY]: day(), [TOMORROW]: day() })).sent.length, 0);
  }
});

test('Полтава quiet tomorrow is told after a day of outages, and not after a quiet one', () => {
  const t = at('2026-10-08 20:50');
  const afterOutages = reader(POLTAVA);
  const outages = { [TODAY]: day({ 'GPV3.1': dark('18:00-21:00') }) };
  afterOutages.read(t - 2 * MIN, poltava(outages));
  afterOutages.read(t, poltava(outages, { quiet: [TOMORROW] }));
  const { sent } = afterOutages.read(t + 2 * MIN, poltava(outages, { quiet: [TOMORROW] }));
  assert.deepEqual(sent.map((event) => [event.queue, event.text.title, event.text.body]), [[
    'GPV3.1', 'Графік на завтра: без вимкнень', 'Пт, 9 жовтня: оператор не прогнозує вимкнень за графіком.'
  ]]);

  const outOfSeason = reader(POLTAVA);
  outOfSeason.read(t - 2 * MIN, poltava({}, { quiet: [TODAY] }));
  outOfSeason.read(t, poltava({}, { quiet: [TODAY, TOMORROW] }));
  const quiet = outOfSeason.read(t + 2 * MIN, poltava({}, { quiet: [TODAY, TOMORROW] }));
  assert.equal(quiet.sent.length, 0);
  assert.ok(outcomes(quiet.log).every((outcome) => outcome === 'adopted(quiet-gate)'));
});

test('Telegram\'s light padding is «не заплановано» only when someone else is dark', () => {
  // A channel table naming a few subqueues is padded with light for the rest (lib/telegram.mjs).
  const kharkiv = regionById('kharkiv');
  const snapshot = (fact = {}) => buildSnapshot({
    regionId: 'kharkiv', title: kharkiv.title, queues: queueNames(NATIONAL_QUEUES), fact, source: 'kharkiv'
  });
  const padded = (queues) => snapshot({ [TOMORROW]: day(queues) });
  const t = at('2026-10-08 20:00');
  const lit = reader(kharkiv);
  lit.read(t - 2 * MIN, snapshot());
  lit.read(t, padded({}));
  assert.equal(lit.read(t + 2 * MIN, padded({})).sent.length, 0);

  const mixed = reader(kharkiv);
  mixed.read(t - 2 * MIN, snapshot());
  mixed.read(t, padded({ 'GPV2.2': dark('12:00-14:00') }));
  const { sent } = mixed.read(t + 2 * MIN, padded({ 'GPV2.2': dark('12:00-14:00') }));
  assert.equal(sent.length, 12);
  assert.equal(sent.filter((event) => /не заплановано/.test(event.text.body)).length, 11);
});

// --- Our own changes, and gaps

test('new adapter code adopts its first read silently, then works as before', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 20:00');
  const before = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) });
  const after = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-11:00') }) });
  kyiv.read(t, before);
  const first = kyiv.read(t + 2 * MIN, after, { fp: 'fp2' });
  assert.equal(first.sent.length, 0);
  assert.ok(outcomes(first.log).every((outcome) => outcome === 'adopted(rebaseline)'));
  assert.equal(kyiv.read(t + 4 * MIN, after, { fp: 'fp2' }).sent.length, 0);
  const next = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-12:00') }) });
  kyiv.read(t + 6 * MIN, next, { fp: 'fp2' });
  assert.deepEqual(kyiv.read(t + 8 * MIN, next, { fp: 'fp2' }).sent.map((event) => event.kind), ['revised']);
});

test('back after a gap: today is adopted, tomorrow is still told', () => {
  assert.ok(GAP_MS >= 30 * MIN);
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 19:00');
  kyiv.read(t, poltava({ [TODAY]: day({ 'GPV3.1': dark('21:00-23:00') }) }));
  const back = poltava({ [TODAY]: day({ 'GPV3.1': dark('20:00-23:00') }), [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) });
  const first = kyiv.read(t + 45 * MIN, back);
  assert.ok(first.log.some((entry) => entry.key === `poltava|GPV3.1|${TODAY}` && entry.outcome === 'adopted(gap)'));
  const { sent } = kyiv.read(t + 47 * MIN, back);
  assert.ok(sent.length > 0);
  assert.ok(sent.every((event) => event.day === TOMORROW && event.kind === 'published'));
});

test('a region on the slow lane, read every six minutes, still settles and is no gap', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 20:30');
  const out = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) });
  kyiv.read(t, poltava());
  assert.equal(kyiv.read(t + 6 * MIN, out).sent.length, 0);
  assert.equal(kyiv.read(t + 12 * MIN, out).sent.length, 12);
});

test('a day adopted at bootstrap that then changes is «змінено», never «зʼявився»', () => {
  const kyiv = reader(POLTAVA);
  const t = at('2026-10-08 21:00');
  kyiv.read(t, poltava({ [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) }));
  const changed = poltava({ [TOMORROW]: day({ 'GPV3.1': dark('08:00-11:00') }) });
  kyiv.read(t + 2 * MIN, changed);
  const { sent } = kyiv.read(t + 4 * MIN, changed);
  assert.deepEqual(sent.map((event) => [event.kind, event.text.title]), [['revised', 'Графік на завтра змінено']]);
  assert.match(sent[0].text.body, /час змінився/);
});

// --- Emergency

test('Київ\'s emergency is told once per day, after two reads, and never again', () => {
  const t = at('2026-10-07 12:00');
  const plain = YASNO.kyivUpstream;
  const flagged = structuredClone(plain);
  flagged.fact.emergency = [1791320400];
  const kyiv = reader(KYIV);
  kyiv.read(t - 2 * MIN, plain);
  assert.equal(kyiv.read(t, flagged).sent.length, 0);
  const { sent } = kyiv.read(t + 2 * MIN, flagged);
  assert.equal(sent.length, 1);
  const { message } = sent[0];
  assert.equal(message.message.topic, 'e_kyiv');
  assert.equal(message.message.data.queue, undefined);
  assert.equal(message.message.data.deep_link, 'svitlo://day?region=kyiv&day=1791320400');
  assert.equal(message.message.apns.payload.aps['interruption-level'], 'time-sensitive');
  assert.deepEqual(sent[0].text, {
    title: 'Аварійні відключення', subtitle: 'Київ',
    body: 'Оператор вимикає світло понад графік. Сьогодні графік може не виконуватися.'
  });
  // Dropped and back: nothing.
  for (const [minute, snapshot] of [[4, plain], [6, plain], [8, flagged], [10, flagged], [12, flagged]]) {
    assert.equal(kyiv.read(t + minute * MIN, snapshot).sent.length, 0);
  }
});

test('emergency tomorrow names the day; Полтава never has an emergency topic', () => {
  const tomorrow = render({ type: 'emergency', kind: 'emergency', region: 'dnipro', day: 1791406800, regionTitle: 'Дніпро' },
    new Date(at('2026-10-07 21:00')));
  assert.deepEqual(tomorrow, {
    title: 'Аварійні відключення завтра', subtitle: 'Дніпро',
    body: 'Оператор попередив про відключення понад графік на чт, 8 жовтня.'
  });
  const snapshot = poltava({ [TODAY]: day({ 'GPV3.1': dark('18:00-20:00') }) });
  snapshot.fact.emergency = [TODAY, TOMORROW];
  assert.deepEqual(observeRegion(POLTAVA, snapshot, new Date(at('2026-10-08 12:00'))).emergency, []);
});

// --- Pictures

const sumyDay = (post, image, extra = {}) => buildSnapshot({
  regionId: 'sumy', title: SUMY.title, queues: queueNames(NATIONAL_QUEUES), source: 'sumy',
  sheets: [{ dayStart: TOMORROW, imageUrl: image, sourceUrl: `https://t.me/SumyEnergo/${post}`, caption: null, isRevision: false, ...extra }]
});

test('a picture day is told on s_, and a rotated CDN url of the same post is not news', () => {
  const sumy = reader(SUMY);
  const t = at('2026-10-08 19:00');
  sumy.read(t - 2 * MIN, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg', { dayStart: TODAY }));
  sumy.read(t, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg'));
  const { sent } = sumy.read(t + 2 * MIN, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.message.topic, 's_sumy');
  assert.equal(sent[0].message.message.data.deep_link, `svitlo://day?region=sumy&day=${TOMORROW}`);
  assert.deepEqual(sent[0].text, {
    title: 'Зʼявився графік на завтра', subtitle: 'Сумська область',
    body: 'Оператор опублікував графік на пт, 9 жовтня картинкою — відкрийте, щоб знайти свою чергу.'
  });
  for (const minute of [4, 6, 8]) assert.equal(sumy.read(t + minute * MIN, sumyDay(2594, `https://cdn5.telesco.pe/file/${minute}.jpg`)).sent.length, 0);

  // A new post for the same day is a new version of it.
  sumy.read(t + 20 * MIN, sumyDay(2603, 'https://cdn4.telesco.pe/file/b.jpg'));
  const revised = sumy.read(t + 22 * MIN, sumyDay(2603, 'https://cdn4.telesco.pe/file/b.jpg')).sent;
  assert.deepEqual(revised.map((event) => [event.kind, event.text.title, event.text.body]), [[
    'sheet-revised', 'Графік на завтра оновлено',
    'Оператор опублікував нову версію графіка картинкою — відкрийте, щоб перевірити свою чергу.'
  ]]);
});

test('Волинь\'s page never changes, so its picture\'s own path is the identity', () => {
  const page = 'https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/';
  const volyn = (path) => buildSnapshot({
    regionId: 'volyn', title: VOLYN.title, queues: queueNames(NATIONAL_QUEUES), source: 'volyn',
    sheets: [{ dayStart: TOMORROW, imageUrl: `https://api-voe-poweron.inneti.net${path}`, sourceUrl: page, caption: null, isRevision: false }]
  });
  assert.equal(sheetKey(volyn('/media/a.png').sheets[0]), 'https://api-voe-poweron.inneti.net/media/a.png');
  const reading = reader(VOLYN);
  const t = at('2026-10-08 21:08');
  reading.read(t, volyn('/media/a.png'));
  reading.read(t + 2 * MIN, volyn('/media/b.png'));
  const { sent } = reading.read(t + 4 * MIN, volyn('/media/b.png'));
  assert.deepEqual(sent.map((event) => event.kind), ['sheet-revised']);
});

test('a picture the operator marks as an amendment is told as one', () => {
  const sheet = (revision) => buildSnapshot({
    regionId: 'khmelnytskyi', title: KHMELNYTSKYI.title, queues: queueNames(NATIONAL_QUEUES), source: 'khmelnytskyi', sheetBased: true,
    sheets: [{ dayStart: TOMORROW, imageUrl: 'https://hoe.com.ua/Content/Uploads/2026/10/file20261008200000000.png', sourceUrl: 'https://hoe.com.ua/page/x', caption: 'Оновлений графік', isRevision: revision }]
  });
  const reading = reader(KHMELNYTSKYI);
  const t = at('2026-10-08 20:00');
  reading.read(t, buildSnapshot({ regionId: 'khmelnytskyi', title: KHMELNYTSKYI.title, queues: queueNames(NATIONAL_QUEUES), source: 'khmelnytskyi', sheetBased: true }));
  reading.read(t + 2 * MIN, sheet(true));
  assert.deepEqual(reading.read(t + 4 * MIN, sheet(true)).sent.map((event) => event.kind), ['sheet-revised']);
});

test('a picture that turns into a table within three hours is the same news; after, a change', () => {
  const t = at('2026-10-08 19:00');
  const table = buildSnapshot({
    regionId: 'sumy', title: SUMY.title, queues: queueNames(NATIONAL_QUEUES), source: 'sumy',
    fact: { [TOMORROW]: day({ 'GPV3.1': dark('07:00-10:00') }) }
  });
  const soon = reader(SUMY);
  soon.read(t - 2 * MIN, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg', { dayStart: TODAY }));
  soon.read(t, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg'));
  assert.equal(soon.read(t + 2 * MIN, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg')).sent.length, 1);
  soon.read(t + 30 * MIN, table);
  const quiet = soon.read(t + 32 * MIN, table);
  assert.equal(quiet.sent.length, 0);
  assert.ok(outcomes(quiet.log).includes('adopted(picture)'));

  const late = reader(SUMY);
  late.read(t - 2 * MIN, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg', { dayStart: TODAY }));
  late.read(t, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg'));
  late.read(t + 2 * MIN, sumyDay(2594, 'https://cdn4.telesco.pe/file/a.jpg'));
  late.read(t + 200 * MIN, table);
  const { sent } = late.read(t + 202 * MIN, table);
  assert.ok(sent.length > 0 && sent.every((event) => event.kind === 'revised'));
  assert.equal(sent.find((event) => event.queue === 'GPV3.1').text.title, 'Графік на завтра змінено');
});

// --- The breaker

test('more than the breaker\'s worth due in one cycle sends nothing and adopts it all', () => {
  const names = Object.fromEntries(Array.from({ length: BREAKER + 1 }, (_, i) => [`GPV${i + 1}.1`, `Група ${i + 1}.1`]));
  const seen = (days) => ({ kyiv: { region: 'kyiv', title: 'Київ', names, days, sheets: {}, emergency: [] } });
  const masks = Object.fromEntries(Object.keys(names).map((queue) => [queue, offMask(dark('07:00-10:00'))]));
  const t = at('2026-10-08 20:00');
  let { ledger } = decide({ ledger: null, observations: seen({}), now: new Date(t), fingerprint: 'fp', freshIds: ['kyiv'] });
  ({ ledger } = decide({ ledger, observations: seen({ [TOMORROW]: { state: 'fact', masks } }), now: new Date(t + 2 * MIN), fingerprint: 'fp', freshIds: ['kyiv'] }));
  const result = decide({ ledger, observations: seen({ [TOMORROW]: { state: 'fact', masks } }), now: new Date(t + 4 * MIN), fingerprint: 'fp', freshIds: ['kyiv'] });
  assert.equal(result.due.length, 0);
  assert.equal(result.breaker.count, BREAKER + 1);
  assert.equal(result.breaker.sample.length, 10);
  assert.equal(result.ledger.breakerAt, t + 4 * MIN);
  assert.equal(outcomes(result.log).filter((outcome) => outcome === 'adopted(breaker)').length, BREAKER + 1);
  // Adopted: the next read is quiet too.
  assert.equal(decide({ ledger: result.ledger, observations: seen({ [TOMORROW]: { state: 'fact', masks } }), now: new Date(t + 6 * MIN), fingerprint: 'fp', freshIds: ['kyiv'] }).due.length, 0);
});

// --- The message itself

const event = (over = {}) => ({
  key: `poltava|GPV3.1|${TOMORROW}`, type: 'queue', region: 'poltava', queue: 'GPV3.1', day: TOMORROW,
  kind: 'published', mask: offMask(dark('07:00-10:00')), base: null, regionTitle: 'Полтавська область',
  queueName: 'Черга 3.1', sends: 0, ...over
});

test('at night an alert arrives without a sound; an emergency by day is time-sensitive', () => {
  const night = new Date(at('2026-10-08 23:00'));
  const aps = buildMessage(event(), render(event(), night), night).message.apns.payload.aps;
  assert.equal(aps['interruption-level'], 'passive');
  assert.equal(aps.sound, undefined);
  assert.equal(isNight(new Date(at('2026-10-08 22:29'))), false);
  assert.equal(isNight(new Date(at('2026-10-08 22:30'))), true);
  assert.equal(isNight(new Date(at('2026-10-09 06:59'))), true);
  assert.equal(isNight(new Date(at('2026-10-09 07:00'))), false);

  const noon = new Date(at('2026-10-08 12:00'));
  const emergency = { type: 'emergency', kind: 'emergency', region: 'kyiv', day: TODAY, regionTitle: 'Київ', sends: 0 };
  const day = buildMessage(emergency, render(emergency, noon), noon).message.apns.payload.aps;
  assert.equal(day['interruption-level'], 'time-sensitive');
  assert.equal(day.sound, 'default');
});

test('the payload: string data, a short collapse id, the end of its day, a link that reads back', () => {
  const now = new Date(at('2026-10-08 20:45'));
  const { message } = buildMessage(event(), render(event(), now), now);
  assert.equal(message.topic, 'q_poltava_GPV3-1');
  assert.ok(Object.values(message.data).every((value) => typeof value === 'string'));
  assert.deepEqual(message.data, {
    type: 'news', kind: 'published', region: 'poltava', queue: 'GPV3.1', day: String(TOMORROW),
    campaign: 'news_published', deep_link: `svitlo://day?region=poltava&queue=GPV3.1&day=${TOMORROW}`
  });
  assert.equal(message.apns.headers['apns-priority'], '10');
  assert.equal(message.apns.headers['apns-push-type'], 'alert');
  assert.equal(message.apns.headers['apns-collapse-id'], `n.poltava.GPV3.1.${TOMORROW}`);
  assert.equal(message.apns.headers['apns-expiration'], String(kyivTomorrowStart(new Date(TOMORROW * 1000))));
  assert.equal(message.apns.headers['apns-expiration'], String(TOMORROW + 86400));
  assert.equal(message.apns.payload.aps['thread-id'], `poltava.${TOMORROW}`);
  assert.equal(message.apns.payload.aps['content-available'], 1);
  assert.equal(message.android, undefined);

  // Тернопіль's free-text labels: hashed, ASCII, and within APNs' 64 bytes.
  const long = event({ region: 'ternopil', queue: 'Черга 1 (додаткова, з 18:00 до 22:00)', regionTitle: 'Тернопільська область' });
  const header = buildMessage(long, render(long, now), now).message.apns.headers['apns-collapse-id'];
  assert.match(header, /^n\.[0-9a-f]{24}$/);
  assert.ok(Buffer.byteLength(header) <= 64);

  // The link reads back to what was sent.
  const link = new URL(buildMessage(long, render(long, now), now).message.data.deep_link);
  assert.equal(link.protocol, 'svitlo:');
  assert.equal(link.host, 'day');
  assert.equal(link.searchParams.get('region'), 'ternopil');
  assert.equal(link.searchParams.get('queue'), 'Черга 1 (додаткова, з 18:00 до 22:00)');
  assert.equal(Number(link.searchParams.get('day')), TOMORROW);
});

test('a day that is neither today nor tomorrow any more is not rendered', () => {
  assert.equal(render(event({ day: TODAY - 86400 }), new Date(at('2026-10-08 20:00'))), null);
  assert.equal(dayLabel(TOMORROW), 'пт, 9 жовтня');
  assert.equal(kyivDayStart(new Date(at('2026-10-08 20:00'))), TODAY);
});
