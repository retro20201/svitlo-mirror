import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayOf, factOf, fetchRegion, pageURL, parseAnnouncement } from './sources/uz.mjs';
import { REGIONS, hasEmergencySignal } from './regions.mjs';
import { hasSchedule, kyivDayStart, statusFor, validate } from './lib/canonical.mjs';

// The announcements of eight oblast pages of АТ «Укрзалізниця» as served on 28 November 2026, from the heading to the list of addresses.
const PAGES = JSON.parse(readFileSync(new URL('./uz.fixture-2026-11-28.json', import.meta.url), 'utf8'));
const NOV_28 = new Date('2026-11-28T09:30:00Z');
const MARK = { yes: '.', no: 'X', first: '<', second: '>' };
const row = (fact, day, queue) => Array.from({ length: 24 }, (_, hour) => MARK[fact.data[day][`GPV${queue}`][hour + 1]]).join('');
const read = (name, now = NOV_28) => factOf(parseAnnouncement(PAGES[name]), now);

/** A page of the same make, for what the eight do not show. */
const page = (...parts) => `<p><strong>Інформація про графіки погодинних відключень електроенергії споживачам, які приєднані до мереж системи розподілу АТ "Укрзалізниця"</strong></p>${parts.join('')}<p>Перелік адрес, що знеструмлюються</p>`;
const table = (hours, queues) => `<table><tbody><tr><td><p>Години відключення</p></td>${hours.map((cell) => `<td>${cell.split(' ').map((time) => `<p>${time}</p>`).join('')}</td>`).join('')}</tr>` +
  `<tr><td><p>№ черги ГПВ (підчерги)</p></td>${queues.map((cell) => `<td><p>${cell}</p></td>`).join('')}</tr></tbody></table>`;

test('Київщина: the day and the queues under each interval, half-hours kept', () => {
  const fact = read('kyiv-region');
  const day = kyivDayStart(NOV_28);

  assert.deepEqual(Object.keys(fact.data), [String(day)]);
  assert.equal(Object.keys(fact.data[day]).length, 12);
  // «06-00 08-00: 3(1) 4(1,2)», «08-00 11-30: 4(2) 5(1,2) 6(1,2)», «15-00 16-00: … 4(1,2) …», «16-00 18-30: … 4(1,2)».
  assert.equal(row(fact, day, '4.2'), '......XXXXX<...XXX<.....');
  assert.equal(row(fact, day, '3.1'), '......XX........XXXXXX..');
  assert.equal(row(fact, day, '1.1'), '...........>XXX.XX<.....');
  assert.equal(fact.emergency, undefined);
});

test('yesterday\'s table left on the page is not today\'s, and on its own day it is read', () => {
  const today = read('rivne');
  assert.deepEqual(Object.keys(today.data), [String(kyivDayStart(NOV_28))]);
  assert.equal(row(today, kyivDayStart(NOV_28), '1.1'), '........XXX<............');

  const yesterday = new Date('2026-11-27T09:30:00Z');
  const both = read('rivne', yesterday);
  assert.deepEqual(Object.keys(both.data), [String(kyivDayStart(yesterday)), String(kyivDayStart(NOV_28))]);
  assert.equal(row(both, kyivDayStart(yesterday), '6.1'), '.................XXXX<..');
});

test('two railways in one oblast have a table each: refused, since the addresses do not say which', () => {
  assert.throws(() => read('vinnytsia'), /two tables for one day \(«Південно-Західна залізниця» and «Одеська залізниця»\)/u);
});

test('a word that is not known refuses the page: «Відміна ГПВ» under a table', () => {
  assert.throws(() => read('cherkasy'), /words not understood: «Відміна ГПВ»/u);
  assert.throws(() => factOf(parseAnnouncement(page('<p>28 листопада</p>', table(['08-00 10-00'], ['1(1,2)']), '<p>Графік може бути скасовано</p>')), NOV_28), /words not understood/u);
});

test('an order in place of a table: «Аварійні відключення» today, for three days after its date', () => {
  const fact = read('dnipropetrovsk');
  assert.deepEqual(fact.data, {});
  assert.deepEqual(fact.emergency, [kyivDayStart(NOV_28)]);
  assert.equal(fact.emergencyNote, 'за повідомленням Укрзалізниці від 26 листопада, в області застосовано аварійні відключення');

  const later = read('dnipropetrovsk', new Date('2026-12-02T09:30:00Z'));
  assert.equal(later.emergency, undefined, 'a notice nobody took down is not believed for ever');

  // A table under the order is the page's last word.
  const answered = factOf(parseAnnouncement(page(
    '<p>27 листопада В Київській області застосовані аварійні відключення електроенергії. Стежте за повідомленнями.</p>',
    '<p>28 листопада</p>', table(['08-00 10-00'], ['1(1,2)'])
  )), NOV_28);
  assert.equal(answered.emergency, undefined);
  assert.equal(row(answered, kyivDayStart(NOV_28), '1.2'), '........XX..............');
});

