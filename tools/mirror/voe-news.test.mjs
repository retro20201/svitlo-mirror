import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardsOf, dayOf, feedOf, publishVinnytsiaNews, wordsOf } from './lib/voe-news.mjs';

// www.voe.com.ua/news as it was on the evening of 14 November 2026: twelve cards, the rest of the page cut away.
const PAGE = await readFile(fileURLToPath(new URL('./vinnytsia.fixture-news-2026-11-14.html', import.meta.url)), 'utf8');
const EVENING = new Date('2026-11-14T16:00:00Z');
const titles = (items) => items.map((item) => item.title);

test('the list is read card by card: number, address, day, title and first lines', () => {
  const cards = cardsOf(PAGE);
  assert.equal(cards.length, 12);
  const [first] = cards;
  assert.equal(first.node, 10432);
  assert.equal(first.path, '/news/vvedennya-hpv-131');
  assert.equal(first.title, 'Введення ГПВ');
  assert.equal(first.day.toISOString(), '2026-11-12T22:00:00.000Z', '13 November in Kyiv');
  assert.match(first.body, /^Дата та час відключень - 14\.11\.26\. Будуть застосовані з 06:00 - 24:00\./u);
  assert.deepEqual(cardsOf('<html><body>Сторінку не знайдено</body></html>'), []);
});

test('the home page lays the same card out differently, and it reads the same', () => {
  const home = '<div class=" swiper-slide views__row views-news__row"><div class="node news news-10430 content-page-row">'
    + '<div class="field field-page-img"> <a href="/news/zminy-po-hpv-92" hreflang="uk"><img src="/x.jpg" alt="АТ «Вінницяобленерго»"></a></div>'
    + '<div class="content-page-row__second"><div class="date-format">13 листопада, 2026</div>'
    + '<div class="content-page-row__title"><a href="/news/zminy-po-hpv-92">Зміни по ГПВ</a></div>'
    + '<div class="clearfix text-formatted field body field__text-with-summary field-label__hidden">Дата та час відключень - 13.11.2026 з 17:00 до 24:00Отримали розпорядження від НЕК &quot;Укренерго&quot;.</div></div></div></div>';
  const [card] = cardsOf(home);
  assert.equal(card.node, 10430);
  assert.equal(card.path, '/news/zminy-po-hpv-92');
  assert.deepEqual(wordsOf(card), { title: 'Зміни по ГПВ: 13.11 з 17:00 до 24:00', excerpt: 'Отримали розпорядження від НЕК "Укренерго".' });
});

test('a day is the operator\'s own «13 листопада, 2026», in Kyiv', () => {
  assert.equal(dayOf('13 листопада, 2026').toISOString(), '2026-11-12T22:00:00.000Z');
  assert.equal(dayOf('1 липня, 2026').toISOString(), '2026-06-30T21:00:00.000Z', 'summer time');
  assert.equal(dayOf('13 Листопада 2026').toISOString(), '2026-11-12T22:00:00.000Z');
  assert.equal(dayOf('13.11.2026'), null);
  assert.equal(dayOf('13 брюмера, 2026'), null);
  assert.equal(dayOf(''), null);
});

