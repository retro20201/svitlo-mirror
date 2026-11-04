import test from 'node:test';
import assert from 'node:assert/strict';
import { readEmergency } from './lib/dtek-emergency.mjs';
import { withChannelEmergency } from './sources/dtek.mjs';
import { kyivDayStart, buildSnapshot, queueNames } from './lib/canonical.mjs';
import { REGIONS } from './regions.mjs';
import { withHeldEmergency } from './sources/zhytomyr.mjs';

// @ztoe_ua and @kharkivenergy, 2–3 November 2026, in the operators' words.
const post = (id, postedAt, text) => ({ id, postedAt, text });
const at = (iso) => new Date(iso);
const own = (posts, now) => readEmergency(posts, { now: at(now), area: 'own' });

// The long explainer every channel carries says «аварійні відключення» from its 1200th character on.
const EXPLAINER = `💡У мене пропало світло поза графіком. Хто і коли його поверне?\n\n${'Коли вдома раптово зникає світло, найперше, що хочеться дізнатись - коли воно повернеться. '.repeat(14)}\n\nПід час аварійних відключень графіки не діють, а після їх скасування повертаємось до графіків.`;
const BRIEFING = `⚡️ Брифінг першого заступника Міністра енергетики України щодо оперативної ситуації в енергосистемі станом на 3 листопада\n\n${'➡️ Вночі та вранці росія здійснила масовану атаку на українську енергетику. '.repeat(12)}\n\nУ низці областей застосовано графіки аварійних відключень.`;

const ZHYTOMYR = [
  post(1861, '2026-11-02T05:32:37+00:00', '❗️ Увага! Аварійні відключення електроенергії\n🗓️ 2 листопада 2026\n\n📣 За розпорядженням Укренерго на Житомирщині запроваджено аварійні відключення електроенергії (ГАВ)\n\n📌З метою безпеки і захисту Ваших пристроїв вимкніть з розеток чутливе до стрибків напруги обладнання!'),
  post(1862, '2026-11-02T13:03:12+00:00', EXPLAINER),
  post(1869, '2026-11-02T13:12:06+00:00', '⚡️ Аварійні відключення на Житомирщині скасовано. Повертаємось до графіків. \n\n🔸Зверніть увагу! \nЗа вказівкою НЕК «Укренерго» маємо зміни у ГПВ.'),
  post(1871, '2026-11-03T08:04:47+00:00', BRIEFING),
  post(1872, '2026-11-03T08:53:02+00:00', '❗️ Увага! Аварійні відключення електроенергії\n🗓️ 3 листопада 2026\n\n📣 За розпорядженням Укренерго на Житомирщині запроваджено аварійні відключення електроенергії (ГАВ)\n\n📌З метою безпеки і захисту Ваших пристроїв вимкніть з розеток чутливе до стрибків напруги обладнання!')
];

test('Житомирщина: «запроваджено аварійні відключення (ГАВ)» starts, «скасовано. Повертаємось до графіків» ends', () => {
  assert.equal(own(ZHYTOMYR, '2026-11-02T10:00:00Z').active, true);
  assert.equal(own(ZHYTOMYR, '2026-11-02T13:05:00Z').active, true, 'the explainer ends nothing');
  assert.equal(own(ZHYTOMYR, '2026-11-02T13:30:00Z').active, false);
  const again = own(ZHYTOMYR, '2026-11-03T09:00:00Z');
  assert.equal(again.active, true);
  assert.equal(again.since, '2026-11-03T08:53:02+00:00');
});

test('an explainer or a briefing that mentions the outages far down is no announcement', () => {
  assert.equal(own([ZHYTOMYR[1]], '2026-11-02T13:05:00Z').active, false);
  assert.equal(own([ZHYTOMYR[3]], '2026-11-03T08:30:00Z').active, false);
  assert.equal(own(ZHYTOMYR.slice(0, 4), '2026-11-03T08:30:00Z').active, false, 'the day before is over, the briefing is nothing');
});

const KHARKIV = [
  post(2292, '2026-11-02T09:52:50+00:00', '‼️В Харківській області застосовуються аварійні відключення. \n\n⚠️Одночасно діють графіки погодинних відключень.'),
  post(2293, '2026-11-02T13:23:43+00:00', EXPLAINER),
  post(2301, '2026-11-03T09:13:17+00:00', '‼️Увага! Аварійні відключення електроенергії на Харківщині\n\nУ Харківській області введено графіки аварійних відключень електроенергії у зв’язку з масштабною російською атакою на енергетичні об’єкти України.\n\n🙏Просимо мешканців із розумінням поставитися до вимушених обмежень.')
];

