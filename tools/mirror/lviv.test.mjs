import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  factFromItems, itemFrom, parseScheduleText, scheduleText, snapshotFromItems
} from './sources/lviv.mjs';
import { hasSchedule, statusFor, validate } from './lib/canonical.mjs';

// Львівобленерго publishes its schedule as sentences under a picture, so the parser is the whole
// adapter. `lviv.fixture.json` holds 29 items of the operator's own archive, captured once from
// api.loe.lviv.ua/api/menus?type=photo-grafic on 01.10.2026 and kept verbatim except for
// `rawMobileHtml`, which was identical to `rawHtml` in all 520 text items and is dropped. They were
// picked to cover every sentence shape the archive contains: one to five windows a група, :30
// edges, 00:00 starts and 24:00 ends, days published the evening before, revisions of one day,
// days with no outage at all, the one unfilled form (540), a picture-only slot (365) and the
// Укренерго cancellation note (372). The two live slots below are verbatim from the same day.

const ARCHIVE = JSON.parse(readFileSync(new URL('./lviv.fixture.json', import.meta.url), 'utf8')).items;
const REGION = { id: 'lviv', title: 'Львівська область', status: 'seasonal' };

/** /api/menu_items/238 and /256 as served on 01.10.2026 — between seasons, both empty. */
const LIVE_TODAY = {
  '@context': '/api/contexts/MenuItems', '@id': '/api/menu_items/238', '@type': 'MenuItems', id: 238,
  name: 'Today', slug: '', orders: 0, parent: null, children: [], menu: '/api/menus/9', imageUrl: '',
  description: '', rawHtml: '', rawMobileHtml: ''
};
const LIVE_TOMORROW = {
  '@context': '/api/contexts/MenuItems', '@id': '/api/menu_items/256', '@type': 'MenuItems', id: 256,
  name: 'Tomorrow', slug: '', orders: 1, parent: null, children: [], menu: '/api/menus/9', imageUrl: '',
  description: '', rawHtml: '', rawMobileHtml: ''
};

/** An archived item as it would sit in a live slot: same fields, the slot's own id and name. */
function archived(id, overrides = {}) {
  const item = ARCHIVE.find((entry) => entry.id === id);
  if (!item) throw new Error(`fixture ${id} missing`);
  return { ...item, ...overrides };
}
const today = (id, overrides) => archived(id, { id: 238, name: 'Today', ...overrides });
const tomorrow = (id, overrides) => archived(id, { id: 256, name: 'Tomorrow', ...overrides });

/** Moves an archived text to another day, stamp included, leaving every sentence as published. */
function redated(id, day, stampDay = day) {
  return archived(id).rawHtml
    .replace(/на \d{2}\.\d{2}\.\d{4}/, `на ${day}`)
    .replace(/(станом на \d{2}:\d{2}) \d{2}\.\d{2}\.\d{4}/, `$1 ${stampDay}`);
}

/** 24 hour cells, `yes` unless named. */
function day(states = {}) {
  return Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), states[i + 1] ?? 'yes']));
}
const dark = (...hours) => Object.fromEntries(hours.map((hour) => [hour, 'no']));

const JUL_01_2026 = 1782853200;

test('between seasons both slots are empty: queues, no days, and the region stays seasonal', () => {
  const snapshot = snapshotFromItems(REGION, [LIVE_TODAY, LIVE_TOMORROW], new Date('2026-10-01T13:40:00+03:00'));

  assert.deepEqual(validate(snapshot), []);
  assert.equal(Object.keys(snapshot.preset.sch_names).length, 12);
  assert.equal(snapshot.preset.sch_names['GPV6.2'], 'Черга 6.2');
  assert.deepEqual(snapshot.fact.data, []);
  assert.equal(snapshot.fact.update, null);
  assert.equal(snapshot.fact.today, 1790802000);
  assert.equal(hasSchedule(snapshot), false);
  assert.equal(statusFor(REGION, snapshot), 'seasonal');
});

test('every text in the fixture is read in full, all twelve групи', () => {
  const texts = ARCHIVE.filter((item) => item.rawHtml && item.id !== 540);
  assert.equal(texts.length, 26);
  for (const item of texts) {
    const { halves } = parseScheduleText(item.rawHtml);
    assert.equal(Object.keys(halves).length, 12, `item ${item.id}`);
  }
});

