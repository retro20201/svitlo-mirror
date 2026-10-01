import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule } from './sources/mykolaiv.mjs';
import { buildSnapshot, hasSchedule, validate } from './lib/canonical.mjs';

// Миколаївобленерго's `/api/v2/schedule/active` answers `[]` out of season, so the in-season
// fixtures come from the Wayback Machine's captures of that same URL (15 of them, 29.12.2025 to
// 22.02.2026). Rows that matter are verbatim; whole days are re-expanded from the real per-queue
// patterns into the exact row shape the API serves. The queue list and the slot list are what the
// API served on 2026-10-01, the day the new queue assignments took effect.

/** `/api/outage-queue/by-type/3`, 2026-10-01, verbatim. Note the gaps at 18 and 23. */
const GPV_QUEUES = [
  [14, '1.1'], [15, '1.2'], [16, '2.1'], [17, '2.2'], [19, '3.1'], [20, '3.2'],
  [21, '4.1'], [22, '4.2'], [24, '5.1'], [25, '5.2'], [26, '6.1'], [27, '6.2']
].map(([id, name]) => ({
  id, name, type_id: 3, enabled: 0, created_at: null, updated_at: '2026-08-29T15:35:56.000000Z', deleted: 0
}));

/** `/api/schedule/time-series`, 2026-10-01: ids 1–48, "00:00:00"–"00:30:00" … "23:30:00"–"00:00:00". */
const hh = (index) => `${String(Math.floor(index / 2) % 24).padStart(2, '0')}:${index % 2 ? '30' : '00'}:00`;
const TIME_SERIES = Array.from({ length: 48 }, (_, index) => ({
  id: index + 1, start: hh(index), end: hh(index + 1), created_at: null, updated_at: null
}));

const ID_BY_NAME = Object.fromEntries(GPV_QUEUES.map((queue) => [queue.name, queue.id]));

/** `.` nothing listed, `X` OFF, `S` SURE_OFF, `?` PROBABLY_OFF — one character per half-hour. */
const TYPE = { X: 'OFF', S: 'SURE_OFF', '?': 'PROBABLY_OFF' };

/**
 * A schedule as `/api/v2/schedule/active` lists it, expanded from per-queue patterns. A queue may
 * carry two layers when the operator lists one half-hour twice (17.02.2026: 4.1's 15:00 is `OFF`
 * and again `SURE_OFF`). Rows come out in the operator's write order — every `OFF`, then
 * `PROBABLY_OFF`, then `SURE_OFF` — all stamped `written`; a day not taken from a capture is
 * stamped the day before it starts, as tomorrow's schedule is.
 */
function schedule(id, from, patterns, written = new Date(Date.parse(from) - 24 * 3600 * 1000).toISOString()) {
  let rowId = id * 1000;
  const series = [];
  for (const symbol of ['X', '?', 'S']) {
    for (const [name, layers] of Object.entries(patterns)) {
      for (const layer of [layers].flat()) {
        [...layer].forEach((cell, slot) => {
          if (cell !== symbol) return;
          series.push({
            id: rowId++, outage_schedule_id: id, time_series_id: slot + 1, outage_queue_id: ID_BY_NAME[name],
            created_at: written, updated_at: written, type: TYPE[symbol]
          });
        });
      }
    }
  }
  return { id, from, to: null, series };
}

const parse = (active, now, overrides = {}) =>
  parseSchedule({ timeSeries: TIME_SERIES, queues: GPV_QUEUES, active, now: new Date(now), ...overrides });

/** The queue list with `enabled` raised on `names`, as the operator serves it while they are off. */
const flagged = (names) => GPV_QUEUES.map((queue) => ({ ...queue, enabled: names.includes(queue.name) ? 1 : 0 }));

