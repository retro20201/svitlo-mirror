import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { parseDaySheet, archiveDaysFromListing } from './sources/ivano-frankivsk.mjs';

/**
 * Івано-Франківськ is the one region whose hour parsing can be proven rather than argued about, so
 * the fixture below is the real thing: the bytes of
 * shutdowns_schedule_archive_20260701.xlsx, downloaded from oe.if.ua on 2026-08-28
 * (sha256 dcd2c315c08461a1a6d35c80f13cd8c63e4e4c661367ba6ca9b43ffc3a9b6fcc, 7175 bytes).
 *
 * It is worth knowing why this particular day. On 2026-08-28 Ukraine is out of restriction season
 * and the archive is almost entirely "Відключень не було"; 01.07.2026 is the only day the operator
 * has filed a ГПВ sheet for in the whole retained window, and it carries exactly two queues with
 * outages. That is thin, but it is real, and between them the two queues pin down the case that
 * actually matters — an outage that starts and ends on the half hour, which the canonical format
 * has to split into `second` and `first` rather than blacking out a whole hour.
 *
 * The sheet's own dialect is therefore load-bearing and verified, not assumed: queue labels arrive
 * as *numbers* (`<c r="A3" s="5" t="n"><v>1.1</v></c>`), every other cell is an inline string down
 * to the empty ones (`<is><t></t></is>`), there is no sharedStrings.xml, and `<dimension>` lies —
 * it claims A1:B16 for a sheet 49 columns wide, which is why nothing here trusts it.
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

test('the real sheet yields the twelve national queues and nothing else', () => {
  const parsed = parseDaySheet(REAL_WORKBOOK);
  assert.deepEqual(Object.keys(parsed), [
    'GPV1.1', 'GPV1.2', 'GPV2.1', 'GPV2.2', 'GPV3.1', 'GPV3.2',
    'GPV4.1', 'GPV4.2', 'GPV5.1', 'GPV5.2', 'GPV6.1', 'GPV6.2'
  ]);
  // Row 1 is the title, row 2 the times, row 16 the legend — none may become a queue.
  for (const hours of Object.values(parsed)) assert.equal(Object.keys(hours).length, 24);
});

test('the real outage on queue 1.2 splits 20:30-22:00 into second then no', () => {
  // The sheet marks slots 20:30, 21:00 and 21:30. 20:00-21:00 loses only its second half.
  const hours = parseDaySheet(REAL_WORKBOOK)['GPV1.2'];
  assert.equal(hours['20'], 'yes');
  assert.equal(hours['21'], 'second');
  assert.equal(hours['22'], 'no');
  assert.equal(hours['23'], 'yes');
});

test('the real outage on queue 6.2 splits 19:00-20:30 into no then first', () => {
  // Marked at 19:00, 19:30 and 20:00, so 20:00-21:00 keeps its second half.
  const hours = parseDaySheet(REAL_WORKBOOK)['GPV6.2'];
  assert.equal(hours['19'], 'yes');
  assert.equal(hours['20'], 'no');
  assert.equal(hours['21'], 'first');
  assert.equal(hours['22'], 'yes');
});

test('the ten untouched queues in the real sheet are a full day of light', () => {
  const parsed = parseDaySheet(REAL_WORKBOOK);
  for (const [queue, hours] of Object.entries(parsed)) {
    if (queue === 'GPV1.2' || queue === 'GPV6.2') continue;
    assert.deepEqual(new Set(Object.values(hours)), new Set(['yes']), queue);
  }
});

/**
 * Cases the one real sheet cannot cover, written in the dialect it just proved: a numeric label in
 * column A, inline strings across B..AW.
 */
const SHEET_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xml:space="preserve"><dimension ref="A1:B16"></dimension><sheetData>';

function columnLetters(index) {
  let letters = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function queueRow(rowIndex, label, marks) {
  let xml = `<row r="${rowIndex}" ><c r="A${rowIndex}" s="5" t="n"><v>${label}</v></c>`;
  marks.forEach((mark, slot) => {
    const reference = `${columnLetters(slot + 2)}${rowIndex}`;
    xml += `<c r="${reference}" s="7" t="inlineStr"><is><t>${mark}</t></is></c>`;
  });
  return xml + '</row>';
}

const blank = () => Array(48).fill('');

/** Marks the half-hour slots covering [from, to) in hours, e.g. off(marks, 8, 11.5). */
function off(marks, from, to, mark = 'X') {
  for (let slot = from * 2; slot < to * 2; slot++) marks[slot] = mark;
  return marks;
}

/** A real zip, because the adapter reads the central directory rather than the local headers. */
function buildXlsx(sheetXml) {
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const raw = Buffer.from(sheetXml);
  const deflated = deflateRawSync(raw);
  const checksum = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + deflated.length, 16);

  return Buffer.concat([local, name, deflated, central, name, end]);
}

const workbook = (rows) => buildXlsx(SHEET_HEAD + rows.join('') + '</sheetData></worksheet>');

