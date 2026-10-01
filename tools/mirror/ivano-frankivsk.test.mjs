import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetGrid } from '../lib/xlsx.mjs';
import { hourStateFromHalves, kyivDayStart, NATIONAL_QUEUES, validate } from './lib/canonical.mjs';
import { factFromQueues, checkQueueList, fetchRegion } from './sources/ivano-frankivsk.mjs';

/**
 * be-svitlo has not been seen publishing a schedule: on 2026-10-01, the day this adapter was
 * written, every черга answered `[]`. The fixtures therefore come in three kinds, and each says
 * which it is:
 *  - REAL — bytes from the operator: the queue list and the twelve empty answers captured on
 *    2026-10-01 at 13:43 UTC, and the archived sheet for 01.07.2026 below;
 *  - the shape the operator's own front end reads (quoted in the adapter), filled in the way public
 *    clients of the live API recorded it in season: each interval carries `shutdownHours` and
 *    `status: 1` next to `from`/`to`, and `scheduleApprovedSince` reads like "24.11.2025 19:52";
 *  - edge cases written in that shape.
 */

// REAL: POST /gpv-queue-list, verbatim, 2026-10-01.
const REAL_QUEUE_LIST = [
  { id: 1, code: '1.1', label: 'черга 1.1' }, { id: 2, code: '1.2', label: 'черга 1.2' },
  { id: 3, code: '2.1', label: 'черга 2.1' }, { id: 4, code: '2.2', label: 'черга 2.2' },
  { id: 5, code: '3.1', label: 'черга 3.1' }, { id: 6, code: '3.2', label: 'черга 3.2' },
  { id: 7, code: '4.1', label: 'черга 4.1' }, { id: 8, code: '4.2', label: 'черга 4.2' },
  { id: 9, code: '5.1', label: 'черга 5.1' }, { id: 10, code: '5.2', label: 'черга 5.2' },
  { id: 11, code: '6.1', label: 'черга 6.1' }, { id: 12, code: '6.2', label: 'черга 6.2' }
];

/** 12:00 on 20.11.2026 in Kyiv, and the midnights `fact` keys the days around it by. */
const NOW = new Date('2026-11-20T10:00:00Z');
const NOV_20 = 1795125600;
const NOV_21 = 1795212000;

const outage = (from, to, status = 1) => ({ shutdownHours: `${from}-${to}`, from, to, status });
const day = (eventDate, queues, scheduleApprovedSince = '19.11.2026 19:52') =>
  ({ eventDate, queues, createdAt: scheduleApprovedSince, scheduleApprovedSince });

const LIGHT = Array(24).fill('yes');
/** A day of light with the given hour rows (1–24) overwritten. */
const lightExcept = (hours) => LIGHT.map((state, index) => hours[index + 1] ?? state);

test('the real queue list names exactly the national twelve', () => {
  assert.doesNotThrow(() => checkQueueList(REAL_QUEUE_LIST));
});

test('a queue list that gains, loses or renames a черга stops the run', () => {
  // `[]` is also the answer for a черга that does not exist, so querying codes the operator no
  // longer lists would look exactly like a quiet day. The region must read as degraded instead.
  const gained = [...REAL_QUEUE_LIST, { id: 13, code: '7.1', label: 'черга 7.1' }];
  const lost = REAL_QUEUE_LIST.slice(1);
  const renamed = REAL_QUEUE_LIST.map((item) => ({ ...item, code: item.code.replace('.', '/') }));
  const doubled = [...REAL_QUEUE_LIST.slice(1), REAL_QUEUE_LIST[1]];
  // Their page queries with the code exactly as listed, so "1.1 " is not the черга asked about.
  const padded = REAL_QUEUE_LIST.map((item) => ({ ...item, code: `${item.code} ` }));
  for (const list of [gained, lost, renamed, doubled, padded]) {
    assert.throws(() => checkQueueList(list), /gpv-queue-list changed/);
  }
  assert.throws(() => checkQueueList({ message: 'error' }), /not an array/);
  assert.throws(() => checkQueueList([{ id: 1, code: 1.1 }]), /no string code/);
});