test('a published day becomes hours keyed by Kyiv midnight, half-hour edges kept', () => {
  // 01.07.2026, the archive's last text: 1.2 dark 20:30–22:00, 5.2 dark 19:00–20:30, the rest "є".
  const snapshot = snapshotFromItems(REGION, [today(1097), LIVE_TOMORROW], new Date('2026-07-01T18:00:00+03:00'));

  assert.deepEqual(validate(snapshot), []);
  assert.deepEqual(Object.keys(snapshot.fact.data), [String(JUL_01_2026)]);
  assert.deepEqual(snapshot.fact.data[JUL_01_2026]['GPV1.2'], day({ 21: 'second', 22: 'no' }));
  assert.deepEqual(snapshot.fact.data[JUL_01_2026]['GPV5.2'], day({ 20: 'no', 21: 'first' }));
  assert.deepEqual(snapshot.fact.data[JUL_01_2026]['GPV1.1'], day());
  assert.equal(snapshot.fact.update, '17:29 01.07.2026');
  assert.equal(statusFor(REGION, snapshot), 'live');
});

test('00:00 opens the first hour and 24:00 closes the last', () => {
  // 31.10.2025, stamped 19:57 the evening before and filed under tomorrow.
  const { fact } = factFromItems([LIVE_TODAY, tomorrow(547)], new Date('2025-10-30T21:00:00+02:00'));
  const hours = fact[1761861600];

  // 5.1: з 00:00 до 02:30, з 18:00 до 22:00.
  assert.deepEqual(hours['GPV5.1'], day({ ...dark(1, 2, 19, 20, 21, 22), 3: 'first' }));
  // 2.1: з 14:00 до 18:30, з 22:00 до 24:00.
  assert.deepEqual(hours['GPV2.1'], day({ ...dark(15, 16, 17, 18, 23, 24), 19: 'first' }));
});

test('five windows in one sentence are all applied', () => {
  // 18.01.2026, група 1.2: з 01:00 до 04:30, з 08:00 до 09:00, з 11:00 до 11:30,
  // з 15:00 до 18:30, з 22:00 до 24:00.
  const { fact } = factFromItems([today(810), LIVE_TOMORROW], new Date('2026-01-18T09:00:00+02:00'));

  assert.deepEqual(fact[1768687200]['GPV1.2'], day({
    ...dark(2, 3, 4, 9, 16, 17, 18, 23, 24), 5: 'first', 12: 'first', 19: 'first'
  }));
});

test('a day published with no outage at all is a day of light, not a missing day', () => {
  // 05.02.2026, stamped 23:10 the night before: every група "Електроенергія є."
  const snapshot = snapshotFromItems(REGION, [LIVE_TODAY, tomorrow(941)], new Date('2026-02-04T23:30:00+02:00'));
  const hours = snapshot.fact.data[1770242400];

  assert.equal(Object.keys(hours).length, 12);
  for (const queue of Object.values(hours)) assert.deepEqual(queue, day());
  assert.equal(statusFor(REGION, snapshot), 'live');
});

test('when both slots describe one day the later stamp wins, wherever it sits', () => {
  // 22.11.2025: at 14:54 група 4.2 was due off 16:00–17:30; at 15:00 that was withdrawn.
  const now = new Date('2025-11-22T15:10:00+02:00');
  for (const items of [[today(592), tomorrow(591)], [today(591), tomorrow(592)]]) {
    const { fact, update } = factFromItems(items, now);
    assert.deepEqual(fact[1763762400]['GPV4.2'], day());
    assert.equal(update, '15:00 22.11.2025');
  }
});

test('the day comes from the text, never from the slot', () => {
  // 10.04.2026: 11.04 went up at 21:40, then 10.04 itself was revised at 22:19. Here each sits in
  // the other's slot, and neither day may move.
  const snapshot = snapshotFromItems(REGION, [today(1074), tomorrow(1075)], new Date('2026-04-10T22:30:00+03:00'));

  assert.deepEqual(validate(snapshot), []);
  assert.deepEqual(Object.keys(snapshot.fact.data), ['1775768400', '1775854800']);
  assert.deepEqual(snapshot.fact.data[1775768400]['GPV1.1'], day(dark(18, 19, 20, 21)));
  assert.deepEqual(snapshot.fact.data[1775854800]['GPV1.2'], day(dark(7, 8)));
  assert.equal(snapshot.fact.update, '22:19 10.04.2026');
});

