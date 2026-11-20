import test from 'node:test';
import assert from 'node:assert/strict';
import { readBanner } from './lib/dtek-emergency.mjs';
import { withSiteBanner } from './sources/dtek.mjs';
import { kyivDayStart } from './lib/canonical.mjs';
import { markCarried, carriedParts } from './lib/carried.mjs';

// The banners as outage-data-ua carried them on the morning of 20 November 2026.
const DNIPRO = 'За наказом НЕК Укренерго в м. Дніпро, Кам\'янське, Самар, Павлоград, Дніпровський, Самарівський, Павлоградський, Солонянський, Царичанський р-ни діють екстрені відключення.\nДля решти області  стабілізаційні відключення.';
const DNIPRO_ORDER = 'За наказом НЕК Укренерго в м. Дніпро, Кам\'янське, Самар, Павлоград, Дніпровський, Самарівський, Павлоградський, Солонянський, Царичанський р-ни діють екстрені відключення.';
const KYIV = 'Через масовану атаку без світла залишилася частина мешканців Печерського, Солом’янського, Голосіївського, Дніпровського та Дарницького районів.\nВ інших районах столиці діють екстрені відключення через пошкодження обладнання та перевантаження мереж.';
const KYIV_REGION = 'За наказом НЕК Укренерго 20.11 з 06:00 до 23:59 діють стабілізаційні відключення електроенергії.\nЧерез аварію в мережі знеструмлено частково Білоцерківський район. Тут графіки не діють.\nБудь ласка, розумно споживайте електроенергію — це допоможе зменшити навантаження на мережу та уникнути екстрених відключень.';
const ODESA = '​За наказом НЕК Укренерго сьогодні з 07:30 до 24:00 діють стабілізаційні відключення електроенергії.\nЧерез аварію в мережі знеструмлені частково Одеський та Роздільнянський райони. Тут графіки не діють.';

const NOW = new Date('2026-11-20T08:30:00Z');
const TODAY = kyivDayStart(NOW);
const TOMORROW = TODAY + 86400;
const quiet = () => {};
const snapshot = (text, fact = {}) => ({
  regionId: 'dnipro',
  fact: { data: { [TODAY]: { 'GPV1.1': {} } }, update: '20.11.2026 07:52', ...fact },
  ...(text === undefined ? {} : { attention: { text } })
});

const DNIPRO_WHOLE = DNIPRO_ORDER + ' Для решти області стабілізаційні відключення.';

test('the banner that says an order is in force is read in the operator\'s own words, whole while it is short', () => {
  assert.equal(readBanner(DNIPRO), DNIPRO_WHOLE, 'the rest of the oblast reads what is said of it');
  assert.equal(readBanner(DNIPRO_ORDER), DNIPRO_ORDER, 'as it stood on the evening of the 19th, before the second sentence');
  assert.equal(readBanner(KYIV), KYIV.replace('\n', ' '));
});

test('a long banner gives only the line of the order', () => {
  const plea = 'Будь ласка, розумно споживайте електроенергію. '.repeat(8).trim();
  assert.equal(readBanner(plea + '\n' + DNIPRO_ORDER + '\n' + plea), DNIPRO_ORDER);
});

test('stabilisation hours, a fault in one district and a plea to save power are no order', () => {
  assert.equal(readBanner(KYIV_REGION), null, '«уникнути екстрених відключень» is what the plea hopes for');
  assert.equal(readBanner(ODESA), null);
});

test('an order that is not on now is not read as one', () => {
  assert.equal(readBanner('Сьогодні не діють екстрені відключення, графіки стабілізаційних — у силі.'), null);
  assert.equal(readBanner('У разі перевищення лімітів будуть застосовані екстрені відключення.'), null);
  assert.equal(readBanner('За потреби можуть бути застосовані екстрені відключення.'), null);
  assert.equal(readBanner('Екстрені відключення скасовані. Діють графіки стабілізаційних відключень.'), null);
  assert.equal(readBanner('UPD: застосовані екстрені відключення скасовані о 12:40.'), null);
});

test('no banner, an empty one and a banner that is not text say nothing', () => {
  for (const text of [undefined, null, '', '   ', 42, { text: DNIPRO }]) assert.equal(readBanner(text), null);
});

test('a long line is cut, not dropped', () => {
  const long = 'У районах ' + 'Дуже-довга-назва, '.repeat(30) + 'діють екстрені відключення.';
  const read = readBanner(long);
  assert.ok(read.length <= 320 && read.endsWith('…'));
});

test('the banner puts today under the warning and gives it its words', () => {
  const lines = [];
  const result = withSiteBanner(snapshot(DNIPRO), { now: NOW, log: (line) => lines.push(line) });
  assert.deepEqual(result.fact.emergency, [TODAY]);
  assert.equal(result.fact.emergencyNote, '«' + DNIPRO_WHOLE + '» — сайт ДТЕК');
  assert.deepEqual(result.fact.data, snapshot(DNIPRO).fact.data, 'the table is left as the operator published it');
  assert.equal(result.attention.text, DNIPRO);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^dnipro: emergency by the site's banner/);
});

test('it only adds: the days and the words another source gave stay', () => {
  const lines = [];
  const before = snapshot(KYIV, { emergency: [TODAY, TOMORROW], emergencyNote: 'у Печерському районі' });
  const result = withSiteBanner(before, { now: NOW, log: (line) => lines.push(line) });
  assert.deepEqual(result.fact.emergency, [TODAY, TOMORROW]);
  assert.equal(result.fact.emergencyNote, 'у Печерському районі');
  assert.deepEqual(lines, [], 'nothing new to say of a day already marked');

  const later = withSiteBanner(snapshot(DNIPRO, { emergency: [TOMORROW] }), { now: NOW, log: quiet });
  assert.deepEqual(later.fact.emergency, [TODAY, TOMORROW]);
});

test('without the words the snapshot is the one that came in', () => {
  for (const text of [undefined, KYIV_REGION, ODESA]) {
    const before = snapshot(text);
    assert.equal(withSiteBanner(before, { now: NOW, log: quiet }), before);
  }
  const marked = snapshot(ODESA, { emergency: [TODAY], emergencyNote: 'у Одеському районі' });
  assert.equal(withSiteBanner(marked, { now: NOW, log: quiet }), marked, 'and it takes no order back');
});

test('a read that leaned wholly on the served copy is no look at the banner', () => {
  const before = markCarried(snapshot(DNIPRO), true);
  const result = withSiteBanner(before, { now: NOW, log: quiet });
  assert.equal(result, before);
  assert.equal('emergency' in result.fact, false);
});

test('the banner is a look at the order: a carried flag is carried no more, a carried day still is', () => {
  const before = markCarried(snapshot(DNIPRO, { emergency: [TODAY] }), ['emergency', TOMORROW]);
  const result = withSiteBanner(before, { now: NOW, log: quiet });
  assert.deepEqual(carriedParts(result), [TOMORROW]);

  const only = withSiteBanner(markCarried(snapshot(DNIPRO, { emergency: [TODAY] }), ['emergency']), { now: NOW, log: quiet });
  assert.equal(carriedParts(only), null);
});
