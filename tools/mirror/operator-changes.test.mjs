import test from 'node:test';
import assert from 'node:assert/strict';
import { readPendingChange, withPendingChange, stampInstant, MAX_AGE_MS } from './lib/operator-changes.mjs';

// @ztoe_ua, 26 October 2026 (UTC; Kyiv is +2 from the 25th).
const CHANGE = (id, postedAt) => ({ id, postedAt, text: 'Зверніть увагу! \n\nЗміни у графіках погодинних відключень!\n📆 26  жовтня 2026\n\nЗа вказівкою НЕК «Укренерго» маємо зміни у ГПВ\n\n📊 Перевірте ваш графік:' });
const POSTS = [
  { id: 1843, postedAt: '2026-10-25T19:39:00+00:00', text: 'ІНФОРМАЦІЯ ПРО ВІДКЛЮЧЕННЯ 26 ЖОВТНЯ\n\n💡 У понеділок, 26 жовтня, згідно з розпорядженням НЕК «Укренерго»…' },
  CHANGE(1847, '2026-10-26T06:30:00+00:00'),
  CHANGE(1848, '2026-10-26T18:50:00+00:00'),
  { id: 1849, postedAt: '2026-10-26T19:41:44+00:00', text: 'ІНФОРМАЦІЯ ПРО ВІДКЛЮЧЕННЯ 27 ЖОВТНЯ' }
];
const at = (iso) => new Date(iso);

test('the operator\'s stamps, in either order, are Kyiv wall-clock instants', () => {
  assert.equal(new Date(stampInstant('22:30 26.10.2026')).toISOString(), '2026-10-26T20:30:00.000Z');
  assert.equal(new Date(stampInstant('26.10.2026 22:30')).toISOString(), '2026-10-26T20:30:00.000Z');
  assert.equal(new Date(stampInstant('09:00 26.10.2026')).toISOString(), '2026-10-26T07:00:00.000Z');
  assert.equal(new Date(stampInstant('12:00 20.10.2026')).toISOString(), '2026-10-20T09:00:00.000Z', 'summer time before 25 October');
  assert.ok(Number.isNaN(stampInstant(null)));
  assert.ok(Number.isNaN(stampInstant('вчора')));
});

test('an announcement the table has not answered is pending, and the table\'s stamp ends it', () => {
  // 20:50 local = 18:50Z. The table of the evening: 15:00 → pending; 21:30 → answered.
  const pending = readPendingChange(POSTS, { update: '15:00 26.10.2026', now: at('2026-10-26T18:59:00Z') });
  assert.deepEqual(pending, { at: Date.parse('2026-10-26T18:50:00Z') / 1000 });
  assert.equal(readPendingChange(POSTS, { update: '21:30 26.10.2026', now: at('2026-10-26T19:35:00Z') }), null);
  assert.equal(readPendingChange(POSTS, { update: '20:50 26.10.2026', now: at('2026-10-26T19:00:00Z') }), null, 'a stamp equal to the post has taken it in');
});

test('the morning change is answered by the 09:00 table, and nothing else is a change', () => {
  assert.equal(readPendingChange(POSTS.slice(0, 2), { update: '09:00 26.10.2026', now: at('2026-10-26T08:00:00Z') }), null);
  const pending = readPendingChange(POSTS.slice(0, 2), { update: '15:00 25.10.2026', now: at('2026-10-26T06:40:00Z') });
  assert.equal(pending.at, Date.parse('2026-10-26T06:30:00Z') / 1000);
  assert.equal(readPendingChange([POSTS[0], POSTS[3]], { update: '15:00 26.10.2026', now: at('2026-10-26T12:00:00Z') }), null);
});

test('an announcement the table never answered is not believed after twelve hours', () => {
  const lone = [CHANGE(1, '2026-10-26T06:30:00Z')];
  const stale = { update: '09:00 25.10.2026' };
  assert.ok(readPendingChange(lone, { ...stale, now: new Date(Date.parse('2026-10-26T06:30:00Z') + MAX_AGE_MS - 60000) }));
  assert.equal(readPendingChange(lone, { ...stale, now: new Date(Date.parse('2026-10-26T06:30:00Z') + MAX_AGE_MS + 60000) }), null);
});

const region = (previous) => ({ id: 'zhytomyr', changesTelegram: { channel: 'ztoe_ua' }, previous });
const snapshot = (update) => ({ regionId: 'zhytomyr', fact: { data: {}, update, today: 1 } });
const quiet = () => {};

test('withPendingChange sets fact.pendingChange while the table is behind, and leaves the rest alone', async () => {
  const read = async (channel) => { assert.equal(channel, 'ztoe_ua'); return POSTS; };
  const behind = await withPendingChange(snapshot('15:00 26.10.2026'), region(), { read, now: at('2026-10-26T19:00:00Z'), log: quiet });
  assert.deepEqual(behind.fact.pendingChange, { at: Date.parse('2026-10-26T18:50:00Z') / 1000 });
  assert.equal(behind.fact.update, '15:00 26.10.2026');
  const caught = await withPendingChange(snapshot('21:30 26.10.2026'), region(), { read, now: at('2026-10-26T19:35:00Z'), log: quiet });
  assert.equal('pendingChange' in caught.fact, false, 'a snapshot with nothing pending keeps the shape it always had');
});

test('a channel that does not answer keeps what phones have until the table passes it', async () => {
  const read = async () => { throw new Error('t.me: 502'); };
  const held = { at: Date.parse('2026-10-26T18:50:00Z') / 1000 };
  const previous = { fact: { pendingChange: held } };
  const still = await withPendingChange(snapshot('15:00 26.10.2026'), region(previous), { read, now: at('2026-10-26T19:10:00Z'), log: quiet });
  assert.deepEqual(still.fact.pendingChange, held);
  const answered = await withPendingChange(snapshot('21:30 26.10.2026'), region(previous), { read, now: at('2026-10-26T19:40:00Z'), log: quiet });
  assert.equal('pendingChange' in answered.fact, false);
  const nothing = await withPendingChange(snapshot('15:00 26.10.2026'), region({ fact: {} }), { read, now: at('2026-10-26T19:10:00Z'), log: quiet });
  assert.equal('pendingChange' in nothing.fact, false);
});

test('only Житомир has the channel configured', async () => {
  const { REGIONS } = await import('./regions.mjs');
  assert.deepEqual(REGIONS.filter((candidate) => candidate.changesTelegram).map((candidate) => candidate.id), ['zhytomyr']);
});