test('twelve real empty answers are no information, not a day of light', () => {
  // REAL: every GET /schedule-by-queue on 2026-10-01 returned exactly `[]`. Their page shows that
  // as "Інформація відсутня"; publishing it as "yes" would tell people there are no outages.
  const responses = Object.fromEntries(NATIONAL_QUEUES.map((code) => [code, JSON.parse('[]')]));
  assert.deepEqual(factFromQueues(responses, NOW), { fact: {}, update: null });
});

test('an outage window becomes hours keyed by Kyiv midnight', () => {
  const { fact, update } = factFromQueues({
    '4.2': [day('20.11.2026', { '4.2': [outage('16:30', '20:00')] })]
  }, NOW);

  assert.deepEqual(Object.keys(fact), [String(NOV_20)]);
  // 16:00-17:00 loses only its second half; 17:00-20:00 is dark; light is back for 20:00-21:00.
  assert.deepEqual(Object.values(fact[NOV_20]['GPV4.2']), lightExcept({ 17: 'second', 18: 'no', 19: 'no', 20: 'no' }));
  assert.equal(update, '19.11.2026 19:52');
});

test('several windows in any order are all applied', () => {
  // The order their API lists windows in is not chronological — clients recorded
  // 14:00, 01:30, 22:00, 07:30 for one day — and the page lists them as given.
  const { fact } = factFromQueues({
    '6.2': [day('20.11.2026', { '6.2': [outage('14:00', '15:00'), outage('01:30', '02:00'), outage('07:30', '09:00')] })]
  }, NOW);
  assert.deepEqual(
    Object.values(fact[NOV_20]['GPV6.2']),
    lightExcept({ 2: 'second', 8: 'second', 9: 'no', 15: 'no' })
  );
});

test('an empty array for the черга is a day published without outages', () => {
  // Their page renders `queues[code] = []` as a green "Не застосовується" chip: the schedule does
  // not apply to this черга that day. That is published data, the same all-"yes" day ДТЕК sends.
  const { fact } = factFromQueues({ '1.1': [day('20.11.2026', { '1.1': [] })] }, NOW);
  assert.deepEqual(Object.values(fact[NOV_20]['GPV1.1']), LIGHT);
});

test('a date with no queues, or without an element, says nothing about it', () => {
  // NO_DATA on their page: "Інформація відсутня". Light must not be inferred from silence.
  const { fact } = factFromQueues({
    '1.1': [day('20.11.2026', {})],
    '1.2': [day('20.11.2026', { '1.2': [outage('10:00', '11:00')] })],
    '2.1': []
  }, NOW);
  assert.deepEqual(Object.keys(fact[NOV_20]), ['GPV1.2']);
});

test('an answer keyed by anything but the черга asked for stops the run', () => {
  // Their page reads `queues[code]` with the code from the queue list. Keys that have moved would
  // read as NO_DATA in all twelve answers at once — the off-season, in the middle of the season.
  const window = [outage('16:00', '20:00')];
  for (const queues of [{ 'GPV1.1': window }, { '1.1 ': window }, { '1/1': window }, { '1.2': [] }]) {
    assert.throws(
      () => factFromQueues({ '1.1': [day('20.11.2026', queues)] }, NOW),
      /the answer for 1\.1 lists only/,
      JSON.stringify(queues)
    );
  }
  // Other черги next to the one asked for are fine; it is the one asked for that must be there.
  const { fact } = factFromQueues({ '1.1': [day('20.11.2026', { '1.1': window, '1.2': [] })] }, NOW);
  assert.deepEqual(Object.keys(fact[NOV_20]), ['GPV1.1']);
});

test('only today and tomorrow in Kyiv are kept', () => {
  // Their page shows exactly these two. Yesterday is a stale record and must not keep a region
  // "live"; the day after tomorrow is something their own page never displays.
  const { fact } = factFromQueues({
    '3.1': [
      day('19.11.2026', { '3.1': [outage('08:00', '12:00')] }),
      day('20.11.2026', { '3.1': [outage('10:00', '12:00')] }),
      day('21.11.2026', { '3.1': [] }),
      day('22.11.2026', { '3.1': [outage('08:00', '12:00')] })
    ]
  }, NOW);
  assert.deepEqual(Object.keys(fact), [String(NOV_20), String(NOV_21)]);
  assert.equal(fact[NOV_20]['GPV3.1']['11'], 'no');
  assert.deepEqual(Object.values(fact[NOV_21]['GPV3.1']), LIGHT);
});