test('the Cyrillic Х is the same mark as the Latin X', () => {
  // Indistinguishable on screen, and the sheet is filled in by hand — reading one as an outage and
  // the other as an unknown symbol would split one queue's evening into two different answers.
  const latin = parseDaySheet(workbook([queueRow(3, '1.1', off(blank(), 9, 10, 'X'))]));
  const cyrillic = parseDaySheet(workbook([queueRow(3, '1.1', off(blank(), 9, 10, 'Х'))]));
  assert.equal(latin['GPV1.1']['10'], 'no');
  assert.deepEqual(cyrillic['GPV1.1'], latin['GPV1.1']);
});

test('a mark nobody has seen before is reported as possible, not as light', () => {
  const parsed = parseDaySheet(workbook([queueRow(3, '2.1', off(blank(), 14, 15, '?'))]));
  assert.equal(parsed['GPV2.1']['15'], 'maybe');
});

test('float noise in a numeric queue label still names its queue', () => {
  // The label is a number in the sheet, so a writer is free to hand back 1.1000000000000001.
  const parsed = parseDaySheet(workbook([queueRow(3, '1.1000000000000001', blank())]));
  assert.deepEqual(Object.keys(parsed), ['GPV1.1']);
});

test('the edges of the day survive the column arithmetic', () => {
  const parsed = parseDaySheet(workbook([
    queueRow(3, '1.1', off(blank(), 0, 1)),
    queueRow(4, '6.2', off(blank(), 23, 24))
  ]));
  assert.equal(parsed['GPV1.1']['1'], 'no');
  assert.equal(parsed['GPV1.1']['2'], 'yes');
  assert.equal(parsed['GPV6.2']['23'], 'yes');
  assert.equal(parsed['GPV6.2']['24'], 'no');
});

test('a queue added below row 14 is picked up rather than dropped', () => {
  // Rows 3-14 are the documented twelve; finding queues by the shape of their label means a
  // thirteenth would reach the app instead of vanishing.
  const parsed = parseDaySheet(workbook([queueRow(15, '7.1', off(blank(), 3, 4))]));
  assert.equal(parsed['GPV7.1']['4'], 'no');
});

test('cells the writer omitted altogether default to light', () => {
  const sparse = SHEET_HEAD +
    '<row r="3" ><c r="A3" s="5" t="n"><v>1.1</v></c>' +
    '<c r="C3" s="7" t="inlineStr"><is><t>X</t></is></c></row>' +
    '</sheetData></worksheet>';
  const parsed = parseDaySheet(buildXlsx(sparse));
  assert.equal(parsed['GPV1.1']['1'], 'second'); // column C is 00:30-01:00
  assert.equal(parsed['GPV1.1']['2'], 'yes');
  assert.equal(Object.keys(parsed['GPV1.1']).length, 24);
});

/**
 * The listing markup below is verbatim from oe.if.ua on 2026-08-28 — both the row that carries a
 * workbook and the far commoner row that does not.
 */
const REAL_ROW_WITH_FILE =
  "<li class='schedule-archive-row'>\n" +
  '<a class="schedule-archive-row__link" href="/uk/download_schedule_archive?filename=' +
  'shutdowns_schedule_archive_20260701.xlsx"><span class=\'schedule-archive-row__date\'>' +
  "01.07.2026</span>\n<span class='schedule-archive-row__label'>ГПВ</span>\n" +
  "<span class='schedule-archive-row__size'>\n0.01\nМб\n</span>\n" +
  "<span class='schedule-archive-row__download'>↓</span>\n</a></li>";

const realEmptyRow = (date) =>
  "<li class='schedule-archive-row schedule-archive-row--empty'>\n" +
  `<span class='schedule-archive-row__date'>${date}</span>\n` +
  "<span class='schedule-archive-row__status'>Відключень не було</span>\n</li>";

test('a day that has a workbook is found by its filename', () => {
  const listing = realEmptyRow('31.07.2026') + realEmptyRow('02.07.2026') + REAL_ROW_WITH_FILE;
  assert.deepEqual(archiveDaysFromListing(listing, '2026-07'), ['20260701']);
});

test('a listing that silently fell back to the current month is discarded', () => {
  // ?month= serves the current month for anything outside the window the site retains. Trusting it
  // would file July's outage under December and show people a schedule for the wrong day.
  const listing = realEmptyRow('31.07.2026') + REAL_ROW_WITH_FILE;
  assert.deepEqual(archiveDaysFromListing(listing, '2025-12'), []);
});

test('a month with no outages at all yields no days rather than failing', () => {
  // This is the whole of the archive on 2026-08-28, and it is a correct answer, not a fault: the
  // region is published as seasonal and turns itself live when tables come back.
  const listing = realEmptyRow('27.08.2026') + realEmptyRow('26.08.2026');
  assert.deepEqual(archiveDaysFromListing(listing, '2026-08'), []);
});
