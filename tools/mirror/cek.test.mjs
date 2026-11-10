import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, snapshotFrom } from './sources/cek.mjs';
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
