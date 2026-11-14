import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readEmergency } from './lib/dtek-emergency.mjs';
import { cekTargets, mergeCekQueues, withCekQueues } from './lib/cek-in-dnipro.mjs';
import { scheduleOf, snapshotFrom } from './sources/cek.mjs';
import { buildSnapshot, validate } from './lib/canonical.mjs';
import { regionById } from './regions.mjs';

// A letter of 13 November 2026: «Дніпро та обл.», queue «ЦЕК 5.2», 23:48 — «Вимкнень не заплановано», a forecast, while ЦЕК's own
// table had 5.2 off from 23:30. Two things were wrong on the server, and both are here: ДТЕК's region lists ЦЕК's queues and gives
// them no hours, and ЦЕК's region was under an emergency warning all night for an order that was Павлоград's alone and already over.

const post = (id, postedAt, text) => ({ id, postedAt, text });
const at = (iso) => new Date(iso);
const day = (iso) => Math.floor(Date.parse(`${iso}T00:00:00+02:00`) / 1000);
const CEK = regionById('cek');

// @cek_info, 12–13 November 2026, in the operator's words.
const DNIPRO_ON = post(4370, '2026-11-12T15:00:00+00:00', '📢 Шановні споживачі м. ДНІПРО ‼️ Попереджаємо, що за командою диспетчерського центру НЕК "Укренерго" застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ ‼️ ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ не діють ‼️');
const DNIPRO_OFF = post(4371, '2026-11-12T16:36:00+00:00', '📢 Шановні споживачі м. ДНІПРО ‼️ Повідомляємо про скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️ Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ ‼️');
const PAVLOHRAD_ON = post(4385, '2026-11-13T16:22:56+00:00', '📢 Шановні споживачі м. ПАВЛОГРАД, які відключаються за окремим графіком ‼️ Повідомляємо, що зараз за вашими адресами діють ЕКСТРЕНІ ВІДКЛЮЧЕННЯ ‼️ ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ не діють ‼️');
const PAVLOHRAD_OFF = post(4386, '2026-11-13T16:54:00+00:00', '📢 Шановні споживачі м. ПАВЛОГРАД ‼️ Повідомляємо про скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️ Повертаємося до вашого ГРАФІКА ПОГОДИННИХ ВІДКЛЮЧЕНЬ ‼️');
const NOVEMBER = [DNIPRO_ON, DNIPRO_OFF, PAVLOHRAD_ON, PAVLOHRAD_OFF];

const own = (posts, now, extra = {}) => readEmergency(posts, { now: at(now), area: 'own', maxAgeMs: 36 * 3600 * 1000, ...extra });

// MARK: - The emergency on ЦЕК's channel

test('an order for Дніпро is on from its post until its cancelling, and the warning says whom it is for', () => {
  const during = own(NOVEMBER, '2026-11-12T15:30:00Z');
  assert.equal(during.active, true);
  assert.equal(during.since, '2026-11-12T15:00:00+00:00');
  assert.equal(during.note, 'для споживачів м. Дніпро', 'the region is more than the city: the banner says where');
  assert.equal(own(NOVEMBER, '2026-11-12T16:40:00Z').active, false);
});

test('«скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ … Повертаємося до вашого ГРАФІКА» ends an order', () => {
  // Without the region's `skip`, to see the words themselves read: on 13 November they were not, and the order stood for the night.
  assert.equal(own(NOVEMBER, '2026-11-13T16:30:00Z').active, true);
  assert.equal(own(NOVEMBER, '2026-11-13T17:00:00Z').active, false);
  assert.equal(own(NOVEMBER, '2026-11-13T21:48:00Z').active, false, 'the hour the letter was written');
  // Each of the two phrases by itself.
  const on = post(1, '2026-11-13T10:00:00+00:00', '📢 Шановні споживачі ‼️ Діють ЕКСТРЕНІ ВІДКЛЮЧЕННЯ ‼️');
  const noun = post(2, '2026-11-13T11:00:00+00:00', '📢 Шановні споживачі ‼️ Повідомляємо про скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️');
  const back = post(3, '2026-11-13T11:00:00+00:00', '📢 Шановні споживачі ‼️ Повертаємося до вашого ГРАФІКА ПОГОДИННИХ ВІДКЛЮЧЕНЬ ‼️');
  assert.equal(own([on], '2026-11-13T12:00:00Z').active, true);
  assert.equal(own([on, noun], '2026-11-13T12:00:00Z').active, false, '«скасування», the noun');
  assert.equal(own([on, back], '2026-11-13T12:00:00Z').active, false, 'a word between «до» and «графіка»');
});