/**
 * REAL: the bytes of shutdowns_schedule_archive_20260701.xlsx, downloaded from oe.if.ua on
 * 2026-08-28 (sha256 dcd2c315c08461a1a6d35c80f13cd8c63e4e4c661367ba6ca9b43ffc3a9b6fcc, 7175 bytes),
 * which the previous, archive-reading version of this adapter was tested against.
 *
 * It is here as the semantic anchor for the new source. The sheet is the operator's own record of
 * a real day: row 2 labels the 48 half-hours "00:00" … "23:30", rows 3–14 are черги 1.1–6.2, and
 * its legend reads "X = Немає електроенергії". Two черги were off that evening, both starting or
 * ending on the half hour. Re-expressed as the `from`/`to` windows be-svitlo lists under
 * "Відключення", the same day has to fold back to exactly the same grid — which is what proves the
 * interval arithmetic rather than arguing for it.
 */
const REAL_WORKBOOK_BASE64 =
  'UEsDBBQAAAAIAAAAIez2i56hIAEAAIQDAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2Tu27DMAxFf8XQWlhKOhRFYTtDH2ObIf0A' +
  'VaJjIXpBVFLn70vbTYcscdBMBEXec68EqFr1zhYHSGiCr9mSL1gBXgVt/LZmn5u38pGtmmpzjIAFrXqsWZdzfBICVQdOIg8RPE3a' +
  'kJzM1KatiFLt5BbE/WLxIFTwGXwu88BgTfUCrdzbXDxP5wO6ZjJGa5TMlEIcvD6Dlr9AnsCOO9iZiHe0wIrXnihTepoiEzMczoVD' +
  'T7oPeodkNBRrmfK7dKQSOqh1ChEF6fmouyZ3aFujgBh7RxIOg6UGXUZCQsoGpktc8lYhwfXmp0cb1DMdeyswHy3gv6+KMYHU2AFk' +
  'Z/kEveD8HdLuK4Tdrb2Hyp00fob/uIxiLMsbB/njn3KI8Vs1P1BLAwQUAAAACAAAACHsxl74hdsAAAA5AgAACwAAAF9yZWxzLy5y' +
  'ZWxzrZLdSgQxDIVfpeR+p+MvItvdGxH2TmR8gNhmZspMm5JWHd/e6oW4sosKXobknPMlZL1dwqyeSbLnaOCkaUFRtOx8HAw8dLer' +
  'K9hu1vc0Y6kTefQpqyqJ2cBYSrrWOtuRAuaGE8Xa6VkCllrKoBPaCQfSp217qeWrB+x7qg5loGJgmfULy/TIPDXVDFT3mug3Udz3' +
  '3tIN26dAsRxI/DYBaucMyM6dgT7C4tjeCVelZaG/0RxfXAcq6LDgh+sq1QCS4il/Ap3/DIQp/fd1aCkUHblDRBfvRHrvBzZvUEsD' +
  'BBQAAAAIAAAAIeylQmAyeQwAADWTAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1snd1LUyPXGYfxr6Ji42SRkbolLjMFuP4e' +
  'IQQIJJCEgJ0GGlBZqKlWM2N75UqlKhtXsojjrLLOdirOZGFnnK8gvlGOLg1k1HLzvK6yR5f+9dHlrWcOKhda//yrm37ubRANe+Fg' +
  'Y8l7UVjKBYPz8KI3uNpYarcqv1tb+nxz/V0YfTm8DoI45w4fDDeWruP49lU+Pzy/Dm66wxfhbTBw91yG0U03dlejq/zwNgq6FxN0' +
  '08/7hcJK/qbbGyxNz/Aqes45wsvL3nlQDs/vboJBPD1JFPS7sXuww+ve7XBytlfD2+55sLHkFhwG0dtgaXN9smwjym2u33avgmYQ' +
  't2/dtcte3Aob7oaNJfc085vr+dlxm+sXPbfC+DXIRcHlxpK8V194K+5E+Yc7Zic97gXvhk8u5y6Cy+5dP96Oehevw37onpe3lIt6' +
  'V9durVpwGU/WGl6H7yruid31u8OHG8ak1hsEwwkZ33IUvnPnqLrXzb0hj7fe9YPo4VrnuhcHzekznp3oLIjC6eFx900z6AfncXAx' +
  'ufddb3ARvmtEYexum7zDM1K/i/tu6ebXN2/C/tR+E4Y3zfNuP2iOn1ut+3V4N3mGE/Nw5/jlW3Tfwfit608XdgPzJgy/HB+0c/H/' +
  'h7nVCu76+L0ZBLlh3I3dTZdR+E3gpiMOb8ev2uug7070RdG9wc3bfi+ePMKvZxf9J2/eeIGnl5P3pjIZI/emv+kOA/eidnoX8fXG' +
  '0tpS8oa517oajN8md+q1yQnP3Ssx+a972ZKDb3qDydI33a8mf74JhnFl9nDO74ZxeDM7sZecIsHLM+zPsG/BxRkuWnBphksWvDzD' +
  'yxa8MsMrFrw6w6sWvDbDaxb8coZfWrBXSKakYOIPQ2aaMi8ZM880Z14yaJ5p0rxk1DzTrHnJsHmmafOScfNM8+YlA+eZJs5LRs4z' +
  'zZyXDJ1nmjo/mTrfNHV+MnW+rW0PcTNNnZ9MnW+aOj+ZOt80dX4ydb5p6vxk6nzT1PnJ1PmmqfOTqfNNU+cnU+ebpq6YTF3RNHXF' +
  'ZOqKpqkrJlNXtP2d+vCXqmnqisnUFU1TV0ymrmiaumIydUXT1BWTqSuapq6YTF3RNHXFZOqKpqkrJVNXMk1dKZm6kmnqSsnUlUxT' +
  'V0qmrmTbyz1s5kxTV0qmrmSaulIydSXT1JWSqSuZpq6UTF3JNHWlZOpK2VOXn/4MMPkJotyNu5vrUfhuduDDTwtLufEf4/RNfypz' +
  'q44vafwD2mSr7u7tDSY/XsWR+xmy584Yb47+cv/t6P39H+5/GP2UG/3T/fGv0U+jn+//dP/H0YfRx/vvcqOPo/e5gvsRfPWFX/BX' +
  '1vOxe0BjnD93/7oH8iuPZnX6aPzHR+NPHk1p0aP5x+iDezw/jt7//zIT+8Wv20LhVaGQwl5nsmIaK2cwL321rUyWulolg/npq21n' +
  'stTVqhmsmL7aTiZLXW03g5XSV9vLZKmr1TLYcvpq+5ksdbWDDLaSvlo9k6Wu1shgq+mrHWay1NWOMtha+mrNTJa6WiuDvUxfrZ3J' +
  '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';

