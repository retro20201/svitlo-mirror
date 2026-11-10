import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, scheduleOf, snapshotFrom } from './sources/cek.mjs';
import { amendmentOf, applyAmendments, tidy } from './lib/cek-amendments.mjs';
import { scheduleFromPosts } from './lib/telegram.mjs';
import { regionById } from './regions.mjs';

// ПрАТ «ПЕЕМ «ЦЕК», read from its channel @cek_info. The posts are the channel's own, 6–9 November 2026: the evening tables for
// the 7th to the 10th (the 9th with a ✅ before every window, the 10th without), Павлоград's separate two-queue grid, the posts that
// change the day («зміни в ГПВ…»), and the emergency starting, going on and being cancelled.

const POSTS = JSON.parse(readFileSync(new URL('./cek.fixture-2026-11-09.json', import.meta.url), 'utf8'));
const REGION = regionById('cek');
const at = (iso) => new Date(iso);
const day = (iso) => Math.floor(Date.parse(`${iso}T00:00:00+02:00`) / 1000);
/** The tables the posts hold, whatever day the test runs on: the reader keeps only yesterday onward by the real clock. */
const tables = () => scheduleFromPosts(prepare(POSTS), { since: day('2026-11-07') });

/** A queue's day as a string of 48 half-hours: `#` off, `.` on. */
function halves(fact, iso, queue) {
  const cells = fact[day(iso)]?.[queue];
  assert.ok(cells, `${queue} on ${iso}`);
  return Array.from({ length: 24 }, (_, hour) => ({
    yes: '..', no: '##', first: '#.', second: '.#', maybe: '??', mfirst: '?.', msecond: '.?'
  }[cells[String(hour + 1)]] ?? '--')).join('');
}
const window = (from, to) => (cut) => cut.slice(from * 2, to * 2);

test('only a day\'s table is changed for the shared reader: it says ГПВ, and its windows lose their ✅', () => {
  const table = POSTS.find((post) => post.id === 4343);
  assert.ok(/✅\s*01:30-04:00/u.test(table.text), 'the post of the 9th has marks');
  const [prepared] = prepare([table]);
  assert.ok(prepared.text.startsWith('ГПВ. '));
  assert.ok(!/✅/u.test(prepared.text));
  assert.ok(/Черга 1\.1\n01:30-04:00\n07:30-14:30\n21:30-24:00/u.test(prepared.text));

  for (const other of POSTS.filter((post) => ![4335, 4338, 4343, 4350].includes(post.id))) {
    assert.deepEqual(prepare([other])[0], other, `#${other.id} is left as it is`);
  }
});

test('the tables of the evening before are read: the 10th, with its windows bare, and the 9th, with its marks', () => {
  const { fact } = tables();
  // 10 листопада: «Черга 1.1 06:00-11:30 18:30-22:00»; «Черга 2.1 00:00-01:30 08:00-11:30 15:00-22:00»
  assert.equal(halves(fact, '2026-11-10', 'GPV1.1'), '.'.repeat(12) + '#'.repeat(11) + '.'.repeat(14) + '#'.repeat(7) + '.'.repeat(4));
  assert.equal(
    halves(fact, '2026-11-10', 'GPV2.1'),
    '#'.repeat(3) + '.'.repeat(13) + '#'.repeat(7) + '.'.repeat(7) + '#'.repeat(14) + '.'.repeat(4)
  );
  // 9 листопада: «Черга 1.1 01:30-04:00 07:30-14:30 21:30-24:00»
  assert.equal(
    halves(fact, '2026-11-09', 'GPV1.1'),
    '.'.repeat(3) + '#'.repeat(5) + '.'.repeat(7) + '#'.repeat(14) + '.'.repeat(14) + '#'.repeat(5)
  );
});

test('all twelve queues have a table for each day', () => {
  const { fact } = tables();
  for (const iso of ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']) {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      for (const sub of [1, 2]) assert.ok(halves(fact, iso, `GPV${n}.${sub}`).length === 48, `${iso}: ${n}.${sub}`);
    }
  }
});