/** Every hour cell that differs between two parses, as `"<day> <code> <hour>"`. */
function moved(before, after) {
  const cells = [];
  for (const day of new Set([...Object.keys(before.fact), ...Object.keys(after.fact)])) {
    for (const code of Object.keys(before.fact[day] ?? after.fact[day])) {
      for (let hour = 1; hour <= 24; hour++) {
        if (before.fact[day]?.[code]?.[hour] !== after.fact[day]?.[code]?.[hour]) cells.push(`${day} ${code} ${hour}`);
      }
    }
  }
  return cells;
}

const row = (fields) => ({
  created_at: '2026-01-02T09:52:50.000000Z', updated_at: '2026-01-02T09:52:50.000000Z', ...fields
});

// Captured 02.01.2026 13:03 UTC: a light day on which only 3.2 and 5.1 were named. Verbatim.
const JAN02 = [{
  id: 96, from: '2026-01-01T22:00:00.000000Z', to: '2026-01-02T21:59:00.000000Z',
  series: [
    [99713, 21, 20, 'OFF'], [99714, 21, 24, 'OFF'], [99715, 22, 20, 'OFF'], [99716, 22, 24, 'OFF'],
    [99717, 23, 20, 'OFF'], [99718, 23, 24, 'OFF'], [99719, 24, 24, 'OFF'], [99720, 20, 20, 'PROBABLY_OFF'],
    [99721, 20, 24, 'PROBABLY_OFF'], [99722, 24, 20, 'PROBABLY_OFF'], [99723, 25, 24, 'PROBABLY_OFF']
  ].map(([id, slot, queue, type]) => row({ id, outage_schedule_id: 96, time_series_id: slot, outage_queue_id: queue, type }))
}];
const KYIV_MIDNIGHT_02_01_2026 = 1767304800;

// Captured 29.01.2026 19:36 UTC (21:36 in Kyiv): today and tomorrow, two queues of each.
const JAN29 = schedule(123, '2026-01-28T22:00:00.000000Z', {
  '1.1': '.???XXXXXXXX?....?XXXXXXXXXX?....?XXXXXX?????...',
  '4.1': 'XXXXXXXX?....??XXXXXXXXX?....?XXXX???????....?XX'
}, '2026-01-29T18:54:09.000000Z');
const JAN30 = schedule(124, '2026-01-29T22:00:00.000000Z', {
  '1.1': '?XXXXXXXXXX?....?XXXXXXXXXX?....?XXXXXXXXXX?....',
  '4.1': 'XXXXXXX?....?XXXXXXXXXX?....?XXXXXXXXXX?....???X'
}, '2026-01-29T18:49:59.000000Z');
const KYIV_MIDNIGHT_29_01_2026 = 1769637600;
const KYIV_MIDNIGHT_30_01_2026 = 1769724000;