test('Павлоград\'s own order is not the twelve queues\': it neither starts nor ends the region\'s warning', () => {
  const skip = CEK.emergencyTelegram.skip;
  assert.ok(skip.test(PAVLOHRAD_ON.text) && skip.test(PAVLOHRAD_OFF.text));
  assert.ok(!skip.test(DNIPRO_ON.text) && !skip.test(DNIPRO_OFF.text));
  assert.equal(own(NOVEMBER, '2026-11-13T16:30:00Z', { skip }).active, false, 'Павлоград\'s order, while it was on');
  // An order for everyone that Павлоград's cancelling follows is still on.
  const everyone = post(4384, '2026-11-13T16:00:00+00:00', '📢 Шановні споживачі ‼️ Діють ЕКСТРЕНІ ВІДКЛЮЧЕННЯ ‼️ ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ не діють ‼️');
  assert.equal(own([everyone, PAVLOHRAD_ON, PAVLOHRAD_OFF], '2026-11-13T17:30:00Z', { skip }).active, true);
});

test('the region as the server reads it: no warning on the night of the letter', async () => {
  const snapshot = await snapshotFrom(NOVEMBER, CEK, { now: at('2026-11-13T21:48:00Z'), log: () => {} });
  assert.equal(snapshot.fact?.emergency, undefined);
  const during = await snapshotFrom(NOVEMBER, CEK, { now: at('2026-11-12T15:30:00Z'), log: () => {} });
  assert.deepEqual(during.fact.emergency, [day('2026-11-12')]);
  assert.equal(during.fact.emergencyNote, 'для споживачів м. Дніпро');
});

// MARK: - ЦЕК's hours under ДТЕК's names

const hours = (off = []) => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), off.includes(i + 1) ? 'no' : 'yes']));
const TODAY = day('2026-11-13');
const TOMORROW = day('2026-11-14');
const YESTERDAY = day('2026-11-12');

/** ДТЕК's Дніпро as the upstream gives it: its own queues with a table for today, ЦЕК's with a name and nothing else. */
function dnipro() {
  return buildSnapshot({
    regionId: 'dnipro',
    title: 'Дніпро та обл.',
    queues: { 'GPV5.1': 'Черга 5.1', 'GPV5.2': 'Черга 5.2', 'GPV1005.1': 'ЦЕК 5.1', 'GPV1005.2': 'ЦЕК 5.2' },
    fact: { [TODAY]: { 'GPV5.1': hours([1, 2]), 'GPV5.2': hours([3, 4]) } },
    todayEpoch: TODAY,
    update: '2026-11-13T20:00:00.000Z',
    source: 'dtek'
  });
}

test('ДТЕК\'s names for ЦЕК\'s queues are found by the names, not by guessing the numbers', () => {
  assert.deepEqual([...cekTargets(dnipro())], [['GPV5.1', 'GPV1005.1'], ['GPV5.2', 'GPV1005.2']]);
  assert.equal(cekTargets({ preset: { sch_names: { 'GPV1.1': 'Черга 1.1' } } }).size, 0);
  assert.equal(cekTargets({}).size, 0);
});