const REAL_WORKBOOK = Buffer.from(REAL_WORKBOOK_BASE64, 'base64');
const JUL_1 = 1782853200;

/** The archived sheet: its own half-hour labels, and each черга's 48 cells as "marked X". */
function archivedSheet() {
  const grid = sheetGrid(REAL_WORKBOOK);
  const labels = grid[2].slice(2, 50);
  const rows = {};
  for (const cells of grid) {
    const queue = /^\d\.\d$/.exec(cells?.[1] ?? '')?.[0];
    if (queue) rows[queue] = labels.map((_, slot) => /^[XХ]$/.test(cells[2 + slot] ?? ''));
  }
  return { labels, rows };
}

/** Each run of marked cells → one window, timed by the sheet's own labels. */
function windowsFromMarks(marks, labels) {
  const windows = [];
  for (let slot = 0; slot < marks.length; slot++) {
    if (!marks[slot] || marks[slot - 1]) continue;
    let end = slot;
    while (end < marks.length && marks[end]) end++;
    windows.push(outage(labels[slot], end === marks.length ? '00:00' : labels[end]));
  }
  return windows;
}

test('the archived 01.07.2026 sheet, as be-svitlo windows, folds back to the same grid', () => {
  const { labels, rows } = archivedSheet();
  assert.equal(labels[0], '00:00');
  assert.equal(labels[47], '23:30');
  assert.deepEqual(Object.keys(rows), NATIONAL_QUEUES);

  const responses = {};
  const expected = {};
  for (const [queue, marks] of Object.entries(rows)) {
    responses[queue] = [day('01.07.2026', { [queue]: windowsFromMarks(marks, labels) }, '30.06.2026 18:40')];
    const halves = marks.map((marked) => (marked ? 'off' : 'on'));
    expected[`GPV${queue}`] = Object.fromEntries(
      LIGHT.map((_, index) => [String(index + 1), hourStateFromHalves(halves[index * 2], halves[index * 2 + 1])])
    );
  }

  // What the sheet holds, spelled out: the two evening outages and ten черги with none.
  assert.deepEqual(responses['1.2'][0].queues['1.2'], [outage('20:30', '22:00')]);
  assert.deepEqual(responses['6.2'][0].queues['6.2'], [outage('19:00', '20:30')]);
  const quiet = NATIONAL_QUEUES.filter((queue) => queue !== '1.2' && queue !== '6.2');
  for (const queue of quiet) assert.deepEqual(responses[queue][0].queues[queue], [], queue);

  const { fact } = factFromQueues(responses, new Date('2026-07-01T09:00:00Z'));
  assert.deepEqual(fact, { [JUL_1]: expected });

  // 20:00-21:00 loses only its second half on 1.2, only its first on 6.2.
  assert.deepEqual(
    [fact[JUL_1]['GPV1.2']['20'], fact[JUL_1]['GPV1.2']['21'], fact[JUL_1]['GPV1.2']['22'], fact[JUL_1]['GPV1.2']['23']],
    ['yes', 'second', 'no', 'yes']
  );
  assert.deepEqual(
    [fact[JUL_1]['GPV6.2']['19'], fact[JUL_1]['GPV6.2']['20'], fact[JUL_1]['GPV6.2']['21'], fact[JUL_1]['GPV6.2']['22']],
    ['yes', 'no', 'first', 'yes']
  );
  for (const queue of quiet) assert.deepEqual(Object.values(fact[JUL_1][`GPV${queue}`]), LIGHT, queue);
});