test('minutes that are no half-hour darken the half-hours they touch; intervals may overlap', () => {
  const odesa = read('odesa');
  const day = kyivDayStart(NOV_28);
  // «06-00 08-00: 5(2) 2(1,2)» and «07:10 08:00: 6(1,2)»: 6.1 from 07:00.
  assert.equal(row(odesa, day, '2.1'), '......XX................');
  assert.equal(row(odesa, day, '6.1'), '.......X.....XXX........');

  const fact = factOf(parseAnnouncement(page('<p>28 листопада</p>', table(['00-00 00-12', '14-00 15-20', '15:20 18.00'], ['5(1)', '4(1)', '3(2)']))), NOV_28);
  assert.equal(row(fact, day, '5.1'), '<.......................');
  assert.equal(row(fact, day, '4.1'), '..............X<........');
  assert.equal(row(fact, day, '3.2'), '...............XXX......');
});

test('«-» is nobody, «5(1.2)» is both halves, and a queue the table never names has light all day', () => {
  const day = kyivDayStart(NOV_28);
  const mykolaiv = read('mykolaiv');
  assert.equal(row(mykolaiv, day, '1.1'), '.'.repeat(24));
  assert.equal(row(mykolaiv, day, '2.1'), '......<.................');
  const chernihiv = read('chernihiv');
  assert.equal(row(chernihiv, day, '5.1'), row(chernihiv, day, '5.2'));
  assert.equal(row(chernihiv, day, '5.1'), '........>XXX.......XXX<.');
});

test('what is not a table of hours over queues is refused, not guessed', () => {
  const broken = (hours, queues) => () => factOf(parseAnnouncement(page('<p>28 листопада</p>', table(hours, queues))), NOV_28);
  assert.throws(broken(['08-00 10-00'], ['1(1,2) та 3']), /is not a list of queues/u);
  assert.throws(broken(['08-00 10-00'], ['7(1)']), /is not a list of queues/u);
  assert.throws(broken(['10-00 08-00'], ['1(1)']), /ends before it starts/u);
  assert.throws(broken(['08-00 25-00'], ['1(1)']), /is not a time of day/u);
  assert.throws(broken(['08-00'], ['1(1)']), /is not a start and an end/u);
  assert.throws(() => parseAnnouncement(page(table(['08-00 10-00'], ['1(1)']))), /a table with no date above it/u);
  assert.throws(() => parseAnnouncement('<p>Сторінку не знайдено</p>'), /no announcement/u);
  // Nothing announced at all (Донецька область that day): a page read, with no day on it.
  assert.deepEqual(factOf(parseAnnouncement(page()), NOV_28), { data: {} });
});

test('a date carries no year: it is the one nearest to now', () => {
  assert.equal(dayOf({ day: 2, month: 1 }, new Date('2026-12-30T10:00:00Z')), kyivDayStart(new Date('2027-01-02T10:00:00Z')));
  assert.equal(dayOf({ day: 31, month: 12 }, new Date('2027-01-01T10:00:00Z')), kyivDayStart(new Date('2026-12-31T10:00:00Z')));
  assert.equal(dayOf({ day: 28, month: 11 }, NOV_28), kyivDayStart(NOV_28));
});

test('the trial region: its page is asked once and comes out as a snapshot the app can show', async (t) => {
  const region = REGIONS.find((r) => r.id === 'uz-kyiv-region');
  assert.equal(region.source, 'uz');
  assert.equal(region.site, pageURL(region.uz.page));
  assert.ok(region.minIntervalMinutes >= 10, 'not every cycle');
  assert.equal(hasEmergencySignal(region), true);

  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => { asked.push(String(url)); return new Response(PAGES['kyiv-region'], { status: 200 }); });
  const snapshot = await fetchRegion({ ...region, previous: null }, { now: NOV_28 });

  assert.deepEqual(asked, [pageURL(622296)]);
  assert.deepEqual(validate(snapshot), []);
  assert.equal(Object.keys(snapshot.preset.sch_names).length, 12);
  assert.equal(snapshot.fact.data[kyivDayStart(NOV_28)]['GPV4.2']['12'], 'first');
  assert.equal(hasSchedule(snapshot), true);
  assert.equal(statusFor(region, snapshot), 'live');
});