test('Харківщина: both of the operator\'s wordings are announcements, each believed for twelve hours', () => {
  assert.equal(own(KHARKIV, '2026-11-02T10:30:00Z').active, true);
  assert.equal(own(KHARKIV, '2026-11-02T22:30:00Z').active, false, '12 h 38 min after, nothing to renew it');
  assert.equal(own(KHARKIV, '2026-11-03T09:30:00Z').active, true);
});

test('Житомир and Харків put today in fact.emergency and ask their own channel', async () => {
  const now = at('2026-11-03T09:30:00Z');
  const today = kyivDayStart(now);
  for (const [id, posts, channel] of [['zhytomyr', ZHYTOMYR, 'ztoe_ua'], ['kharkiv', KHARKIV, undefined]]) {
    const region = REGIONS.find((r) => r.id === id);
    assert.equal(region.emergencyTelegram.area, 'own');
    assert.equal(region.emergencyTelegram.channel, channel);
    let asked = null;
    const read = async (query) => { asked = query; return readEmergency(posts, { area: query.area, now: query.now }); };
    const snapshot = { regionId: id, fact: { data: { [today]: { 'GPV1.1': { 5: 'no' } } }, update: '03.11.2026 08:00' } };
    const result = await withChannelEmergency(structuredClone(snapshot), region, { read, now, log: () => {} });
    assert.equal(asked.channel, channel, id);
    assert.deepEqual(result.fact.emergency, [today], id);
    assert.deepEqual(result.fact.data, snapshot.fact.data, id);
  }
});

test('a channel that writes its own ends is believed for a day: the night after «знову запроваджено» is still an order', () => {
  const again = post(1873, '2026-11-03T12:50:38+00:00',
    '❗️ Увага!\n🗓️ 3 листопада 2026\n\n📣 За розпорядженням Укренерго на Житомирщині знову запроваджено аварійні відключення електроенергії (ГАВ)');
  const at = (iso, maxAgeMs) => readEmergency([again], { now: new Date(iso), area: 'own', maxAgeMs });
  assert.equal(at('2026-11-04T05:00:00Z').active, false, 'the default twelve hours: gone at 02:50');
  assert.equal(at('2026-11-04T05:00:00Z', 24 * 3600 * 1000).active, true);
  assert.equal(at('2026-11-04T12:50:00Z', 24 * 3600 * 1000).active, true);
  assert.equal(at('2026-11-04T12:51:00Z', 24 * 3600 * 1000).active, false, 'and not for ever');
  const ended = [again, post(1874, '2026-11-04T01:00:00+00:00', '⚡️ Аварійні відключення на Житомирщині скасовано. Повертаємось до графіків.')];
  assert.equal(readEmergency(ended, { now: new Date('2026-11-04T05:00:00Z'), area: 'own', maxAgeMs: 24 * 3600 * 1000 }).active, false, 'an end ends it');
});

test('the region says how long its channel is believed, and the reading is asked that', async () => {
  const region = REGIONS.find((r) => r.id === 'zhytomyr');
  assert.equal(region.emergencyTelegram.maxAgeHours, 36);
  assert.equal(REGIONS.find((r) => r.id === 'kharkiv').emergencyTelegram.maxAgeHours, undefined, 'a channel that writes no ends keeps the twelve');
  assert.equal(REGIONS.find((r) => r.id === 'cherkasy').emergencyTelegram.maxAgeHours, undefined);
  for (const id of ['kyiv', 'kyiv-region', 'dnipro']) {
    assert.equal(REGIONS.find((r) => r.id === id).emergencyTelegram.maxAgeHours, 36, `${id}: ДТЕК writes its ends`);
  }
  let asked = null;
  const now = new Date('2026-11-04T05:00:00Z');
  const snapshot = { regionId: 'zhytomyr', fact: { data: { [kyivDayStart(now)]: {} }, update: '02:30 04.11.2026' } };
  await withChannelEmergency(snapshot, region, { read: async (query) => { asked = query; return { active: false }; }, now, log: () => {} });
  assert.equal(asked.maxAgeMs, 36 * 3600 * 1000);
});