test('the headline says which day and from when to when, as the operator wrote it', () => {
  const card = (title, body) => ({ node: 1, path: '/news/x', day: new Date(), title, body });
  assert.deepEqual(
    wordsOf(card('Введення ГПВ', 'Дата та час відключень - 14.11.26. Будуть застосовані з 06:00 - 24:00.Від НЕК "Укренерго" отримали завдання про застосування Графіків погодинних відключень. Протягом')),
    { title: 'Введення ГПВ: 14.11 з 06:00 до 24:00', excerpt: 'Від НЕК "Укренерго" отримали завдання про застосування Графіків погодинних відключень.' }
  );
  assert.equal(wordsOf(card('Зміни по ГПВ', 'Дата та час відключень - 13.11.2026 з 07:00Отримали розпорядження продовжити застосування черг графіка.')).title, 'Зміни по ГПВ: 13.11 з 07:00');
  assert.equal(wordsOf(card('Введення ГПВ', 'Дата та час відключень - 5.1.27 з 6:00 до 9:30. Отримали завдання про застосування графіків.')).title, 'Введення ГПВ: 05.01 з 06:00 до 09:30');
  // No hours given: the day alone, and nothing made up after it.
  assert.equal(wordsOf(card('Скасування ГПВ', 'Дата та час відключень - 15.11.2026. Графіки погодинних відключень скасовано.')).title, 'Скасування ГПВ: 15.11');
  // A card that is not that line keeps its own title and lines.
  assert.deepEqual(
    wordsOf(card('Енергетики на місці!', 'Ворог продовжує нищити енергетичну інфраструктуру. Маємо пошкодження об’єктів енергопостачання, тривають аварійні відключення')),
    { title: 'Енергетики на місці!', excerpt: 'Ворог продовжує нищити енергетичну інфраструктуру. Маємо пошкодження об’єктів енергопостачання, тривають аварійні відключення…' }
  );
});

test('limits for businesses and what is not about the power are not a household\'s news', () => {
  const feed = feedOf(cardsOf(PAGE), { now: EVENING });
  assert.deepEqual(titles(feed), [
    'Введення ГПВ: 14.11 з 06:00 до 24:00',
    'Зміни по ГПВ: 13.11 з 17:00 до 24:00',
    'Зміни по ГПВ: 13.11 з 07:00',
    'Введення ГПВ: 13.11 з 06:00 до 24:00',
    'Що таке «пікові години» і чому вони небезпечні',
    'Енергетики на місці! Відновлювальні роботи тривають.',
    'Введення ГПВ: 12.11 з 06:00 до 24:00'
  ]);
  assert.ok(!feed.some((item) => /ГОП|поради/u.test(item.title)));
  assert.equal(feed[0].id, 'voe/10432');
  assert.equal(feed[0].url, 'https://www.voe.com.ua/news/vvedennya-hpv-131');
  assert.deepEqual(Object.keys(feed[0]), ['id', 'at', 'title', 'excerpt', 'url']);
});

test('with nothing watched before, a card of an earlier day is dated to that day\'s noon, newest number first', () => {
  const feed = feedOf(cardsOf(PAGE), { now: EVENING });
  assert.deepEqual(feed.slice(0, 4).map((item) => item.at), [
    '2026-11-13T10:00:00.000Z', '2026-11-13T10:00:00.000Z', '2026-11-13T10:00:00.000Z', '2026-11-12T10:00:00.000Z'
  ]);
});

test('a card is dated when it was first seen, inside its own day, and keeps that date afterwards', () => {
  const card = (node, day, title) => ({ node, path: `/news/n-${node}`, day: dayOf(day), title, body: 'Дата та час відключень - 15.11.26. Будуть застосовані з 06:00 - 24:00. Отримали завдання.' });
  const served = [{ id: 'voe/10432', at: '2026-11-13T17:42:10.000Z' }];
  const feed = feedOf([
    card(10440, '14 листопада, 2026', 'Введення ГПВ'),
    card(10436, '13 листопада, 2026', 'Зміни по ГПВ'),
    card(10432, '13 листопада, 2026', 'Введення ГПВ')
  ], { now: EVENING, served });
  const at = Object.fromEntries(feed.map((item) => [item.id, item.at]));
  assert.equal(at['voe/10440'], '2026-11-14T16:00:00.000Z', 'new today: now');
  assert.equal(at['voe/10436'], '2026-11-13T21:59:59.000Z', 'posted late yesterday, seen after midnight: the last second of its day');
  assert.equal(at['voe/10432'], '2026-11-13T17:42:10.000Z', 'already served: unchanged');
  assert.deepEqual(feed.map((item) => item.id), ['voe/10440', 'voe/10436', 'voe/10432']);
  // A card the operator dates ahead of the clock is not dated before its own day.
  const ahead = feedOf([card(10450, '15 листопада, 2026', 'Введення ГПВ')], { now: EVENING, served });
  assert.equal(ahead[0].at, '2026-11-14T22:00:00.000Z');
});