// Captured 02.02.2026 20:30:47 UTC (22:30 in Kyiv), all twelve підчерги of today and tomorrow, with
// the queue list fetched two seconds earlier: 1.2, 2.2, 3.2, 4.1, 4.2, 5.1 and 6.1 flagged as off.
const FEB02 = schedule(127, '2026-02-01T22:00:00.000000Z', {
  '1.1': '?XXXXX???....?XXXXXXXX???....?XXXXXXXXXX?....???',
  '1.2': '?...????XXXXXX???....?XXXXXXXX???....?XXXXXXXXX?',
  '2.1': '.???XXXXXX???....???XXXXXXXX?....?XXXXXXXX???...',
  '2.2': '?...????XXXXXX???....???XXXXXXXX?....?XXXXXXXXX?',
  '3.1': '.???XXXXXX???....?XXXXXXXX???....?XXXXXXXXX??...',
  '3.2': 'XX??.....???XXXXXX???....?XXXXXXXXXX?....???XXX?',
  '4.1': 'XX??.....???XXXXXX???....?XXXXXXXX???....?XXXXX?',
  '4.2': 'XX??.....???XXXXXXXX?....???XXXXXXXX?....?XXXXX?',
  '5.1': '.???XXXXXX???....???XXXXXXXX?....???XXXXXXXX?...',
  '5.2': 'XXXXXX???....???XXXXXXXX?....?XXXXXXXX???....?XX',
  '6.1': '?...????XXXXXXXX?....????XXXXXXX?....???XXXXXXX?',
  '6.2': '?XXXXX???....???XXXXXXXX?....???XXXXXXXX?....???'
}, '2026-02-02T17:57:59.000000Z');
const FEB03 = schedule(128, '2026-02-02T22:00:00.000000Z', {
  '1.1': 'XXX?????....?XXXXXXXXXX?....?XXXXXX?????....?XXX',
  '1.2': '....?XXXXXXXXXX?....?XXXXXX?????....?XXXXXXXXXX?',
  '2.1': '?XXXXXX?????....?XXXXXX?????....?XXXXXXXXXX?....',
  '2.2': '....?XXXXXX?????....?XXXXXXXXXX?....?XXXXXX?????',
  '3.1': '?XXXXXX?????....?XXXXXXXXXX?....?XXXXXX?????....',
  '3.2': '????....?XXXXXXXXXX?....?XXXXXX?????....?XXXXXXX',
  '4.1': '????....?XXXXXX?????....?XXXXXXXXXX?....?XXXXXXX',
  '4.2': '????....?XXXXXX?????....?XXXXXXXXXX?....?XXXXXXX',
  '5.1': '?XXXXXX?????....?XXXXXXXXXX?....?XXXXXXXXXX?....',
  '5.2': 'XXX?????....?XXXXXX?????....?XXXXXXXXXX?....?XXX',
  '6.1': '....?XXXXXX?????....?XXXXXXXXXX?....?XXXXXX?????',
  '6.2': 'XXX?????....?XXXXXXXXXX?....?XXXXXXXXXX?....?XXX'
}, '2026-02-02T19:00:14.000000Z');
const KYIV_MIDNIGHT_02_02_2026 = 1769983200;
const KYIV_MIDNIGHT_03_02_2026 = 1770069600;

// Captured 17.02.2026 18:16:46 UTC: today's twelve підчерги, written in one go at 17:43:15 as 161
// `OFF` rows, then 60 `PROBABLY_OFF`, then 110 `SURE_OFF` — 109 of which are the only row for their
// half-hour. The queue list beside it flagged 1.1, 1.2, 2.1, 2.2, 3.1, 5.2, 6.1 and 6.2.
const FEB17 = schedule(142, '2026-02-16T22:00:00.000000Z', {
  '1.1': ['.?XXXXX?.........?.....XXXXX?.......?...........', '..................SSSSS..............SSSSSSSSSSS'],
  '1.2': ['.?XXXXX?.......?XXXXX?.......?.......XXXXX?.....', '..............................SSSSSSS...........'],
  '2.1': ['.?XXXXX?.......?XXXXX?.......?XXXXX.......?.....', '...................................SSSSSSS......'],
  '2.2': ['?..............?XXXXXXXXXXXX?.......?XXXXX......', '..........................................SSSSSS'],
  '3.1': ['.?XXXXX?.........?.....XXXXX?.......?...........', '..................SSSSS..............SSSSSSSSSSS'],
  '3.2': ['........?XXXXX?.......?......XXXXXX?.......?....', '.......................SSSSSS...............SSSS'],
  '4.1': ['........?XXXXX?.......?XXXXX..X....?.......?XXXX', '............................SSSSSSS.............'],
  '4.2': ['?.......?XXXXX?.......?............?.......?....', '.......................SSSSSSSSSSSS.........SSSS'],
  '5.1': '........?XXXXX?.......?XXXXXXXXXXXX?.......?XXXX',
  '5.2': ['?.........?.....XXXXX?.......?XXXXX.......?.....', '...........SSSSS...................SSSSSSS......'],
  '6.1': ['...............?XXXXXXXXXXXX?.......?XXXXX......', '..........................................SSSSSS'],
  '6.2': ['?.........?.....XXXXX?.......?XXXXXXXXXX..?.....', '...........SSSSS........................SS......']
}, '2026-02-17T17:43:15.000000Z');
const KYIV_MIDNIGHT_17_02_2026 = 1771279200;

