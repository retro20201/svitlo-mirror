import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blocks, fold, wallToEpoch, queueCalendar, calendarQueues, writeCalendars } from './lib/ics.mjs';
import { kyivDayStart } from './lib/canonical.mjs';

const DAY = kyivDayStart(new Date('2026-10-20T12:00:00Z'));          // 2026-10-19T21:00:00Z
const HOURS = { 9: 'no', 10: 'no', 19: 'first', 20: 'maybe', 23: 'second' };

function snapshot(fact = { [DAY]: { 'GPV1.1': HOURS } }) {
  return {
    regionId: 'kyiv', fact: { data: fact, update: '20.10.2026 08:00' },
    preset: { sch_names: { 'GPV1.1': 'Черга 1.1' }, data: { 'GPV1.1': { 1: {} } } }
  };
}
const unfold = (text) => text.replace(/\r\n /g, '');
const events = (text) => unfold(text).split('BEGIN:VEVENT').slice(1).map((e) => Object.fromEntries(
  e.split('\r\n').filter((l) => /^[A-Z-]+[:;]/.test(l) && !l.startsWith('END') && !l.startsWith('BEGIN')).map((l) => [l.split(/[:;]/)[0], l.slice(l.indexOf(':') + 1)])));

test('the hours of a day become blocks of half hours, a maybe apart from a cut', () => {
  assert.deepEqual(blocks(HOURS), [
    { state: 'off', from: 8 * 60, to: 10 * 60 },
    { state: 'off', from: 18 * 60, to: 18 * 60 + 30 },
    { state: 'possible', from: 19 * 60, to: 20 * 60 },
    { state: 'off', from: 22 * 60 + 30, to: 23 * 60 }
  ]);
  assert.deepEqual(blocks({}), [], 'an hour the operator left out is light');
  // 18:30–19:00 first half of hour 19 is off, then hour 19's second half on; hour 24's "no" reaches midnight.
  assert.deepEqual(blocks({ 24: 'no' }), [{ state: 'off', from: 23 * 60, to: 24 * 60 }]);
});

test('Kyiv wall clock to instants, on an ordinary day and at the end of October', () => {
  assert.equal(new Date(wallToEpoch(DAY, 8 * 60) * 1000).toISOString(), '2026-10-20T05:00:00.000Z');
  assert.equal(new Date(wallToEpoch(DAY, 24 * 60) * 1000).toISOString(), '2026-10-20T21:00:00.000Z');
  // 25 October 2026: 03:00 happens twice; the first one is meant, and 04:00 is the only one after the second.
  const long = kyivDayStart(new Date('2026-10-25T12:00:00Z'));
  assert.equal(new Date(wallToEpoch(long, 3 * 60) * 1000).toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(new Date(wallToEpoch(long, 4 * 60) * 1000).toISOString(), '2026-10-25T02:00:00.000Z');
  assert.equal(new Date(wallToEpoch(long, 24 * 60) * 1000).toISOString(), '2026-10-25T22:00:00.000Z', 'the day is 25 hours');
});

test('a calendar of one queue: a cut with an alarm, a maybe without, stable identifiers', () => {
  const text = queueCalendar({ snapshot: snapshot(), regionId: 'kyiv', regionTitle: 'Київ', queueId: 'GPV1.1' });
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n') && text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'every line ends with CRLF');
  assert.ok(text.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75), 'lines are folded at 75 octets');
  const list = events(text);
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((e) => [e.DTSTART, e.DTEND]), [
    ['20261020T050000Z', '20261020T070000Z'],
    ['20261020T150000Z', '20261020T153000Z'],
    ['20261020T160000Z', '20261020T170000Z'],
    ['20261020T193000Z', '20261020T200000Z']
  ]);
  assert.deepEqual(list.map((e) => e.SUMMARY), ['Світла немає', 'Світла немає', 'Можливе вимкнення', 'Світла немає']);
  assert.deepEqual(list.map((e) => e.STATUS), ['CONFIRMED', 'CONFIRMED', 'TENTATIVE', 'CONFIRMED']);
  assert.equal(new Set(list.map((e) => e.UID)).size, 4);
  assert.equal(list[0].UID, `svitlo-kyiv-GPV1.1-${DAY}-480@koly-svitlo.web.app`);
  assert.equal((text.match(/BEGIN:VALARM/g) ?? []).length, 3, 'only the cuts have an alarm');
  assert.ok(unfold(text).includes('X-WR-CALNAME:Світло · Київ · Черга 1.1'));
  // Deterministic: the same file, the same bytes.
  assert.equal(text, queueCalendar({ snapshot: snapshot(), regionId: 'kyiv', regionTitle: 'Київ', queueId: 'GPV1.1' }));
});

test('no published day, no events — and the weekly template is never one', () => {
  const none = queueCalendar({ snapshot: snapshot([]), regionId: 'kyiv', regionTitle: 'Київ', queueId: 'GPV1.1' });
  assert.equal(events(none).length, 0);
  assert.ok(none.includes('BEGIN:VCALENDAR') && none.includes('END:VCALENDAR'));
});

test('long text is folded inside a character, commas and semicolons are escaped', () => {
  const line = 'SUMMARY:' + 'Світла немає '.repeat(12);
  const folded = fold(line);
  assert.ok(folded.split('\r\n').every((piece) => new TextEncoder().encode(piece).length <= 75));
  assert.equal(folded.replace(/\r\n /g, ''), line);
  const text = queueCalendar({ snapshot: { ...snapshot(), preset: { sch_names: { 'GPV1.1': 'Черга 1,1; а' } } }, regionId: 'kyiv', regionTitle: 'Київ', queueId: 'GPV1.1' });
  assert.ok(unfold(text).includes('Черга 1\\,1\; а'));
});

test('the queues with something to say, from the template or a published day', () => {
  assert.deepEqual(calendarQueues(snapshot({ [DAY]: { 'GPV2.1': {} } })), ['GPV1.1', 'GPV2.1']);
  assert.deepEqual(calendarQueues({ fact: { data: [] }, preset: { data: {} } }), []);
  assert.deepEqual(calendarQueues({ fact: { data: [] }, preset: { data: { '../x': {}, 'GPV1.1': {} } } }), ['GPV1.1']);
});

test('calendars are written for every region on disk, rewritten only when they change, and pruned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ics-'));
  await writeFile(join(dir, 'kyiv.json'), JSON.stringify(snapshot()));
  const regions = [{ id: 'kyiv', title: 'Київ' }, { id: 'lviv', title: 'Львівська область' }];
  assert.equal(await writeCalendars(dir, regions, { warn() {} }), 1, 'lviv has no file and is skipped');
  assert.deepEqual(await readdir(join(dir, 'ics', 'kyiv')), ['GPV1.1.ics']);
  assert.equal(await writeCalendars(dir, regions, { warn() {} }), 0, 'the same file, nothing rewritten');
  await mkdir(join(dir, 'ics', 'kyiv'), { recursive: true });
  await writeFile(join(dir, 'ics', 'kyiv', 'GONE.ics'), 'old');
  await writeCalendars(dir, regions, { warn() {} });
  assert.deepEqual(await readdir(join(dir, 'ics', 'kyiv')), ['GPV1.1.ics']);
  // A broken region file costs only itself.
  await writeFile(join(dir, 'lviv.json'), '{ broken');
  assert.equal(await writeCalendars(dir, regions, { warn() {} }), 0);
});