test('the .1 and .2 of a queue are NOT always the same hours (7 November: 2.1 and 2.2), so a whole «Черга N» is on both lines', () => {
  const { fact } = tables();
  assert.notEqual(halves(fact, '2026-11-07', 'GPV2.1'), halves(fact, '2026-11-07', 'GPV2.2'));
  // The address dictionary (tools/addr/build-cek.mjs) gives a house the operator files under «Черга 2», with no sub-queue, both
  // 2.1 and 2.2: choosing one of them for it would show half of those houses another house's hours on the days they differ.
});

test('what the posts say about Павлоград\'s own grid and about changes during the day is not mistaken for a table', () => {
  const found = tables();
  assert.equal(Object.keys(found.fact).length, 4, 'four days, the 7th to the 10th: one table each, nothing from the other posts');
  assert.equal(found.queues.length, 12);
  assert.ok(found.queues.every((key) => /^GPV[1-6]\.[12]$/.test(key)));
});

test('the emergency is told from the channel: from «Діють ЕКСТРЕНІ ВІДКЛЮЧЕННЯ», until «скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ»', async () => {
  const during = await snapshotFrom(POSTS, REGION, { now: at('2026-11-09T17:00:00Z'), log: () => {} });
  assert.deepEqual(during.fact.emergency, [day('2026-11-09')]);
  const after = await snapshotFrom(POSTS, REGION, { now: at('2026-11-09T19:00:00Z'), log: () => {} });
  assert.equal(after.fact.emergency, undefined, 'cancelled at 20:49 Kyiv time');
});

test('the region is the operator\'s own and says so: its source, the channel and an emergency signal', () => {
  assert.equal(REGION.source, 'cek');
  assert.equal(REGION.emergencyTelegram.channel, 'cek_info');
  assert.ok(REGION.title.includes('ЦЕК'));
});

// --- «зміни у ГПВ»: what the posts of the day do to its table (lib/cek-amendments.mjs)


const CHANGES = JSON.parse(readFileSync(new URL('./cek.fixture-amendments.json', import.meta.url), 'utf8'));
const EVERYTHING = [...POSTS, ...CHANGES];
const FROM = day('2026-10-15');
/** Half-hours `from`–`to` (hh:mm as numbers of half-hours) of a queue on a day. */
const cells = (result, iso, queue, from, to) => result.halves[day(iso)][queue].slice(from, to);
const all = (list, state) => list.length > 0 && list.every((cell) => cell === state);

test('a phrase is read for its clauses: «з 22:00 до 24:00 застосовуються відлючення черг …» switches those queues off for that window', () => {
  const amendment = amendmentOf(POSTS.find((post) => post.id === 4352));
  assert.ok(amendment.delta, 'a phrase adds');
  assert.equal(amendment.epoch, day('2026-11-09'));
  const queues = [...new Set(amendment.delta.map((change) => change.key))].sort();
  assert.deepEqual(queues, ['GPV1.1', 'GPV1.2', 'GPV2.1', 'GPV2.2', 'GPV3.1', 'GPV3.2', 'GPV4.1', 'GPV4.2']);
  assert.ok(amendment.delta.every((change) => change.from === 44 && change.to === 48 && change.state === 'off'), '22:00–24:00');
});

test('a clause with no end is only «possible» from its start, and one with a window is off for it', () => {
  // «з 18:00 додатково застосовуються відлючення черги 1.1, 1.2 та черги 4.1, 4.2 - з 21:30 до 22:00»
  const { delta } = amendmentOf(POSTS.find((post) => post.id === 4346));
  const of = (key) => delta.filter((change) => change.key === key);
  assert.deepEqual(of('GPV1.1'), [{ key: 'GPV1.1', from: 36, to: 48, state: 'possible' }]);
  assert.deepEqual(of('GPV4.1'), [{ key: 'GPV4.1', from: 43, to: 44, state: 'off' }]);
});

test('Павлоград\'s grid, a table, an emergency notice and a note about equipment are not amendments', () => {
  for (const id of [4343, 4350, 4344, 4345, 4347, 4348, 4349]) {
    assert.equal(amendmentOf(POSTS.find((post) => post.id === id)), null, `#${id}`);
  }
});

test('the typos the operator\'s posts carry are taken out: «відлючення», «Укренерго"З 07:00»', () => {
  assert.equal(tidy('застосовуються відлючення черг'), 'застосовуються відключення черг');
  assert.equal(tidy('НЕК "Укренерго"З 07:00 додатково'), 'НЕК "Укренерго" З 07:00 додатково');
  assert.ok(amendmentOf(CHANGES.find((post) => post.id === 4308)).delta.some((change) => change.from === 14), '«З 07:00» is read, not the minute the post went out');
});

