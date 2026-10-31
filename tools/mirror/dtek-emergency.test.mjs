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

test('«діють екстрені відключення» after an attack is an order too, with its districts', () => {
  const posts = [post(82, '2026-10-30T09:29:00Z', '💡Київщина: 170 000 родин знову зі світлом після масованої атаки\n\nЧерез пошкодження на магістральних мережах в частині Бучанського і Фастівського районах області діють екстрені відключення.\n\nЕнергетики працюють в посиленому режимі.')];
  const now = readEmergency(posts, { now: at('2026-10-30T10:00:00Z') });
  assert.equal(now.active, true);
  const ended = [...posts, post(83, '2026-10-30T14:00:00Z', '💡Київщина: повертаємось до графіків відключень')];
  assert.equal(readEmergency(ended, { now: at('2026-10-30T15:00:00Z') }).active, false);
});

test('a morning of schedules and a war memorial are not orders (26 October 2026)', () => {
  const posts = [
    post(4690, '2026-10-26T05:32:00Z', '‼️Дніпропетровщина: графіки відключень на 26 жовтня'),
    post(4694, '2026-10-26T18:27:00Z', '🕯️Ще одна непоправна втрата в родині ДТЕК — росія вбила нашого колегу'),
    post(4695, '2026-10-26T18:43:00Z', '‼️Київщина: графіки відключень на 27 жовтня\n\n▪️У разі змін одразу повідомимо в нашому Telegram-каналі.')
  ];
  assert.equal(readEmergency(posts, { now: at('2026-10-26T08:12:00Z') }).active, false);
  assert.equal(readEmergency(posts, { now: at('2026-10-26T19:00:00Z') }).active, false);
});

// The posts of @dtek_ua of 14 – 30 October 2026, as the channel wrote them — the announcements that are not «екстрені
// відключення за командою Укренерго» and the ones that were passed. A person in Київська область wrote on 30 October at
// 14:44 that there had been no power all day; the channel had said at 09:26 that schedules did not hold in three of its
// districts, and the app had no warning.
const ACCIDENTS = {
  oblastDistricts: post(4718, '2026-10-30T07:26:39+00:00',
    'Київщина: аварія на пошкодженому обстрілами обладнані, графіки тимчасово не діють в Обухівському, Фастівському та Бучанському районах\n\nЕнергетики працюють на місцях. ▪️В разі змін будемо вас інформувати.'),
  rightBank: post(4717, '2026-10-30T07:05:42+00:00',
    '‼️Правий берег Києва: аварія на пошкодженому обстрілами обладнані, графіки тимчасово не діють\n\nЕнергетики працюють на місцях. На лівому березі столиці діють графіки.'),
  cityDistrict: post(4658, '2026-10-21T05:42:00+00:00',
    '‼️Київ: через атаку ворога у Святошинському районі фіксуються аварійні відключення\n\nЕнергетики вже працюють. В інших районах столиці діють графіки.'),
  blackout: post(4619, '2026-10-14T10:12:39+00:00',
    '‼️Правий берег Києва: частина домівок залишилась без світла через аварію\n\nГрафіки відключень в столиці наразі не діють. Енергетики вже працюють.'),
  stabilisation: post(4618, '2026-10-14T04:23:48+00:00',
    '‼️Київ: атака ворога призвела до аварійних відключень в Дарницькому, Дніпровському та Печерському районах столиці\n\nСтабілізаційні графіки в цих районах тимчасово не діють.'),
  back: post(4670, '2026-10-22T12:02:23+00:00',
    '‼️Київ: 35 500 родин знову зі світлом після обстрілів\n\nЕнергетикам вдалося повернути електрику для мешканців Голосіївського району після аварії, яка відбулась через обстріли. По всій столиці діють графіки відключень.'),
  holosiivo: post(4668, '2026-10-22T09:23:40+00:00',
    '‼️Київ: через атаку на енергооб\'єкти в частині Голосіївського району графіки тимчасово не діють. Фіксуються аварії.\n\nЕнергетики вже працюють.'),
  applying: post(4637, '2026-10-16T08:42:22+00:00',
    '‼️Київська область: в Бучанському, Обухівському, Фастівському районах за командою Укренерго застосовуються екстрені відключення\n\nНагадаємо, під час екстрених відключень графіки не діють.'),
  buchaOnly: post(4648, '2026-10-18T07:35:06+00:00',
    '‼️Київщина, Бучанський район: за розпорядженням Укренерго застосовуються екстрені відключення.\n\nНагадаємо, під час екстрених відключень графіки не діють.'),
  dnipro: post(4716, '2026-10-30T05:38:02+00:00',
    '‼️Дніпропетровщина: за командою Укренерго застосовані екстрені відключення в місті Дніпрі, прилеглих до обласного центру районах та в частині Павлоградського району\n\nВ області серйозно пошкоджено обладнання.'),
  dniproCity: post(4721, '2026-10-30T16:05:15+00:00',
    '‼️Дніпро та Дніпропетровський район: за командою Укренерго застосовані екстрені відключення\n\nЕнергетики працюють другу добу. Нагадаємо, під час екстрених відключень графіки не діють.')
};

test('«аварія … графіки тимчасово не діють» is an announcement for the oblast, with the districts it names', () => {
  const during = readEmergency([ACCIDENTS.oblastDistricts], { now: at('2026-10-30T11:44:00Z') });
  assert.equal(during.active, true, 'the letter was written at 14:44 Kyiv time');
  assert.equal(during.since, '2026-10-30T07:26:39+00:00');
  assert.equal(during.note, 'в Обухівському, Фастівському та Бучанському районах');
  assert.equal(readEmergency([ACCIDENTS.oblastDistricts], { now: at('2026-10-30T11:44:00Z'), area: 'city' }).active, false);
});

