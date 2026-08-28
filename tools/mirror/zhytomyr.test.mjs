import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedulePage } from './sources/zhytomyr.mjs';

// Житомиробленерго encodes the whole schedule in cell background colours, so the parser reads
// styling rather than text. These fixtures are the real markup of www.ztoe.com.ua/unhooking-search.php:
// the cell templates are verbatim (only the run of `&nbsp;` fillers is shortened) and the colour
// patterns are the ones the operator actually published on 19.11.2025 and 10.02.2026, recovered
// from Common Crawl. Ukrainian text appears as U+FFFD because the page is windows-1251 and
// `fetch().text()` decodes UTF-8 — which is exactly what the adapter has to cope with.

const CELL = (color) =>
  `<td style="text-align:center;border-top:1pt solid black; border-right:1pt solid black; ` +
  `border-bottom:1pt solid black; border-left:1pt solid black; background: ${color}">\n` +
  `<a href="/unhooking-search.php?pidcherga_id=1" target="_blank" style="text-decoration: none;">&nbsp;</a>\n</td>`;

/** `.` = white (light guaranteed), `X` = red (off when Укренерго applies limits). */
const cells = (pattern) => [...pattern].map((slot) => CELL(slot === 'X' ? '#ff3333' : '#ffffff')).join('');

const queueRow = (label, patterns) =>
  `<tr>\n<td style="width:30pt; background: white; text-align:center;">` +
  `<a href="/unhooking-search.php?pidcherga_id=1"><b style="font-size:12pt;color:black;">${label}</b></a></td>` +
  `<td style="width:3pt">&nbsp;</td>${patterns.map(cells).join('<td style="width:3pt">&nbsp;</td>')}</tr>`;

const page = (dates, rows) => `<h3>���� 11:30 19.11.2025�. ��� "���������"</h3>
<h4>���� ��������� - 12:00 19.11.2025</h4>
<table x:str border="0" cellpadding="0" cellspacing="0">
<tr>
<td style="background: white; text-align:center;" rowspan="2"><b style="font-size:9pt;">�����</b></td>
<td style="background: white; text-align:center;" rowspan="2"><b style="font-size:9pt;color:black;">�������</b></td>
<td style="width:3pt">&nbsp;</td>
${dates.map((date) => `<td style="background: white; text-align:center;" colspan="48"><b style="font-size:12pt;">${date}</b></td>`).join('')}
</tr>
${rows.join('\n')}
</table>`;

// 19.11.2025, черга 1.1 and 3.2 as published at 12:00.
const NOV19_1_1 = '........XXXXXX......XXXXXX......XXXXXXX......XXX';
const NOV19_3_2 = 'XXXX................XXXXXX......XXXX........XXXX';
// 10.02.2026, черга 3.1 — the day the outages started and ended mid-hour.
const FEB10_3_1 = '.....XXXXXXXXXXXX.....XXXXXXXXXXXX..........XXXX';
const KYIV_MIDNIGHT_19_11_2025 = 1763503200;

test('a published day becomes hours keyed by Kyiv midnight', () => {
  const { queues, fact, update } = parseSchedulePage(
    page(['19.11.2025'], [queueRow('1.1', [NOV19_1_1]), queueRow('3.2', [NOV19_3_2])])
  );

  assert.deepEqual(queues, { 'GPV1.1': 'Черга 1.1', 'GPV3.2': 'Черга 3.2' });
  assert.deepEqual(Object.keys(fact), [String(KYIV_MIDNIGHT_19_11_2025)]);
  assert.deepEqual(Object.values(fact[KYIV_MIDNIGHT_19_11_2025]['GPV1.1']), [
    'yes', 'yes', 'yes', 'yes', 'no', 'no', 'no', 'yes', 'yes', 'yes', 'no', 'no',
    'no', 'yes', 'yes', 'yes', 'no', 'no', 'no', 'first', 'yes', 'yes', 'second', 'no'
  ]);
  assert.deepEqual(Object.values(fact[KYIV_MIDNIGHT_19_11_2025]['GPV3.2']), [
    'no', 'no', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'no', 'no',
    'no', 'yes', 'yes', 'yes', 'no', 'no', 'yes', 'yes', 'yes', 'yes', 'no', 'no'
  ]);
  // The banner above the grid carries the time Укренерго last changed the number of queues in
  // force; the operator's own "дата оновлення" is the one that belongs in the snapshot.
  assert.equal(update, '12:00 19.11.2025');
});

test('half-hour edges keep their own code instead of rounding to a whole hour', () => {
  const { fact } = parseSchedulePage(page(['10.02.2026'], [queueRow('3.1', [FEB10_3_1])]));
  const hours = fact[Object.keys(fact)[0]]['GPV3.1'];

  // Light went at 02:30 and came back at 08:30 — the two states ДТЕК spells `second` and `first`.
  assert.equal(hours['3'], 'second');
  assert.equal(hours['9'], 'first');
  assert.equal(hours['4'], 'no');
  assert.equal(hours['10'], 'yes');
});

test('an all-white grid is queues without a schedule, not a day of guaranteed light', () => {
  // What the page renders out of season: the grid is still printed, every cell white. The operator
  // only guarantees light "за умови відсутності аварійних відключень", so this is not a schedule.
  const { queues, fact } = parseSchedulePage(
    page(['28.08.2026'], [queueRow('1.1', ['.'.repeat(48)]), queueRow('1.2', ['.'.repeat(48)])])
  );

  assert.equal(Object.keys(queues).length, 2);
  assert.deepEqual(fact, {});
});

test('a page that loses its grid still names the national queues', () => {
  // A snapshot with no queues is published as degraded. Житомир runs the national 1.1–6.2 scheme,
  // so the queue list stays true even when the table is missing.
  const { queues, fact } = parseSchedulePage('<h3>���</h3><table></table>');

  assert.equal(Object.keys(queues).length, 12);
  assert.equal(queues['GPV6.2'], 'Черга 6.2');
  assert.deepEqual(fact, {});
});

test('a second published day is read from its own 48 columns', () => {
  // Not a layout the operator has been seen using — one day at a time is all they publish. The
  // header allows several, so the columns are matched to dates; this pins that mapping.
  const { fact } = parseSchedulePage(
    page(['19.11.2025', '10.02.2026'], [queueRow('3.1', [NOV19_3_2, FEB10_3_1])])
  );

  assert.equal(Object.keys(fact).length, 2);
  assert.equal(fact[KYIV_MIDNIGHT_19_11_2025]['GPV3.1']['1'], 'no');
  assert.equal(fact[1770674400]['GPV3.1']['3'], 'second');
});
