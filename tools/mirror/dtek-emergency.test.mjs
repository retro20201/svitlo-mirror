import test from 'node:test';
import assert from 'node:assert/strict';
import { readEmergency, MAX_AGE_MS } from './lib/dtek-emergency.mjs';

// The posts of @dtek_ua of 22–25 October 2026, in the words the channel used (shortened after the first line).
const post = (id, postedAt, text) => ({ id, postedAt, text });
const POSTS = [
  post(4671, '2026-10-22T17:06:55+00:00', 'Аварії, стабілізаційні та екстрені відключення: у чому різниця?\n\nПояснюємо простими словами'),
  post(4677, '2026-10-23T07:45:31+00:00', '‼️Київ та Київська область: за командою Укренерго застосовані екстрені відключення\n\nНагадаємо, під час екстрених відключень графіки не діють.'),
  post(4678, '2026-10-23T10:47:00+00:00', '💡Київщина: повертаємось до графіків відключень\n\n▪️У разі змін одразу повідомимо в нашому Telegram-каналі.'),
  post(4684, '2026-10-24T07:31:23+00:00', '‼️Київ: за командою Укренерго запроваджено екстрені відключення в частині Голосієвського та Соломянського районів.\n\nНагадаємо, під час екстрених відключень графіки не діють.\n\nUPD: екстрені відключення скасовані'),
  post(4685, '2026-10-24T07:49:28+00:00', '‼️Київщина: за командою Укренерго застосовані екстрені відключення у Білоцерківському, Бучанському, Обухівському, Фастівському районах\n\nНагадаємо, під час екстрених відключень графіки не діють.'),
  post(4686, '2026-10-25T08:39:00+00:00', '‼️Київ: через аварію у частині Голосіївської, Соломянського і Шевченківського районів відсутнє електропостачання.')
];
const at = (iso) => new Date(iso);

test('an order for «Київ та Київська область» is on for the oblast until the return to the schedules', () => {
  const during = readEmergency(POSTS, { now: at('2026-10-23T09:00:00Z') });
  assert.equal(during.active, true);
  assert.equal(during.since, '2026-10-23T07:45:31+00:00');
  assert.equal(during.note, null, 'the whole oblast: no districts to name');
  assert.equal(readEmergency(POSTS, { now: at('2026-10-23T11:00:00Z') }).active, false, '«повертаємось до графіків»');
});

test('a post that lists districts keeps them in the words it wrote', () => {
  const during = readEmergency(POSTS.slice(0, 5), { now: at('2026-10-24T08:00:00Z') });
  assert.equal(during.active, true);
  assert.equal(during.note, 'у Білоцерківському, Бучанському, Обухівському, Фастівському районах');
});

test('a post edited with «UPD: … скасовані» is over', () => {
  assert.equal(readEmergency(POSTS, { now: at('2026-10-24T07:40:00Z'), area: 'city' }).active, false);
  assert.equal(readEmergency(POSTS.slice(0, 4), { now: at('2026-10-24T07:40:00Z'), area: 'city' }).active, false);
});

test('Київ and Київщина are told apart', () => {
  const justCity = [POSTS[3].text.replace('\n\nUPD: екстрені відключення скасовані', '')];
  const city = [post(1, '2026-10-24T07:31:23+00:00', justCity[0])];
  assert.equal(readEmergency(city, { now: at('2026-10-24T08:00:00Z'), area: 'city' }).active, true);
  assert.equal(readEmergency(city, { now: at('2026-10-24T08:00:00Z'), area: 'oblast' }).active, false);
  const both = [post(2, '2026-10-24T07:00:00Z', '‼️Київ та Київська область: за командою Укренерго застосовані екстрені відключення')];
  assert.equal(readEmergency(both, { now: at('2026-10-24T08:00:00Z'), area: 'city' }).active, true);
  assert.equal(readEmergency(both, { now: at('2026-10-24T08:00:00Z'), area: 'oblast' }).active, true);
});

test('an explainer, an accident and another region are not orders', () => {
  const others = [
    POSTS[0],
    POSTS[5],
    post(9, '2026-10-24T07:00:00Z', '‼️Одеса: за командою Укренерго застосовані екстрені відключення'),
    post(10, '2026-10-24T07:10:00Z', '‼️Київщина: графіки відключень на 25 жовтня\n\nУ разі змін повідомимо. Нагадаємо, під час екстрених відключень графіки не діють.')
  ];
  assert.equal(readEmergency(others, { now: at('2026-10-24T08:00:00Z') }).active, false);
  assert.equal(readEmergency(others, { now: at('2026-10-25T09:00:00Z'), area: 'city' }).active, false);
});

test('an announcement nobody ended is not believed after twelve hours, and the order of posts does not matter', () => {
  const lone = [post(1, '2026-10-24T07:00:00Z', '‼️Київщина: за командою Укренерго застосовані екстрені відключення')];
  assert.equal(readEmergency(lone, { now: new Date(Date.parse('2026-10-24T07:00:00Z') + MAX_AGE_MS - 60000) }).active, true);
  assert.equal(readEmergency(lone, { now: new Date(Date.parse('2026-10-24T07:00:00Z') + MAX_AGE_MS + 60000) }).active, false);
  const shuffled = [POSTS[2], POSTS[1]];
  assert.equal(readEmergency(shuffled, { now: at('2026-10-23T11:00:00Z') }).active, false);
  assert.equal(readEmergency(shuffled, { now: at('2026-10-23T09:00:00Z') }).active, true);
});

test('a second order after the return is a new one', () => {
  const posts = [POSTS[1], POSTS[2], post(11, '2026-10-23T14:00:00Z', '‼️Київщина: за командою Укренерго запроваджено екстрені відключення у Броварському районі')];
  const now = readEmergency(posts, { now: at('2026-10-23T14:30:00Z') });
  assert.equal(now.active, true);
  assert.equal(now.note, 'у Броварському районі');
});

test('an empty page, and a post with no time, say nothing', () => {
  assert.deepEqual(readEmergency([], { now: at('2026-10-24T08:00:00Z') }), { active: false, since: null, note: null });
  assert.equal(readEmergency([{ id: 1, postedAt: undefined, text: '‼️Київщина: застосовані екстрені відключення' }], { now: at('2026-10-24T08:00:00Z') }).active, false);
});