test('ЦЕК\'s hours go under ДТЕК\'s names for them, from today on, and ДТЕК\'s own queues are not touched', () => {
  const before = dnipro();
  const cek = {
    [YESTERDAY]: { 'GPV5.2': hours([10]) },
    [TODAY]: { 'GPV5.1': hours([7, 8, 9]), 'GPV5.2': hours([14, 15, 24]), 'GPV6.1': hours([1]) },
    [TOMORROW]: { 'GPV5.2': hours([1, 2, 3]) }
  };
  const after = mergeCekQueues(before, cek, { today: TODAY });

  assert.deepEqual(after.fact.data[TODAY]['GPV1005.2'], hours([14, 15, 24]), '«ЦЕК 5.2» has ЦЕК\'s 5.2');
  assert.deepEqual(after.fact.data[TODAY]['GPV1005.1'], hours([7, 8, 9]));
  assert.deepEqual(after.fact.data[TODAY]['GPV5.2'], hours([3, 4]), 'ДТЕК\'s own 5.2 keeps ДТЕК\'s hours');
  assert.equal(after.fact.data[TODAY]['GPV1006.1'], undefined, 'a queue ДТЕК does not name here is not added');
  assert.deepEqual(Object.keys(after.fact.data[TOMORROW]), ['GPV1005.2'], 'a day ДТЕК has no table for yet: ЦЕК\'s queues alone');
  assert.equal(after.fact.data[YESTERDAY], undefined, 'not the days gone');
  assert.deepEqual(validate(after), [], 'still a snapshot the app can read');
  assert.equal(before.fact.data[TODAY]['GPV1005.2'], undefined, 'what was given is not changed');
  assert.equal(after.fact.update, before.fact.update, 'the stamp stays ДТЕК\'s');
});

test('nothing to put in, nothing changed', () => {
  const before = dnipro();
  assert.equal(mergeCekQueues(before, {}, { today: TODAY }), before);
  assert.equal(mergeCekQueues(before, { [YESTERDAY]: { 'GPV5.2': hours([1]) } }, { today: TODAY }), before);
  assert.equal(mergeCekQueues(before, { [TODAY]: { 'GPV5.2': { 1: 'no' } } }, { today: TODAY }), before, 'a row that is not 24 hours is not passed on');
  const plain = buildSnapshot({ regionId: 'odesa', title: 'Одеса', queues: { 'GPV1.1': 'Черга 1.1' }, fact: {}, todayEpoch: TODAY, source: 'dtek' });
  assert.equal(mergeCekQueues(plain, { [TODAY]: { 'GPV1.1': hours([1]) } }, { today: TODAY }), plain, 'a region without ЦЕК\'s names');
});

// The channel's own posts of 6–9 November 2026 (the fixture of cek.test.mjs).
const POSTS = JSON.parse(readFileSync(new URL('./cek.fixture-2026-11-09.json', import.meta.url), 'utf8'));

test('read from the channel: the day\'s table with its changes, as the region `cek` has it', async () => {
  const now = at('2026-11-09T10:00:00Z');
  const snapshot = buildSnapshot({
    regionId: 'dnipro', title: 'Дніпро та обл.',
    queues: { 'GPV1.1': 'Черга 1.1', 'GPV1001.1': 'ЦЕК 1.1', 'GPV1006.2': 'ЦЕК 6.2' },
    fact: {}, todayEpoch: day('2026-11-09'), source: 'dtek'
  });
  const after = await withCekQueues(snapshot, { read: async () => POSTS, now, log: () => {} });
  const own9 = scheduleOf(POSTS, { since: day('2026-11-09') }).fact[day('2026-11-09')];
  assert.deepEqual(after.fact.data[day('2026-11-09')]['GPV1001.1'], own9['GPV1.1']);
  assert.deepEqual(after.fact.data[day('2026-11-09')]['GPV1006.2'], own9['GPV6.2']);
  assert.ok(Object.values(own9['GPV1.1']).some((state) => state !== 'yes'), 'and it is a table with cuts in it');
  assert.ok(after.fact.data[day('2026-11-10')], 'tomorrow\'s table, posted that evening');
  assert.equal(after.fact.data[day('2026-11-08')], undefined);
  assert.deepEqual(validate(after), []);
});

test('a channel that cannot be read leaves ДТЕК\'s snapshot as it was', async () => {
  const snapshot = dnipro();
  const lines = [];
  const after = await withCekQueues(snapshot, { read: async () => { throw new Error('timeout'); }, now: at('2026-11-13T21:00:00Z'), log: (line) => lines.push(line) });
  assert.equal(after, snapshot);
  assert.equal(lines.length, 1);
});

test('the region asks for it', () => {
  assert.equal(regionById('dnipro').cekQueues, true);
  assert.equal(regionById('odesa').cekQueues, undefined);
});