test('a window that runs past midnight carries into tomorrow when tomorrow is published', () => {
  // Their page measures "22:00–02:00" as four hours: an end before the start is on the next day.
  const { fact } = factFromQueues({
    '5.1': [
      day('20.11.2026', { '5.1': [outage('22:00', '02:00')] }),
      day('21.11.2026', { '5.1': [] })
    ]
  }, NOW);
  assert.deepEqual(Object.values(fact[NOV_20]['GPV5.1']), lightExcept({ 23: 'no', 24: 'no' }));
  assert.deepEqual(Object.values(fact[NOV_21]['GPV5.1']), lightExcept({ 1: 'no', 2: 'no' }));
});

test('the carried-over hours alone do not invent a day', () => {
  // Tomorrow unpublished means nothing is known about 02:00-24:00 — writing it as a day would
  // declare all of it light. The carry-over waits for tomorrow's own element.
  const { fact } = factFromQueues({
    '5.1': [day('20.11.2026', { '5.1': [outage('22:00', '02:00')] })]
  }, NOW);
  assert.deepEqual(Object.keys(fact), [String(NOV_20)]);
});

test('last night\'s window still darkens this morning, and tomorrow\'s goes nowhere', () => {
  const { fact } = factFromQueues({
    '5.2': [
      day('19.11.2026', { '5.2': [outage('23:00', '01:30')] }),
      day('20.11.2026', { '5.2': [] }),
      day('21.11.2026', { '5.2': [outage('23:00', '01:00')] })
    ]
  }, NOW);
  assert.deepEqual(Object.values(fact[NOV_20]['GPV5.2']), lightExcept({ 1: 'no', 2: 'first' }));
  assert.deepEqual(Object.values(fact[NOV_21]['GPV5.2']), lightExcept({ 24: 'no' }));
  assert.deepEqual(Object.keys(fact), [String(NOV_20), String(NOV_21)]);
});

test('an "00:00" end and a "24:00" end are both midnight and carry nothing over', () => {
  const at = (to) => factFromQueues({
    '2.2': [day('20.11.2026', { '2.2': [outage('22:00', to)] }), day('21.11.2026', { '2.2': [] })]
  }, NOW).fact;
  assert.deepEqual(at('00:00'), at('24:00'));
  assert.deepEqual(Object.values(at('00:00')[NOV_20]['GPV2.2']), lightExcept({ 23: 'no', 24: 'no' }));
  assert.deepEqual(Object.values(at('00:00')[NOV_21]['GPV2.2']), LIGHT);
  // A whole day written as 00:00–24:00 is a whole day.
  const allDay = factFromQueues({ '2.2': [day('20.11.2026', { '2.2': [outage('00:00', '24:00')] })] }, NOW).fact;
  assert.deepEqual(new Set(Object.values(allDay[NOV_20]['GPV2.2'])), new Set(['no']));
});

