import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The page's own scripts, run as a browser would run them: no build step stands between these files and a phone.
const load = (name) => {
  const sandbox = { Intl, Date, Math, Number, String, Object, Array, isNaN, Error };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(new URL(`../../firebase/public/add/${name}`, import.meta.url), 'utf8'), sandbox, { filename: name });
  return sandbox;
};
const S = load('schedule.js').KolySvitloSchedule;
const TEXTS = load('texts.js').KolySvitloTexts;
const plain = (value) => JSON.parse(JSON.stringify(value));   // objects made in the sandbox have its prototypes

const DAY = 1795125600;        // 20 November 2026, 00:00 in Kyiv
const NEXT = DAY + 86400;
const at = (iso) => Date.parse(iso);

const row = (marks) => {
  const hours = {};
  for (let hour = 1; hour <= 24; hour++) hours[hour] = marks[hour] ?? 'yes';
  return hours;
};
// Off 10:30–14:00 and 21:00–24:00, as Львів's first queue had it that morning.
const QUEUE = row({ 11: 'second', 12: 'no', 13: 'no', 14: 'no', 22: 'no', 23: 'no', 24: 'no' });

test('the Kyiv clock: winter and summer, and midnight is 0, never 24', () => {
  assert.deepEqual(plain(S.kyivParts(at('2026-11-20T08:30:00Z'))), { year: 2026, month: 11, day: 20, hour: 10, minute: 30, key: '2026-11-20' });
  assert.deepEqual(plain(S.kyivParts(at('2026-07-01T21:05:00Z'))), { year: 2026, month: 7, day: 2, hour: 0, minute: 5, key: '2026-07-02' });
  assert.equal(S.kyivParts(DAY * 1000).hour, 0);
  assert.equal(S.kyivParts(DAY * 1000).key, '2026-11-20');
});

test('a browser that cannot name the zone gets the same clock from the European rule', () => {
  // Every half hour of two years, and so both changes of each: 29.03.2026, 25.10.2026, 28.03.2027, 31.10.2027.
  const from = at('2026-01-01T00:00:00Z');
  for (let i = 0; i < 2 * 365 * 48; i++) {
    const ms = from + i * 1800000;
    const byRule = S.kyivParts(ms, false);
    const byIntl = S.kyivParts(ms);
    if (byRule.key !== byIntl.key || byRule.hour !== byIntl.hour || byRule.minute !== byIntl.minute) {
      assert.fail(`${new Date(ms).toISOString()}: rule ${byRule.key} ${byRule.hour}:${byRule.minute}, Intl ${byIntl.key} ${byIntl.hour}:${byIntl.minute}`);
    }
  }
});

test('a day is found by its date, and an empty array is no days at all', () => {
  const fact = { data: { [DAY]: {}, [NEXT]: {} } };
  assert.equal(S.dayEpoch(fact, '2026-11-20'), String(DAY));
  assert.equal(S.dayEpoch(fact, '2026-11-21'), String(NEXT));
  assert.equal(S.dayEpoch(fact, '2026-11-22'), null);
  assert.equal(S.dayEpoch({ data: [] }, '2026-11-20'), null, 'out of season ДТЕК sends []');
  assert.equal(S.dayEpoch({}, '2026-11-20'), null);
  assert.equal(S.nextKey('2026-11-30'), '2026-12-01');
  assert.equal(S.nextKey('2026-12-31'), '2027-01-01');
});

test('«first» and «second» are halves of an hour, and an unknown word is unknown, not light', () => {
  const fact = { data: { [DAY]: { 'GPV1.1': row({ 1: 'first', 2: 'second', 3: 'no', 4: 'maybe', 5: 'mfirst', 6: 'msecond', 7: 'soon' }) } } };
  const slots = plain(S.slots(fact, String(DAY), 'GPV1.1'));
  assert.equal(slots.length, 48);
  assert.deepEqual(slots.slice(0, 14), ['off', 'on', 'on', 'off', 'off', 'off', 'maybe', 'maybe', 'maybe', 'on', 'on', 'maybe', 'unknown', 'unknown']);
  assert.equal(S.slots(fact, String(DAY), 'GPV9.9'), null, 'a queue the table does not have');
  assert.equal(S.slots(fact, null, 'GPV1.1'), null, 'a day the operator has not published');
});

test('the stretches without power, to the half hour', () => {
  const slots = S.slots({ data: { [DAY]: { 'GPV1.1': QUEUE } } }, String(DAY), 'GPV1.1');
  const off = plain(S.intervals(slots, 'off'));
  assert.deepEqual(off, [{ from: 21, to: 28 }, { from: 42, to: 48 }]);
  assert.deepEqual(off.map((i) => `${S.clock(i.from)}–${S.clock(i.to)}`), ['10:30–14:00', '21:00–24:00']);
  assert.equal(S.minutes(slots, 'off'), 390);
  assert.equal(S.clock(0), '00:00');
  assert.equal(S.clock(52), '02:00', 'past midnight it is tomorrow\'s clock');
});