test('a text older than today is skipped unread, so a stale slot is never shown as today', () => {
  // Just after midnight, Today still holds yesterday until the operator replaces it.
  const { fact } = factFromItems([today(1097), LIVE_TOMORROW], new Date('2026-07-02T00:20:00+03:00'));
  assert.deepEqual(fact, {});

  // The unfilled form is dated 12.08.2024, so it is dropped as stale before its sentences matter.
  assert.deepEqual(factFromItems([today(540), LIVE_TOMORROW], new Date('2026-10-01T12:00:00+03:00')).fact, {});
});

test('the unfilled form is refused rather than read as a day without power', () => {
  // Item 540: every група "з 00:00 до 00:00", dated 12.08.2024, posted 30.10.2025. Were it dated
  // today, reading 00:00 as midnight would black out the oblast for a whole day.
  const form = today(540, { rawHtml: redated(540, '01.10.2026') });
  const now = new Date('2026-10-01T12:00:00+03:00');
  assert.throws(() => factFromItems([form, LIVE_TOMORROW], now), /does not move forward/);
});

test('an end written 00:00 is midnight; a window running backwards throws', () => {
  const now = new Date('2026-07-01T18:00:00+03:00');
  const ending = (to) => today(1097, { rawHtml: archived(1097).rawHtml.replace('з 20:30 до 22:00', to) });

  const { fact } = factFromItems([ending('з 22:00 до 00:00'), LIVE_TOMORROW], now);
  assert.deepEqual(fact[JUL_01_2026]['GPV1.2'], day(dark(23, 24)));
  assert.throws(() => factFromItems([ending('з 22:00 до 02:00'), LIVE_TOMORROW], now), /does not move forward/);
});

test('any line the archive never contained fails the run', () => {
  const text = archived(1097).rawHtml;
  const swap = (from, to) => text.replace(from, to);
  const broken = {
    'unknown state': [swap('1.1. Електроенергія є.', '1.1. Електроенергія буде.'), /unrecognised line/],
    'unknown sentence': [
      swap('</div>', '<p>Група 3.1. Можливі відключення з 10:00 до 12:00.</p></div>'), /unrecognised line/
    ],
    'unknown група': [swap('Група 6.2.', 'Група 7.1.'), /unrecognised line/],
    'missing група': [swap('<p>Група 6.2. Електроенергія є.</p>', ''), /no sentence for група 6\.2/],
    'група twice': [swap('Група 6.2.', 'Група 6.1.'), /listed twice/],
    'one-digit hour': [swap('з 19:00 до 20:30', 'з 9:00 до 20:30'), /unrecognised line/],
    'hour 25': [swap('з 19:00 до 20:30', 'з 19:00 до 25:00'), /25:00 is not a time/],
    'impossible date': [swap('на 01.07.2026', 'на 31.06.2026'), /31\.06\.2026 is not a date/],
    'no stamp': [swap(/<p><b>Інформація станом на [^<]+<\/b><\/p>/, ''), /no "Інформація станом на"/],
    'stamp two days early': [swap('17:29 01.07.2026', '17:29 29.06.2026'), /stamped/],
    'stamp after the day': [swap('17:29 01.07.2026', '17:29 02.07.2026'), /stamped/],
    'stray entity': [swap('Група 1.1.', 'Група&#32;1.1.'), /unrecognised line/]
  };
  const now = new Date('2026-07-01T18:00:00+03:00');
  for (const [name, [rawHtml, reason]] of Object.entries(broken)) {
    assert.notEqual(rawHtml, text, `${name}: the mutation did not apply`);
    assert.throws(() => factFromItems([today(1097, { rawHtml }), LIVE_TOMORROW], now), reason, name);
  }
});

test('a schedule dated beyond tomorrow throws instead of vanishing', () => {
  // Never seen; a date two days out is a typo, and dropping it silently would hide a real day.
  assert.throws(
    () => factFromItems([today(1097), LIVE_TOMORROW], new Date('2026-06-29T12:00:00+03:00')),
    /2 days ahead/
  );
});

test('a picture without text throws; the Укренерго cancellation note is no day', () => {
  const now = new Date('2026-10-01T12:00:00+03:00');

  // Item 365 (19.11.2024): how this operator published before October 2025 — unreadable here.
  assert.throws(() => factFromItems([today(365), LIVE_TOMORROW], now), /only as a picture/);
  // Their page would show nothing for text without its picture; that state has never occurred.
  assert.throws(() => factFromItems([today(1097, { imageUrl: '' }), LIVE_TOMORROW], now), /no picture/);
  // Item 372 (20.11.2024): "про відміну застосування ГПВ" — their page shows this note instead.
  assert.deepEqual(factFromItems([LIVE_TODAY, tomorrow(372)], now).fact, {});
  // Any other note replaces the schedule with prose we cannot read.
  const note = { ...LIVE_TODAY, description: 'Графік буде опубліковано пізніше' };
  assert.throws(() => factFromItems([note, LIVE_TOMORROW], now), /note instead of a schedule/);
});