test('the 25-hour day keeps wall-clock rows, and tomorrow is found in its first hour', () => {
  // 00:30 on 25.10.2026 in Kyiv; at 04:00 the clocks go back to 03:00. "Now + 24 h" would still be
  // the 25th, so tomorrow has to come from the calendar.
  const { fact } = factFromQueues({
    '1.1': [
      day('25.10.2026', { '1.1': [outage('03:00', '04:00')] }),
      day('26.10.2026', { '1.1': [] })
    ]
  }, new Date('2026-10-24T21:30:00Z'));
  assert.deepEqual(Object.keys(fact), ['1792875600', '1792965600']);
  assert.equal(1792965600 - 1792875600, 25 * 3600);
  // The operator writes wall-clock times and the canonical grid has wall-clock rows: 03:00-04:00
  // is row 4, however many times that hour happens.
  assert.deepEqual(Object.values(fact[1792875600]['GPV1.1']), lightExcept({ 4: 'no' }));
});

test('status 1 or none is an outage; any other status stops the run', () => {
  // Their renderer ignores `status`: every listed window is under "Відключення". Only 1 has been
  // seen, and the one public client that names 0 reads it as "no outage" — the opposite of their
  // page. Publishing either reading, or "maybe" between them, would be a guess; the app never
  // announces "maybe", so a downgraded outage would arrive without its alert.
  const { fact } = factFromQueues({
    '3.2': [day('20.11.2026', { '3.2': [outage('10:00', '11:00'), { from: '15:00', to: '16:00' }] })]
  }, NOW);
  assert.deepEqual(Object.values(fact[NOV_20]['GPV3.2']), lightExcept({ 11: 'no', 16: 'no' }));

  for (const status of ['1', 0, 2, null, true, 'SCHEDULED', { code: 1 }]) {
    assert.throws(
      () => factFromQueues({ '3.2': [day('20.11.2026', { '3.2': [outage('10:00', '11:00', status)] })] }, NOW),
      /unknown status/,
      JSON.stringify(status)
    );
  }
});

test('times off the half-hour grid darken every half hour they touch', () => {
  const { fact } = factFromQueues({
    '4.1': [day('20.11.2026', { '4.1': [outage('16:10', '16:20'), outage('18:15', '19:45')] })]
  }, NOW);
  assert.deepEqual(Object.values(fact[NOV_20]['GPV4.1']), lightExcept({ 17: 'first', 19: 'no', 20: 'no' }));
});

test('the update stamp is the latest approval among the days shown', () => {
  const { update } = factFromQueues({
    '1.1': [
      day('19.11.2026', { '1.1': [] }, '20.11.2026 23:59'),
      day('20.11.2026', { '1.1': [] }, '19.11.2026 19:52'),
      day('21.11.2026', { '1.1': [] }, '20.11.2026 18:05')
    ],
    '1.2': [day('20.11.2026', { '1.2': [] }, '20.11.2026 09:15')]
  }, NOW);
  // The stale day's stamp is ignored even though it sorts last: it describes nothing published.
  assert.equal(update, '20.11.2026 18:05');

  const unstamped = factFromQueues({ '1.1': [{ eventDate: '20.11.2026', queues: { '1.1': [] } }] }, NOW);
  assert.equal(unstamped.update, null);
});

test('two identical elements for one date are one; two different ones stop the run', () => {
  const same = day('20.11.2026', { '1.1': [outage('10:00', '12:00')] });
  const { fact } = factFromQueues({ '1.1': [same, structuredClone(same)] }, NOW);
  assert.equal(fact[NOV_20]['GPV1.1']['11'], 'no');

  // Their page would silently show the first. Which one is in force cannot be known.
  const other = day('20.11.2026', { '1.1': [outage('14:00', '16:00')] });
  assert.throws(() => factFromQueues({ '1.1': [same, other] }, NOW), /two different schedules/);
  const silent = day('20.11.2026', {});
  assert.throws(() => factFromQueues({ '1.1': [same, silent] }, NOW), /two different schedules/);
});