test('what the schedule says now and until when', () => {
  const today = S.slots({ data: { [DAY]: { q: QUEUE } } }, String(DAY), 'q');
  const clear = S.slots({ data: { [DAY]: { q: row({}) } } }, String(DAY), 'q');
  const morningOff = S.slots({ data: { [DAY]: { q: row({ 1: 'no', 2: 'no' }) } } }, String(DAY), 'q');

  assert.deepEqual(plain(S.status(today, null, 20)), { state: 'on', until: 21 });      // 10:00 → off at 10:30
  assert.deepEqual(plain(S.status(today, null, 21)), { state: 'off', until: 28 });     // 10:30 → on at 14:00
  assert.deepEqual(plain(S.status(today, null, 44)), { state: 'off', until: null }, 'the published days end before any change');
  assert.deepEqual(plain(S.status(today, clear, 44)), { state: 'off', until: 48 }, 'on at midnight');
  assert.deepEqual(plain(S.status(today, morningOff, 44)), { state: 'off', until: 52 }, 'the outage runs into tomorrow, to 02:00');
  assert.equal(S.status(null, clear, 10), null);
});

test('an order beyond the schedule: the region\'s, or the queue\'s own operator\'s and no other', () => {
  const fact = {
    emergency: [DAY], emergencyNote: '«…діють екстрені відключення.» — сайт ДТЕК',
    queueEmergency: { queues: ['GPV1005.2'], days: [], note: null }
  };
  assert.deepEqual(plain(S.emergency(fact, 'GPV1.1', String(DAY))), { on: true, note: '«…діють екстрені відключення.» — сайт ДТЕК' });
  assert.deepEqual(plain(S.emergency(fact, 'GPV1.1', String(NEXT))), { on: false, note: null });
  assert.deepEqual(plain(S.emergency(fact, 'GPV1005.2', String(DAY))), { on: false, note: null }, 'ЦЕК has no order: ДТЕК\'s is not its');
  const own = { emergency: [], queueEmergency: { queues: ['GPV1005.2'], days: [DAY], note: 'Наказ ЦЕК' } };
  assert.deepEqual(plain(S.emergency(own, 'GPV1005.2', String(DAY))), { on: true, note: 'Наказ ЦЕК' });
  assert.deepEqual(plain(S.emergency(own, 'GPV1.1', String(DAY))), { on: false, note: null });
  assert.deepEqual(plain(S.emergency({}, 'GPV1.1', null)), { on: false, note: null });
});

test('queues come in the order of their numbers, with the operator\'s names', () => {
  const data = {
    preset: { sch_names: { 'GPV10.1': 'Група 10.1', 'GPV2.1': 'Група 2.1', 'GPV1001.1': 'ЦЕК 1.1', 'GPV1.1': 'Група 1.1' } },
    fact: { data: { [DAY]: { 'GPV3.1': {}, 'GPV1.1': {} } } }
  };
  assert.deepEqual(plain(S.queues(data)), [
    { id: 'GPV1.1', name: 'Група 1.1' }, { id: 'GPV2.1', name: 'Група 2.1' }, { id: 'GPV3.1', name: 'Черга 3.1' },
    { id: 'GPV10.1', name: 'Група 10.1' }, { id: 'GPV1001.1', name: 'ЦЕК 1.1' }
  ]);
  assert.deepEqual(plain(S.queues({ fact: { data: [] } })), []);
});

test('the whole page for a queue at 10:10: today published, tomorrow not', () => {
  const data = { fact: { data: { [DAY]: { 'GPV1.1': QUEUE } }, update: '08:48 20.11.2026', emergency: [DAY], emergencyNote: 'слова оператора' } };
  const view = S.view(data, 'GPV1.1', at('2026-11-20T08:10:00Z'));
  assert.equal(view.nowSlot, 20);
  assert.deepEqual(plain(view.status), { state: 'on', until: 21 });
  assert.equal(view.today.published, true);
  assert.equal(view.today.date, '2026-11-20');
  assert.equal(view.today.offMinutes, 390);
  assert.deepEqual(plain(view.today.emergency), { on: true, note: 'слова оператора' });
  assert.equal(view.tomorrow.published, false);
  assert.equal(view.tomorrow.date, '2026-11-21');
  assert.deepEqual(plain(view.tomorrow.off), []);
  assert.equal(view.update, '08:48 20.11.2026');
});

test('a day nobody published is said to be unpublished, never drawn from the weekly template', () => {
  const data = { preset: { data: { 'GPV1.1': { 5: row({ 1: 'no' }) } }, sch_names: { 'GPV1.1': 'Черга 1.1' } }, fact: { data: [] } };
  const view = S.view(data, 'GPV1.1', at('2026-11-20T08:10:00Z'));
  assert.equal(view.today.published, false);
  assert.equal(view.status, null);
  assert.equal(view.update, null);
});

test('no language misses a line of the page, and every placeholder is kept', () => {
  const keys = Object.keys(TEXTS.uk).sort();
  for (const lang of ['ru', 'en']) {
    assert.deepEqual(Object.keys(TEXTS[lang]).sort(), keys, lang);
    for (const key of keys) {
      const marks = (text) => (text.match(/\{[a-z]+\}/g) ?? []).sort();
      assert.deepEqual(marks(TEXTS[lang][key]), marks(TEXTS.uk[key]), `${lang}.${key}`);
      assert.ok(TEXTS[lang][key].length > 0, `${lang}.${key}`);
    }
  }
});

test('the page asks for every word it shows, and for none that is not there', () => {
  const html = fs.readFileSync(new URL('../../firebase/public/add/index.html', import.meta.url), 'utf8');
  const asked = new Set([...html.matchAll(/\bt\.([A-Za-z]+)\b/g)].map((m) => m[1]));
  for (const key of asked) assert.ok(key in TEXTS.uk, `the page asks for t.${key}`);
  for (const key of Object.keys(TEXTS.uk)) assert.ok(asked.has(key), `texts.js has «${key}» that the page never shows`);
});