test('a note about tomorrow does not hold back a late revision of today', () => {
  // 10.04.2026, 22:30: today was revised at 22:19, adding 23:00–24:00 for 2.1 and 3.2 (item 1075).
  // Had the Tomorrow slot carried a note instead of 11.04's text, that revision still has to go out.
  const now = new Date('2026-04-10T22:30:00+03:00');
  const noted = (description) => ({ ...LIVE_TOMORROW, description });
  const later = noted('Графік погодинних відключень на 11.04.2026 буде опубліковано додатково. \n' +
    'Інформація станом на 21:40 10.04.2026');

  const snapshot = snapshotFromItems(REGION, [today(1075), later], now);
  assert.deepEqual(validate(snapshot), []);
  assert.deepEqual(Object.keys(snapshot.fact.data), ['1775768400']);
  assert.equal(snapshot.fact.data[1775768400]['GPV2.1']['24'], 'no');
  assert.equal(snapshot.fact.data[1775768400]['GPV3.2']['24'], 'no');
  assert.equal(snapshot.fact.update, '22:19 10.04.2026');

  // Once 11.04 has come, the same note may be standing where today's schedule should be.
  assert.throws(() => factFromItems([today(1075), later], new Date('2026-04-11T00:20:00+03:00')),
    /note instead of a schedule/);
  // So may a note that names today beside tomorrow, or only its own stamp, or no d.m.yyyy date.
  for (const note of [
    'Графік на 11.04.2026 буде опубліковано додатково, на 10.04.2026 — уточнено.',
    'Графік буде опубліковано додатково. Інформація станом на 21:40 10.04.2026',
    'Графік на 11 квітня буде опубліковано додатково.'
  ]) assert.throws(() => factFromItems([today(1075), noted(note)], now), /note instead of a schedule/, note);
  assert.throws(() => factFromItems([today(1075), noted('Графік на 31.04.2026.')], now), /31\.04\.2026 is not a date/);
  // A picture carries no day we can read, so it still fails the run whichever slot it sits in.
  assert.throws(() => factFromItems([today(1075), tomorrow(365)], now), /only as a picture/);
});

test('the slots must still be the ones the page calls Today and Tomorrow', () => {
  const now = new Date('2026-10-01T12:00:00+03:00');
  const renamed = { ...LIVE_TODAY, name: 'Arhiv' };
  assert.throws(() => factFromItems([renamed, LIVE_TOMORROW], now), /expected "Today"/);
  assert.throws(() => factFromItems([LIVE_TOMORROW, LIVE_TODAY], now), /expected "Today"/);
  const retyped = { ...LIVE_TODAY, rawHtml: 42 };
  assert.throws(() => scheduleText(retyped, { id: 238, name: 'Today' }), /rawHtml is number/);
});

test('an item is found by id in a bare object, a bare list or a hydra collection', () => {
  assert.equal(itemFrom(LIVE_TODAY, 238), LIVE_TODAY);
  assert.equal(itemFrom([LIVE_TOMORROW, LIVE_TODAY], 238), LIVE_TODAY);
  assert.equal(itemFrom({ 'hydra:member': [LIVE_TODAY, LIVE_TOMORROW] }, 256), LIVE_TOMORROW);
  assert.throws(() => itemFrom({ 'hydra:member': [] }, 238), /missing/);
});

test('tomorrow is the next date in Kyiv, also on the night the clocks go back', () => {
  // 25.10.2026 has 25 hours. Adding 24 h to 00:30 that morning is still the 25th, so "tomorrow" has
  // to be a calendar step; the 26th must be kept and keyed by its own midnight, 25 hours later.
  const items = [
    today(1097, { rawHtml: redated(1097, '25.10.2026') }),
    tomorrow(1094, { rawHtml: redated(1094, '26.10.2026', '25.10.2026') })
  ];
  for (const now of ['2026-10-25T00:30:00+03:00', '2026-10-25T23:30:00+02:00']) {
    const snapshot = snapshotFromItems(REGION, items, new Date(now));
    assert.deepEqual(validate(snapshot), []);
    assert.deepEqual(Object.keys(snapshot.fact.data), ['1792875600', '1792965600'], now);
    assert.equal(snapshot.fact.today, 1792875600);
  }
});