test('every shape the operator\'s page would not read stops the run instead of being guessed', () => {
  const broken = [
    [{ message: 'Internal error' }, /response is not an array/],
    [[null], /element is not an object/],
    [[day('2026-11-20', { '1.1': [] })], /not DD\.MM\.YYYY/],
    [[day('31.02.2026', { '1.1': [] })], /not DD\.MM\.YYYY/],
    [[day('20.11.26', { '1.1': [] })], /not DD\.MM\.YYYY/],
    [[{ queues: { '1.1': [] } }], /not DD\.MM\.YYYY/],
    [[day('20.11.2026', [])], /queues is not an object/],
    [[day('20.11.2026', null)], /queues is not an object/],
    [[day('20.11.2026', { '1.1': {} })], /queue 1\.1: not an array/],
    [[day('20.11.2026', { '1.1': ['10:00-12:00'] })], /interval is not an object/],
    [[day('20.11.2026', { '1.1': [{ from: '10:00' }] })], /is not HH:mm/],
    [[day('20.11.2026', { '1.1': [outage('7:30', '09:00')] })], /is not HH:mm/],
    [[day('20.11.2026', { '1.1': [outage('07:30:00', '09:00:00')] })], /is not HH:mm/],
    [[day('20.11.2026', { '1.1': [outage('22:00', '24:30')] })], /is not HH:mm/],
    [[day('20.11.2026', { '1.1': [{ from: 1030, to: 1200 }] })], /is not HH:mm/],
    [[day('20.11.2026', { '1.1': [outage('24:00', '02:00')] })], /cannot start at 24:00/],
    [[day('20.11.2026', { '1.1': [outage('10:00', '10:00')] })], /has no length/],
    [[day('20.11.2026', { '1.1': [outage('00:00', '00:00')] })], /has no length/],
    [[day('20.11.2026', { '1.1': [outage('10:00', '12:00', '1')] })], /unknown status "1"/],
    // Another черга's window, in this черга's answer, is still the operator's payload.
    [[day('20.11.2026', { '1.1': [], '1.2': [outage('9:00', '10:00')] })], /queue 1\.2\[0\] from/],
    [[day('20.11.2026', { '1.1': [], '1.2': [outage('09:00', '10:00', 0)] })], /queue 1\.2\[0\]: unknown status 0/],
    // So is a day that would be thrown away as stale.
    [[day('01.10.2025', { '1.1': [outage('10:00', '10:00')] })], /has no length/],
    [[day('01.10.2025', { '1.1': [outage('10:00', '11:00', 2)] })], /unknown status 2/],
    [[{ ...day('20.11.2026', { '1.1': [] }), scheduleApprovedSince: 1795164000 }], /scheduleApprovedSince is a number/]
  ];
  for (const [payload, error] of broken) {
    assert.throws(() => factFromQueues({ '1.1': payload }, NOW), error, JSON.stringify(payload));
  }
});

/**
 * `fetchRegion` against a stand-in for be-svitlo — no network, and no real waiting. `serve(method)`
 * plays the operator; `setTimeout` runs on a virtual clock that moves to the next timer only once
 * everything else has settled, so the spacing is measured exactly instead of the suite sitting
 * through thirteen seconds of it. Every request is logged with the virtual time it left at.
 */
async function offlineRun(serve) {
  const real = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map();
  const requests = [];
  let clock = 0;
  let nextTimer = 1;
  globalThis.setTimeout = (callback, ms = 0) => {
    timers.set(nextTimer, { at: clock + ms, callback });
    return nextTimer++;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ at: clock, method, url: String(url), userAgent: init.headers?.['user-agent'] });
    return serve(method, String(url));
  };

  let outcome;
  fetchRegion({ id: 'ivano-frankivsk', title: 'Івано-Франківська область' })
    .then((snapshot) => { outcome = { snapshot }; }, (error) => { outcome = { error }; });
  try {
    while (!outcome) {
      // The real setImmediate: by the time it fires, everything the stand-ins queued has run.
      await new Promise((resolve) => setImmediate(resolve));
      if (outcome) break;
      const next = [...timers].sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next) throw new Error('fetchRegion is waiting on nothing');
      timers.delete(next[0]);
      clock = next[1].at;
      next[1].callback();
    }
  } finally {
    Object.assign(globalThis, real);
  }
  return { ...outcome, requests };
}

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
const BE_SVITLO = 'https://be-svitlo.oe.if.ua';