test('a published day carries all twelve підчерги under the national keys', () => {
  const { queues, fact } = parse(JAN02, '2026-01-02T13:03:19Z');

  assert.deepEqual(Object.keys(queues), [
    'GPV1.1', 'GPV1.2', 'GPV2.1', 'GPV2.2', 'GPV3.1', 'GPV3.2',
    'GPV4.1', 'GPV4.2', 'GPV5.1', 'GPV5.2', 'GPV6.1', 'GPV6.2'
  ]);
  assert.equal(queues['GPV3.2'], 'Черга 3.2');
  assert.deepEqual(Object.keys(fact), [String(KYIV_MIDNIGHT_02_01_2026)]);
  assert.equal(Object.keys(fact[KYIV_MIDNIGHT_02_01_2026]).length, 12);

  // 3.2: maybe 09:30, off 10:00–11:30, maybe 11:30. 5.1: maybe 09:30, off 10:00–12:00, maybe 12:00.
  const q32 = fact[KYIV_MIDNIGHT_02_01_2026]['GPV3.2'];
  const q51 = fact[KYIV_MIDNIGHT_02_01_2026]['GPV5.1'];
  assert.deepEqual([q32['9'], q32['10'], q32['11'], q32['12'], q32['13']], ['yes', 'msecond', 'no', 'no', 'yes']);
  assert.deepEqual([q51['10'], q51['11'], q51['12'], q51['13'], q51['14']], ['msecond', 'no', 'no', 'mfirst', 'yes']);

  // The other ten were not mentioned on a day the operator did publish: that is "not off".
  assert.ok(Object.values(fact[KYIV_MIDNIGHT_02_01_2026]['GPV1.1']).every((state) => state === 'yes'));
});

test('"Заплановане відключення" is an outage, not a maybe', () => {
  // OFF is most of every January block; reading it as "possible" hid published blackouts.
  const { fact } = parse([schedule(1, '2026-01-28T22:00:00.000000Z', {
    '2.1': 'XXSS??X..X..??' + '.'.repeat(34)
  })], '2026-01-29T10:00:00Z');
  const hours = fact[KYIV_MIDNIGHT_29_01_2026]['GPV2.1'];

  assert.equal(hours['1'], 'no');       // OFF, OFF
  assert.equal(hours['2'], 'no');       // SURE_OFF, SURE_OFF
  assert.equal(hours['3'], 'maybe');    // PROBABLY_OFF, PROBABLY_OFF
  assert.equal(hours['4'], 'first');    // OFF, nothing
  assert.equal(hours['5'], 'second');   // nothing, OFF
  assert.equal(hours['6'], 'yes');
  assert.equal(hours['7'], 'maybe');
  assert.equal(hours['8'], 'yes');
});