test('a card older than a week is left out', () => {
  const old = { node: 9000, path: '/news/old', day: dayOf('1 листопада, 2026'), title: 'Введення ГПВ', body: 'Дата та час відключень - 02.11.26. Будуть застосовані з 06:00 - 24:00.' };
  assert.deepEqual(feedOf([old], { now: EVENING }), []);
});

test('the site is asked only on its turn; between turns the served feed is put back as it is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voe-news-'));
  const file = join(dir, 'news-vinnytsia.json');
  const servedText = '{"items":[{"id":"voe/10432","at":"2026-11-13T17:42:10.000Z","title":"Введення ГПВ: 14.11 з 06:00 до 24:00","excerpt":"","url":"https://www.voe.com.ua/news/vvedennya-hpv-131"}]}';
  let reads = 0;
  const read = async () => { reads++; return PAGE; };

  const between = await publishVinnytsiaNews({ outDir: dir, now: EVENING, ask: false, read, readServed: async () => servedText });
  assert.deepEqual(between, { written: true, asked: false, failed: false, changed: false });
  assert.equal(reads, 0);
  assert.equal(await readFile(file, 'utf8'), servedText);

  const turn = await publishVinnytsiaNews({ outDir: dir, now: EVENING, ask: true, read, readServed: async () => servedText });
  assert.deepEqual(turn, { written: true, asked: true, failed: false, changed: true });
  assert.equal(reads, 1);
  const feed = JSON.parse(await readFile(file, 'utf8')).items;
  assert.equal(feed.length, 7);
  assert.equal(feed.find((item) => item.id === 'voe/10432').at, '2026-11-13T17:42:10.000Z', 'the date it was served with');

  // The same page again, against what was just written: nothing to publish.
  const written = await readFile(file, 'utf8');
  const again = await publishVinnytsiaNews({ outDir: dir, now: new Date(EVENING.getTime() + 6 * 60 * 1000), ask: true, read, readServed: async () => written });
  assert.equal(again.changed, false);
  assert.equal(await readFile(file, 'utf8'), written);
});

test('a site that does not answer, or answers with a page without cards, leaves the served feed alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voe-news-'));
  const file = join(dir, 'news-vinnytsia.json');
  const servedText = '{"items":[{"id":"kept"}]}';
  const down = await publishVinnytsiaNews({ outDir: dir, now: EVENING, read: async () => { throw new Error('HTTP 403'); }, readServed: async () => servedText });
  assert.deepEqual(down, { written: true, asked: true, failed: true, changed: false });
  assert.equal(await readFile(file, 'utf8'), servedText);
  const blank = await publishVinnytsiaNews({ outDir: dir, now: EVENING, read: async () => '<html><body>Just a moment...</body></html>', readServed: async () => servedText });
  assert.equal(blank.failed, true);
  assert.equal(await readFile(file, 'utf8'), servedText);
});

test('with no feed served yet and no answer from the site, nothing is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voe-news-'));
  const none = await publishVinnytsiaNews({ outDir: dir, now: EVENING, read: async () => { throw new Error('timeout'); }, readServed: async () => null });
  assert.deepEqual(none, { written: false, asked: true, failed: true, changed: false });
  await assert.rejects(readFile(join(dir, 'news-vinnytsia.json'), 'utf8'));
  // The first good read makes the file.
  const first = await publishVinnytsiaNews({ outDir: dir, now: EVENING, read: async () => PAGE, readServed: async () => null });
  assert.deepEqual(first, { written: true, asked: true, failed: false, changed: true });
});