/** The gaps between consecutive requests, in virtual milliseconds. */
const gaps = (requests) => requests.slice(1).map((request, index) => request.at - requests[index].at);

test('a run asks for the queue list, then each national черга in turn, a second apart', async () => {
  // REAL answers: the list and the twelve `[]` of 2026-10-01.
  const { snapshot, error, requests } = await offlineRun((method) =>
    reply(method === 'POST' ? REAL_QUEUE_LIST : []));
  assert.equal(error, undefined);
  assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
    `POST ${BE_SVITLO}/gpv-queue-list`,
    ...NATIONAL_QUEUES.map((code) => `GET ${BE_SVITLO}/schedule-by-queue?queue=${code}`)
  ]);
  // A small operator's server, often during a blackout: never two requests within a second.
  assert.ok(gaps(requests).every((gap) => gap >= 1000), String(gaps(requests)));
  // The POST's copied User-Agent has to stay in step with the one lib/http.mjs gives every GET.
  assert.equal(new Set(requests.map(({ userAgent }) => userAgent)).size, 1);
  assert.match(requests[0].userAgent, /^svitlo-mirror\//);

  assert.deepEqual(validate(snapshot), []);
  assert.deepEqual(snapshot.fact.data, []);
  assert.deepEqual(Object.keys(snapshot.preset.sch_names), NATIONAL_QUEUES.map((code) => `GPV${code}`));
});

test('a run publishes what the operator lists for today and tomorrow', async () => {
  // The real clock decides "today" inside fetchRegion, so both days are offered: should midnight
  // pass mid-test, the second is still shown.
  const ddmmyyyy = (date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date).split('-').reverse().join('.');
  const noon = (kyivDayStart() + 12 * 3600) * 1000;
  const days = [ddmmyyyy(new Date(noon)), ddmmyyyy(new Date(noon + 86400000))];
  const { snapshot, error } = await offlineRun((method, url) => {
    if (method === 'POST') return reply(REAL_QUEUE_LIST);
    return reply(url.endsWith('=4.2') ? days.map((date) => day(date, { '4.2': [outage('10:00', '12:00')] })) : []);
  });
  assert.equal(error, undefined);
  assert.deepEqual(validate(snapshot), []);
  const published = Object.values(snapshot.fact.data);
  assert.ok(published.length >= 1);
  for (const byQueue of published) {
    assert.deepEqual(Object.keys(byQueue), ['GPV4.2']);
    assert.deepEqual(Object.values(byQueue['GPV4.2']), lightExcept({ 11: 'no', 12: 'no' }));
  }
  assert.equal(snapshot.fact.update, '19.11.2026 19:52');
});

test('a changed queue list stops the run before any черга is asked about', async () => {
  const { error, requests } = await offlineRun(() => reply(REAL_QUEUE_LIST.slice(1)));
  assert.match(error.message, /gpv-queue-list changed/);
  assert.equal(requests.length, 1);
});

test('the queue list survives a dropped connection the way every GET does', async () => {
  /** The list fails `failures` times — `fail()` decides how — and then answers. */
  const flaky = (failures, fail) => {
    let posts = 0;
    return (method) => {
      if (method !== 'POST') return reply([]);
      return ++posts <= failures ? fail() : reply(REAL_QUEUE_LIST);
    };
  };
  const dropped = () => { throw new TypeError('fetch failed'); };

  // One blip used to cost the whole run; now it costs a second.
  for (const fail of [dropped, () => reply({ message: 'Bad Gateway' }, 502)]) {
    const { error, requests } = await offlineRun(flaky(1, fail));
    assert.equal(error, undefined);
    assert.deepEqual(requests.slice(0, 2).map(({ method }) => method), ['POST', 'POST']);
    assert.equal(requests.length, 14);
    assert.ok(gaps(requests).every((gap) => gap >= 1000), String(gaps(requests)));
  }

  // Three in a row is an outage of their API, not a blip: the run fails before any GET.
  const { error, requests } = await offlineRun(flaky(3, dropped));
  assert.match(error.message, /fetch failed/);
  assert.deepEqual(requests.map(({ method }) => method), ['POST', 'POST', 'POST']);
  assert.deepEqual(gaps(requests), [1000, 2000]);
});