test('overlapping entries resolve the way the operator\'s page resolves them', () => {
  // Verbatim from 15.01.2026: 4.1's 17:30 and 18:00 slots listed as OFF, then again as SURE_OFF.
  const jan15 = {
    id: 107, from: '2026-01-14T22:00:00.000000Z', to: '2026-01-15T21:59:00.000000Z',
    series: [
      { id: 119269, outage_schedule_id: 107, time_series_id: 36, outage_queue_id: 21, created_at: '2026-01-15T19:39:43.000000Z', updated_at: '2026-01-15T19:39:43.000000Z', type: 'OFF' },
      { id: 119276, outage_schedule_id: 107, time_series_id: 37, outage_queue_id: 21, created_at: '2026-01-15T19:39:43.000000Z', updated_at: '2026-01-15T19:39:43.000000Z', type: 'OFF' },
      { id: 119417, outage_schedule_id: 107, time_series_id: 36, outage_queue_id: 21, created_at: '2026-01-15T19:39:43.000000Z', updated_at: '2026-01-15T19:39:43.000000Z', type: 'SURE_OFF' },
      { id: 119418, outage_schedule_id: 107, time_series_id: 37, outage_queue_id: 21, created_at: '2026-01-15T19:39:43.000000Z', updated_at: '2026-01-15T19:39:43.000000Z', type: 'SURE_OFF' },
      // Not seen in the archive, but the page's rule decides them: SURE_OFF is never overwritten,
      // anything else is overwritten by whatever comes later.
      row({ id: 1, time_series_id: 37, outage_queue_id: 21, type: 'PROBABLY_OFF' }),
      row({ id: 2, time_series_id: 1, outage_queue_id: 14, type: 'OFF' }),
      row({ id: 3, time_series_id: 1, outage_queue_id: 14, type: 'PROBABLY_OFF' }),
      row({ id: 4, time_series_id: 2, outage_queue_id: 14, type: 'OFF' })
    ]
  };
  const { fact } = parse([jan15], '2026-01-15T19:47:06Z');
  const day = fact[1768428000];

  assert.equal(day['GPV4.1']['18'], 'second');   // 17:00 light, 17:30 off
  assert.equal(day['GPV4.1']['19'], 'first');    // 18:00 still SURE_OFF, 18:30 light
  assert.equal(day['GPV1.1']['1'], 'no');        // 00:00 now PROBABLY_OFF, 00:30 OFF — no promise of light
});

test('schedules that share a date are read as one, in payload order', () => {
  // The page concatenates the series of every schedule filed under the same date.
  const morning = schedule(1, '2026-01-28T22:00:00.000000Z', { '1.1': 'XX' + '.'.repeat(46) });
  const evening = schedule(2, '2026-01-28T22:00:00.000000Z', { '1.1': '.'.repeat(46) + 'SS', '6.2': '??' + '.'.repeat(46) });
  const { fact } = parse([morning, evening], '2026-01-29T10:00:00Z');
  const day = fact[KYIV_MIDNIGHT_29_01_2026];

  assert.equal(day['GPV1.1']['1'], 'no');
  assert.equal(day['GPV1.1']['24'], 'no');
  assert.equal(day['GPV6.2']['1'], 'maybe');
});

test('queue codes come from the names the API gives, not from the ids', () => {
  // The assignments changed on 2026-10-01; ids are the operator's to renumber.
  const renumbered = GPV_QUEUES.map((queue) => ({ ...queue, id: queue.id + 100 }));
  const active = [schedule(1, '2026-01-28T22:00:00.000000Z', { '5.2': 'XX' + '.'.repeat(46) })];
  active[0].series.forEach((entry) => { entry.outage_queue_id += 100; });

  const { fact } = parse(active, '2026-01-29T10:00:00Z', { queues: renumbered });
  assert.equal(fact[KYIV_MIDNIGHT_29_01_2026]['GPV5.2']['1'], 'no');
  assert.equal(fact[KYIV_MIDNIGHT_29_01_2026]['GPV5.1']['1'], 'yes');
});

test('only today and tomorrow are published', () => {
  const both = parse([JAN29, JAN30], '2026-01-29T19:36:41Z');
  assert.deepEqual(Object.keys(both.fact).map(Number), [KYIV_MIDNIGHT_29_01_2026, KYIV_MIDNIGHT_30_01_2026]);
  // 4.1 on the 30th ends `???X`: 22:00 maybe, 23:00 maybe then off — no promise of light.
  assert.equal(both.fact[KYIV_MIDNIGHT_30_01_2026]['GPV4.1']['23'], 'maybe');
  assert.equal(both.fact[KYIV_MIDNIGHT_30_01_2026]['GPV4.1']['24'], 'no');
  assert.equal(both.fact[KYIV_MIDNIGHT_29_01_2026]['GPV1.1']['1'], 'msecond');   // `.?` — light, then maybe

  // 00:10 in Kyiv on the 30th, with a cached response still carrying the 29th: yesterday is gone.
  const after = parse([JAN29, JAN30], '2026-01-29T22:10:00Z');
  assert.deepEqual(Object.keys(after.fact).map(Number), [KYIV_MIDNIGHT_30_01_2026]);

  // A day after tomorrow is not something this operator has published; it is not passed on.
  const early = parse([JAN30], '2026-01-28T10:00:00Z');
  assert.deepEqual(early.fact, {});
});