test('Житомирщина, 3 November: a post edited with «UPD: … скасовано» is over, and «знову запроваджено» starts it again', () => {
  const edited = post(1872, '2026-11-03T08:53:02+00:00',
    'UPD: Аварійні відключення на Житомирщині скасовано\n\n❗️ Увага! Аварійні відключення електроенергії\n🗓️ 3 листопада 2026\n\n📣 За розпорядженням Укренерго на Житомирщині запроваджено аварійні відключення електроенергії (ГАВ)');
  const again = post(1873, '2026-11-03T12:50:38+00:00',
    '❗️ Увага!\n🗓️ 3 листопада 2026\n\n📣 За розпорядженням Укренерго на Житомирщині знову запроваджено аварійні відключення електроенергії (ГАВ)\n\n📌З метою безпеки і захисту Ваших пристроїв вимкніть з розеток чутливе до стрибків напруги обладнання!');
  assert.equal(own([edited], '2026-11-03T10:00:00Z').active, false, 'the announcement the same post took back');
  assert.equal(own([edited, again], '2026-11-03T12:00:00Z').active, false, 'before the second');
  const second = own([edited, again], '2026-11-03T13:58:00Z');
  assert.equal(second.active, true);
  assert.equal(second.since, '2026-11-03T12:50:38+00:00');
});

test('Житомир with its site down: what the channel says is still published, over the table phones have', async () => {
  const now = new Date('2026-11-04T05:00:00Z');
  const today = kyivDayStart(now);
  const region = { ...REGIONS.find((r) => r.id === 'zhytomyr') };
  const hours = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i + 1, i + 1 === 5 ? 'no' : 'yes']));
  const table = { 'GPV2.2': hours };
  region.previous = buildSnapshot({
    regionId: 'zhytomyr', title: 'Житомирська область', queues: queueNames(['2.2']), fact: { [today]: table },
    todayEpoch: today, update: '02:30 04.11.2026', source: 'zhytomyr'
  });
  const down = () => Object.assign(new Error('timeout'), {});
  const read = async () => ({ active: true, since: '2026-11-03T12:50:38+00:00', note: null });

  const error = await withHeldEmergency(down(), region, { read, now, log: () => {} });
  assert.deepEqual(error.fallback.fact.emergency, [today]);
  assert.deepEqual(error.fallback.fact.data[today], table, 'the table is the one phones have');
  assert.equal(region.previous.fact.emergency, undefined, 'the copy the mirror holds is not changed in place');

  const bare = await withHeldEmergency(down(), { ...region, previous: null }, { read, now, log: () => {} });
  assert.equal(bare.fallback, undefined, 'nothing to carry, nothing to publish');
  const silent = await withHeldEmergency(down(), region, { read: async () => { throw new Error('t.me: 502'); }, now, log: () => {} });
  assert.equal(silent.fallback?.fact.emergency, undefined, 'the channel is silent too: nothing is claimed');
});

test('the order of 3 November 05:18 UTC is still an order at 23:07, when nobody has ended it (Київщина, 6.2)', () => {
  const order = { id: 4750, postedAt: '2026-11-03T05:18:25+00:00',
    text: '‼️Київ, Київська та Дніпропетровська область: за командою Укренерго запроваджені екстрені відключення\n\nНагадаємо, під час екстрених відключень графіки не діють.' };
  const evening = new Date('2026-11-03T21:07:00Z');
  for (const area of ['oblast', 'city', 'dnipro']) {
    assert.equal(readEmergency([order], { now: evening, area }).active, false, `${area}: the twelve hours had run out`);
    assert.equal(readEmergency([order], { now: evening, area, maxAgeMs: 36 * 3600 * 1000 }).active, true, area);
  }
  const ended = { id: 4770, postedAt: '2026-11-03T21:30:00+00:00', text: '💡Київщина: повертаємось до графіків відключень' };
  assert.equal(readEmergency([order, ended], { now: new Date('2026-11-03T22:00:00Z'), area: 'oblast', maxAgeMs: 36 * 3600 * 1000 }).active, false);
  assert.equal(readEmergency([order], { now: new Date('2026-11-04T17:30:00Z'), area: 'oblast', maxAgeMs: 36 * 3600 * 1000 }).active, false, 'a day and a half, not for ever');
});