test('9 November: the phrases add to the evening and take nothing out', () => {
  const result = scheduleOf(EVERYTHING, { since: FROM });
  // 2.1's table: 01:30–04:00, 11:00–14:30, 18:00–22:00 — and «з 22:00 до 24:00» is added
  assert.ok(all(cells(result, '2026-11-09', 'GPV2.1', 36, 48), 'off'), '18:00–24:00 is off');
  assert.ok(all(cells(result, '2026-11-09', 'GPV2.1', 22, 29), 'off'), '11:00–14:30 stays');
  // 4.1: «черги 4.1, 4.2 — з 21:30 до 22:00» and «з 22:00 до 24:00»
  assert.ok(all(cells(result, '2026-11-09', 'GPV4.1', 43, 48), 'off'), '21:30–24:00 is off');
  // 1.1: «з 18:00 додатково» with no end is possible, and the table's 21:30–24:00 stays off
  assert.ok(all(cells(result, '2026-11-09', 'GPV1.1', 36, 43), 'possible'), '18:00–21:30 is possible');
  assert.ok(all(cells(result, '2026-11-09', 'GPV1.1', 43, 48), 'off'));
  assert.ok(all(cells(result, '2026-11-09', 'GPV1.1', 15, 29), 'off'), '07:30–14:30 stays');
  assert.ok(Date.parse(result.update) >= Date.parse('2026-11-09T20:20:00Z'), 'the table is stamped with the last change');
});

test('3 November: rows restate the plan for their period, so a block the operator moved is not on the screen twice', () => {
  const result = scheduleOf(EVERYTHING, { since: FROM });
  // #4311 (12:50, 15:00–22:00): 1.1 15:00–22:00; #4312 (16:38, 18:30–24:00) lists only 3.1, 3.2, 4.2 — 1.1 is on again from 18:30
  assert.ok(all(cells(result, '2026-11-03', 'GPV1.1', 30, 37), 'off'), '1.1 is off 15:00–18:30');
  assert.ok(all(cells(result, '2026-11-03', 'GPV1.1', 37, 48), 'on'), 'and on from 18:30: only 3.1, 3.2, 4.2 are off then');
  assert.ok(all(cells(result, '2026-11-03', 'GPV3.1', 37, 48), 'off'), '3.1 is off 18:30–24:00');
  // before a post's period, what was there stays: 08:00–11:30 of 1.1 (#4310's 08:00–22:00) is not touched by #4311's 15:00–22:00
  assert.ok(all(cells(result, '2026-11-03', 'GPV1.1', 16, 23), 'off'), '08:00–11:30 stays');
  // and a rows post replaces the queues it does not list: 3.1 was not in #4307, and is on in the morning
  assert.ok(all(cells(result, '2026-11-03', 'GPV3.1', 16, 30), 'on'));
});

test('a window that ends at 00:00 ends the day: «Черга 1.1 21:30-00:00»', () => {
  const result = scheduleOf(EVERYTHING, { since: FROM });
  assert.ok(all(cells(result, '2026-10-26', 'GPV1.1', 43, 48), 'off'));
  assert.ok(all(cells(result, '2026-10-26', 'GPV1.1', 0, 43), 'on'));
});

test('a change to a day whose table has not been read changes nothing', () => {
  const change = POSTS.find((post) => post.id === 4352);
  assert.deepEqual(Object.keys(scheduleOf([change], { since: FROM }).fact), []);
});

test('applying the changes does not touch the days it is given', () => {
  const base = { [day('2026-11-09')]: { 'GPV1.1': Array(48).fill('on') } };
  const amendment = { id: 1, at: 1, epoch: day('2026-11-09'), delta: [{ key: 'GPV1.1', from: 0, to: 4, state: 'off' }] };
  const made = applyAmendments(base, [amendment]);
  assert.ok(all(made[day('2026-11-09')]['GPV1.1'].slice(0, 4), 'off'));
  assert.ok(all(base[day('2026-11-09')]['GPV1.1'], 'on'));
});