test('the 25-hour 25.10.2026 and the day after it land on their own Kyiv midnights', () => {
  const oct25 = schedule(1, '2026-10-24T21:00:00.000000Z', { '3.1': '......XX' + '.'.repeat(40) });
  const oct26 = schedule(2, '2026-10-25T22:00:00.000000Z', { '3.1': '......SS' + '.'.repeat(40) });
  const { fact } = parse([oct25, oct26], '2026-10-25T06:00:00Z');

  assert.deepEqual(Object.keys(fact).map(Number), [1792875600, 1792965600]);
  // Slots are wall-clock: 03:00–04:00 is hour row 4 on both days, the repeated hour included.
  assert.equal(fact[1792875600]['GPV3.1']['4'], 'no');
  assert.equal(fact[1792965600]['GPV3.1']['4'], 'no');

  // The 26th's midnight written with the summer offset is 23:00 on the 25th — refused, not misfiled.
  const misdated = schedule(3, '2026-10-25T21:00:00.000000Z', { '3.1': 'XX' + '.'.repeat(46) });
  assert.throws(() => parse([misdated], '2026-10-25T06:00:00Z'), /not at a Kyiv midnight/);

  // 03:40 comes twice that night, first in summer time and then in winter time; both are the
  // 03:30 half-hour, so a flagged 3.2 with nothing planned is off for the second half of row 4.
  for (const now of ['2026-10-25T00:40:00Z', '2026-10-25T01:40:00Z']) {
    const flaggedNow = parse([oct25], now, { queues: flagged(['3.2']) });
    assert.equal(flaggedNow.fact[1792875600]['GPV3.2']['4'], 'second', now);
  }
});

test('out of season the queues stand and no day is invented', () => {
  // `active` as served on 2026-10-01. The page shows an all-green today here; that is not data.
  const { queues, fact } = parse([], '2026-10-01T13:41:41Z');
  const snapshot = buildSnapshot({ regionId: 'mykolaiv', title: 'Миколаївська область', queues, fact, source: 'mykolaiv' });

  assert.equal(Object.keys(queues).length, 12);
  assert.deepEqual(fact, {});
  assert.deepEqual(validate(snapshot), []);
  assert.equal(hasSchedule(snapshot), false);
});

test('a published day passes the publishing gate', () => {
  const { queues, fact } = parse([JAN29, JAN30], '2026-01-29T19:36:41Z');
  const snapshot = buildSnapshot({ regionId: 'mykolaiv', title: 'Миколаївська область', queues, fact, source: 'mykolaiv' });

  assert.deepEqual(validate(snapshot), []);
  assert.equal(hasSchedule(snapshot), true);
});