test('«Правий берег Києва» is Київ, and «наразі не діють» and «тимчасово не діють» both count', () => {
  for (const key of ['rightBank', 'blackout', 'holosiivo', 'stabilisation']) {
    const reading = readEmergency([ACCIDENTS[key]], { now: new Date(Date.parse(ACCIDENTS[key].postedAt) + 3600 * 1000), area: 'city' });
    assert.equal(reading.active, true, key);
    assert.equal(readEmergency([ACCIDENTS[key]], { now: new Date(Date.parse(ACCIDENTS[key].postedAt) + 3600 * 1000) }).active, false, `${key}: not for the oblast`);
  }
});

test('the districts of an accident are told whether they come before the announcement or after it', () => {
  const note = (key, area) => readEmergency([ACCIDENTS[key]], { now: new Date(Date.parse(ACCIDENTS[key].postedAt) + 3600 * 1000), area }).note;
  assert.equal(note('cityDistrict', 'city'), 'у Святошинському районі');
  assert.equal(note('holosiivo', 'city'), 'в частині Голосіївського району');
  assert.equal(note('rightBank', 'city'), null, 'a bank of the river is not a district');
});

test('«знову зі світлом» ends an accident, but not an order that the same post still announces', () => {
  const accident = ACCIDENTS.holosiivo;
  const after = readEmergency([accident, ACCIDENTS.back], { now: at('2026-10-22T12:30:00Z'), area: 'city' });
  assert.equal(after.active, false);
  const both = post(7, '2026-10-22T13:00:00+00:00',
    '💡Київщина: 170 000 родин знову зі світлом після масованої атаки\n\nЧерез пошкодження на магістральних мережах в частині Бучанського і Фастівського районів діють екстрені відключення.');
  assert.equal(readEmergency([both], { now: at('2026-10-22T13:30:00Z') }).active, true);
});

test('«застосовуються екстрені відключення» is an order, as «застосовані» is', () => {
  assert.equal(readEmergency([ACCIDENTS.applying], { now: at('2026-10-16T09:00:00Z') }).active, true);
  assert.equal(readEmergency([ACCIDENTS.applying], { now: at('2026-10-16T09:00:00Z') }).note, 'в Бучанському, Обухівському, Фастівському районах');
  assert.equal(readEmergency([ACCIDENTS.buchaOnly], { now: at('2026-10-18T08:00:00Z') }).active, true);
});

test('the reminder under an order, and a daily schedule post that repeats it, are still no announcement', () => {
  const daily = post(5, '2026-10-30T08:00:00Z', '‼️Київщина: графіки відключень на 31 жовтня\n\nУ разі змін повідомимо. Нагадаємо, під час екстрених відключень графіки не діють.');
  assert.equal(readEmergency([daily], { now: at('2026-10-30T09:00:00Z') }).active, false);
  const explainer = post(6, '2026-10-30T08:10:00Z', 'Аварії, стабілізаційні та екстрені відключення: у чому різниця?\n\nПояснюємо простими словами');
  assert.equal(readEmergency([explainer], { now: at('2026-10-30T09:00:00Z'), area: 'city' }).active, false);
});

test('Дніпро and its oblast are read for area «dnipro», and not for Київ or Київщина', () => {
  for (const key of ['dnipro', 'dniproCity']) {
    const reading = readEmergency([ACCIDENTS[key]], { now: new Date(Date.parse(ACCIDENTS[key].postedAt) + 3600 * 1000), area: 'dnipro' });
    assert.equal(reading.active, true, key);
    assert.equal(readEmergency([ACCIDENTS[key]], { now: new Date(Date.parse(ACCIDENTS[key].postedAt) + 3600 * 1000) }).active, false, `${key}: not Київщина`);
  }
  assert.equal(readEmergency([ACCIDENTS.dnipro], { now: at('2026-10-30T06:30:00Z'), area: 'dnipro' }).note,
    'в місті Дніпрі, прилеглих до обласного центру районах');
});

// An accident after an attack can last the night and the morning with no post to end it: on 31 October 2026 a person in
// Київ wrote at 09:48 that the power was off, eleven hours after «Графіки відключень в цих районах наразі не діють».
test('an accident nobody followed is believed for twelve hours, as an order is, and a later post renews it', () => {
  const accident = post(4724, '2026-10-30T20:39:53+00:00',
    '‼️Київ: ворог атакував обʼєкт енергетики, частина Оболонського, Дарницького, Деснянського та Подільського районів без світла\n\nГрафіки відключень в цих районах наразі не діють.');
  const from = Date.parse(accident.postedAt);
  assert.equal(readEmergency([accident], { now: new Date(from + 11 * 3600 * 1000), area: 'city' }).active, true, 'the letter, 07:48 UTC');
  assert.equal(readEmergency([accident], { now: new Date(from + MAX_AGE_MS + 60000), area: 'city' }).active, false);
  const renewed = [accident, post(8, '2026-10-31T06:00:00+00:00', 'Київ: аварія на обладнані, графіки наразі не діють у Подільському районі')];
  assert.equal(readEmergency(renewed, { now: new Date(from + MAX_AGE_MS + 3600 * 1000), area: 'city' }).active, true);
});