test('anything the operator\'s page could not draw fails the run instead of being guessed', () => {
  const day = (series) => [{ id: 9, from: '2026-01-28T22:00:00.000000Z', to: null, series }];
  const now = '2026-01-29T10:00:00Z';
  const cases = [
    // a ГАВ queue (type 1, id 3) inside the hourly grid: the lists and the grid disagree
    [day([row({ id: 1, time_series_id: 1, outage_queue_id: 3, type: 'OFF' })]), /not a ГПВ підчерга/],
    [day([row({ id: 1, time_series_id: 49, outage_queue_id: 14, type: 'OFF' })]), /unknown slot/],
    [day([row({ id: 1, time_series_id: 1, outage_queue_id: 14, type: 'MAYBE_OFF' })]), /unknown type/],
    // without a write time a day cannot be told settled from half-written
    [day([row({ id: 1, time_series_id: 1, outage_queue_id: 14, type: 'OFF', created_at: null })]), /no usable created_at/],
    // `[]` and `null` are an empty day; a missing or reshaped `series` is a changed API
    [day(undefined), /expected an array/],
    [day({ 1: [] }), /expected an array/],
    [{ data: [] }, /expected an array/],
    [[{ id: 9, from: '29.01.2026', series: [] }], /no usable "from"/]
  ];
  for (const [active, message] of cases) assert.throws(() => parse(active, now), message);

  assert.throws(() => parse([], now, { queues: GPV_QUEUES.slice(1) }), /11 ГПВ queues/);
  assert.throws(() => parse([], now, { queues: [...GPV_QUEUES, { ...GPV_QUEUES[0], id: 99, name: '7.1' }] }), /unexpected ГПВ queue/);
  assert.throws(() => parse([], now, { queues: GPV_QUEUES.map((queue) => ({ ...queue, type_id: 2 })) }), /unexpected ГПВ queue/);
  assert.throws(() => parse([], now, { queues: [...GPV_QUEUES.slice(1), { ...GPV_QUEUES[1], id: 99 }] }), /listed twice/);
  assert.throws(() => parse([], now, { queues: GPV_QUEUES.map((queue) => ({ ...queue, enabled: true })) }), /expected 0 or 1/);
  assert.throws(() => parse([], now, { timeSeries: TIME_SERIES.slice(1) }), /47 slots/);
  assert.throws(
    () => parse([], now, { timeSeries: TIME_SERIES.map((slot) => (slot.id === 3 ? { ...slot, end: '02:00:00' } : slot)) }),
    /expected 01:00:00–01:30:00/
  );
});

test('a queue the operator flags as off right now is off for the current half-hour, whatever the plan says', () => {
  // 02.02.2026 22:30 in Kyiv: 5.1 planned off until 22:00, maybe until 22:30, then light — and the
  // flag still up. The operator's page blinks that 22:30 cell «Поточне відключення».
  const now = '2026-02-02T20:30:47Z';
  const plan = parse([FEB02, FEB03], now);
  const live = parse([FEB02, FEB03], now, { queues: flagged(['1.2', '2.2', '3.2', '4.1', '4.2', '5.1', '6.1']) });

  assert.equal(plan.fact[KYIV_MIDNIGHT_02_02_2026]['GPV5.1']['23'], 'mfirst');
  assert.equal(live.fact[KYIV_MIDNIGHT_02_02_2026]['GPV5.1']['23'], 'no');
  // The only cell that moves: the six other flagged queues were already off at 22:30, the next
  // half-hour keeps its plan, and tomorrow is never touched.
  assert.deepEqual(moved(plan, live), [`${KYIV_MIDNIGHT_02_02_2026} GPV5.1 23`]);
  assert.equal(live.fact[KYIV_MIDNIGHT_02_02_2026]['GPV5.1']['24'], 'yes');
  assert.equal(live.fact[KYIV_MIDNIGHT_03_02_2026]['GPV5.1']['23'], 'yes');

  // 27.01.2026 15:44: 3.2 flagged while planned only "maybe" from 15:30. Verbatim pattern.
  const jan27 = schedule(121, '2026-01-26T22:00:00.000000Z', {
    '3.2': '?XXXXXXXXX?....?XXXXXXXXXX?....?XXXXXXXXXX?....?'
  }, '2026-01-26T17:58:07.000000Z');
  assert.equal(parse([jan27], '2026-01-27T13:44:14Z').fact[1769464800]['GPV3.2']['16'], 'msecond');
  assert.equal(parse([jan27], '2026-01-27T13:44:14Z', { queues: flagged(['3.2']) }).fact[1769464800]['GPV3.2']['16'], 'second');

  // 17.02.2026 20:16: eight queues flagged, every one of them already off in the plan — as in every
  // archived pair, the flag only ever adds to what the plan says.
  const feb17Flags = flagged(['1.1', '1.2', '2.1', '2.2', '3.1', '5.2', '6.1', '6.2']);
  assert.deepEqual(moved(parse([FEB17], '2026-02-17T18:16:46Z'), parse([FEB17], '2026-02-17T18:16:46Z', { queues: feb17Flags })), []);

  // A flag on a day nobody published invents no day: one off cell would make the rest read as light.
  assert.deepEqual(parse([], now, { queues: flagged(['5.1']) }).fact, {});
  assert.deepEqual(Object.keys(parse([FEB03], now, { queues: flagged(['5.1']) }).fact).map(Number), [KYIV_MIDNIGHT_03_02_2026]);
});

test('a schedule with no rows leaves its own date out, and nothing else', () => {
  const now = '2026-01-29T19:36:41Z';
  const emptied = (item) => ({ ...item, series: [] });
  const days = (active) => Object.keys(parse(active, now).fact).map(Number);

  // Today emptied while tomorrow is real: tomorrow still goes out, and today is not turned into light.
  assert.deepEqual(days([emptied(JAN29), JAN30]), [KYIV_MIDNIGHT_30_01_2026]);
  // `null` reads the way the page reads it.
  assert.deepEqual(days([JAN29, { ...JAN30, series: null }]), [KYIV_MIDNIGHT_29_01_2026]);
  // An empty shell for yesterday or for the day after tomorrow is not this run's business.
  const yesterday = { id: 122, from: '2026-01-27T22:00:00.000000Z', to: null, series: [] };
  const afterTomorrow = { id: 125, from: '2026-01-30T22:00:00.000000Z', to: null, series: [] };
  assert.deepEqual(days([yesterday, JAN29, JAN30, afterTomorrow]), [KYIV_MIDNIGHT_29_01_2026, KYIV_MIDNIGHT_30_01_2026]);
  // Two schedules on one date, one of them empty: the date is unknown, not half-published.
  assert.deepEqual(days([JAN29, emptied({ ...JAN29, id: 200 }), JAN30]), [KYIV_MIDNIGHT_30_01_2026]);

  // Both emptied: a quiet snapshot, not a broken one, and it claims no schedule.
  const { queues, fact } = parse([emptied(JAN29), emptied(JAN30)], now);
  const snapshot = buildSnapshot({ regionId: 'mykolaiv', title: 'Миколаївська область', queues, fact, source: 'mykolaiv' });
  assert.deepEqual(validate(snapshot), []);
  assert.equal(hasSchedule(snapshot), false);
});

test('a day still being rewritten fails the run instead of going out half-written', () => {
  // Cut where the operator's write order would cut it: after every OFF and PROBABLY_OFF row, before
  // the first SURE_OFF — 1.1's 09:00–11:00 and 18:30–24:00 would read as light.
  const cutAt = FEB17.series.findIndex((entry) => entry.type === 'SURE_OFF');
  assert.equal(cutAt, 221);
  const cut = { ...FEB17, series: FEB17.series.slice(0, cutAt) };
  const after = (seconds) => new Date(Date.parse(FEB17.series[0].created_at) + seconds * 1000).toISOString();

  const settled = parse([FEB17], '2026-02-17T18:16:46Z').fact[KYIV_MIDNIGHT_17_02_2026]['GPV1.1'];
  assert.deepEqual(['10', '11', '20', '24'].map((hour) => settled[hour]), ['no', 'no', 'no', 'no']);

  assert.throws(() => parse([cut], after(20)), /may still be writing it/);
  // Only the age of the newest row is judged, so a whole day that fresh waits a run too.
  assert.throws(() => parse([FEB17], after(20)), /may still be writing it/);
  // A clock behind the operator's makes the day look fresh, never settled.
  assert.throws(() => parse([FEB17], after(-60)), /may still be writing it/);
  assert.equal(parse([FEB17], after(120)).fact[KYIV_MIDNIGHT_17_02_2026]['GPV1.1']['20'], 'no');
  // A day outside today and tomorrow is never published, so its age does not matter.
  assert.deepEqual(parse([FEB17], '2026-02-15T12:00:00Z').fact, {});
});
