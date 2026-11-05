import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedOf, headlineOf, isAboutPower, plainOf, publishNews, NEWS_SOURCES } from './lib/operator-posts.mjs';

const NOW = new Date('2026-11-05T18:00:00Z');
const post = (id, postedAt, text) => ({ id, postedAt, text });

// Posts as the channels wrote them on 3–5 November 2026 (shortened), so the filters meet the real shapes.
const KHARKIV = [
  post(2303, '2026-11-03T11:10:00+00:00', '💡У жовтні фахівці українських енергетичних підприємств відновили електропостачання для майже 10 млн споживачів, які залишилися без світла внаслідок атак. Дякуємо енергетикам!'),
  post(2305, '2026-11-03T11:53:00+00:00', '🍂🔥 Опалювальний сезон без пожеж: про що варто пам’ятати? З настанням холодів та в умовах ворожих атак на енергетичну інфраструктуру зростає навантаження на мережі.'),
  post(2308, '2026-11-04T13:14:00+00:00', '🕯🇺🇦 У рідному Краснокутську відкрили меморіальну дошку захиснику Сергію Линнику. У Краснокутську відбулося відкриття меморіальної дошки.'),
  post(2314, '2026-11-04T19:12:00+00:00', '‼️ За вказівкою НЕК "Укренерго" у зв\'язку зі складною ситуацією в Об’єднаній енергосистемі, яка склалася через ворожі обстріли, на Харківщині застосовано графіки аварійних відключень.\n\nСлідкуйте за повідомленнями.')
];

test('only what is about the power is news; memorials and fire-safety leaflets are not', () => {
  const items = feedOf(KHARKIV, { channel: 'kharkivenergy', now: NOW });
  assert.deepEqual(items.map((item) => item.url), [
    'https://t.me/kharkivenergy/2314',
    'https://t.me/kharkivenergy/2303'
  ]);
});

test('newest first, each with a headline, a short excerpt and the post\'s own address', () => {
  const [first] = feedOf(KHARKIV, { channel: 'kharkivenergy', now: NOW });
  assert.equal(first.id, 'kharkivenergy/2314');
  assert.equal(first.at, '2026-11-04T19:12:00.000Z');
  assert.ok(first.title.startsWith('За вказівкою НЕК'), first.title);
  assert.ok(first.title.length <= 111);
  assert.ok(first.excerpt.length <= 221);
  assert.ok(!/^[‼️\s]/u.test(first.title));
});

test('nothing of the operator\'s text beyond a headline and a couple of lines is kept', () => {
  const long = post(1, '2026-11-05T10:00:00+00:00', `Шановні споживачі! ${'Енергетики працюють над відновленням електропостачання. '.repeat(40)}`);
  const [item] = feedOf([long], { channel: 'SumyEnergo', now: NOW });
  assert.ok(item.title.length + item.excerpt.length < 340, `${item.title.length + item.excerpt.length}`);
  assert.ok(item.excerpt.endsWith('…'));
});

test('a day\'s table is the schedule\'s business, not a headline', () => {
  const table = post(7, '2026-11-05T06:00:00+00:00', [
    'Години відсутності електропостачання на 5 листопада', '1.1: 00:00-04:00', '1.2: 04:00-08:00', '2.1: 08:00-12:00',
    '2.2: 12:00-16:00', '3.1: 16:00-20:00', '3.2: 20:00-24:00'].join('\n'));
  assert.deepEqual(feedOf([table], { channel: 'x', now: NOW }), []);
});

test('posts older than a week, and posts from the future, are left out', () => {
  const old = post(1, '2026-10-20T10:00:00+00:00', 'Шановні споживачі! Графіки відключень на завтра не змінюються.');
  const future = post(2, '2026-11-09T10:00:00+00:00', 'Шановні споживачі! Графіки відключень на завтра не змінюються.');
  assert.deepEqual(feedOf([old, future], { channel: 'x', now: NOW }), []);
});

test('ДТЕК\'s one channel is told apart by the place a post opens with', () => {
  const dtek = [
    post(4785, '2026-11-05T07:29:00+00:00', '‼️Київ: за командою Укренерго в частині Святошинського, Шевченківського та Подільського районів застосовані екстрені відключення. Нагадаємо, під час екстрених відключень графіки не діють.'),
    post(4786, '2026-11-05T08:46:00+00:00', '‼️Київська область: за командою Укренерго також запроваджені екстрені відключення. Нагадаємо, під час екстрених відключень графіки не діють.'),
    post(4787, '2026-11-05T15:32:00+00:00', '‼️Дніпро: за розпорядженням Укренерго в місті застосовані екстрені відключення. Нагадаємо, під час екстрених відключень графіки не діють.'),
    post(4781, '2026-11-05T06:42:00+00:00', '‼️Одещина: графіки відключень на 5 листопада ▪️У разі змін повідомимо в нашому Telegram-каналі. ‼️Підписуйтеся та поділіться каналом.')
  ];
  const of = (region) => {
    const source = NEWS_SOURCES.find((candidate) => candidate.region === region);
    return feedOf(dtek, { channel: source.channel, opens: source.opens, now: NOW }).map((item) => item.url);
  };
  assert.deepEqual(of('kyiv'), ['https://t.me/dtek_ua/4785']);
  assert.deepEqual(of('kyiv-region'), ['https://t.me/dtek_ua/4786']);
  assert.deepEqual(of('dnipro'), ['https://t.me/dtek_ua/4787']);
  assert.deepEqual(of('odesa'), ['https://t.me/dtek_ua/4781']);
});

test('the place is not repeated in the headline of a ДТЕК post', () => {
  const source = NEWS_SOURCES.find((candidate) => candidate.region === 'kyiv');
  const [item] = feedOf([post(1, '2026-11-05T07:29:00+00:00', '‼️Київ: екстрені відключення в частині районів, за командою Укренерго.')], { channel: 'dtek_ua', opens: source.opens, now: NOW });
  assert.ok(item.title.startsWith('екстрені відключення') || item.title.startsWith('Екстрені'), item.title);
});

test('calls to subscribe and bare links are not text', () => {
  assert.equal(plainOf('‼️Одещина: графіки на 5 листопада\n▪️У разі змін повідомимо в нашому Telegram-каналі.\n‼️Підписуйтеся та поділіться каналом\nhttps://t.me/dtek_ua'), 'Одещина: графіки на 5 листопада');
  assert.equal(isAboutPower('Відкрили меморіальну дошку. Електропостачання не порушено.'), false);
});

test('a headline is the first sentence, cut at a word when it runs on', () => {
  assert.deepEqual(headlineOf('Світло повернулося. Енергетики завершили ремонт.'), { title: 'Світло повернулося.', excerpt: 'Енергетики завершили ремонт.' });
  const { title } = headlineOf(`Енергетики ${'відновлюють електропостачання '.repeat(10)}`);
  assert.ok(title.endsWith('…') && title.length <= 111 && !title.includes('  '), title);
});

test('publishing writes a file per region, only when it changed, and keeps the old one when a channel is down', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'news-'));
  const sources = [{ region: 'kharkiv', channel: 'kharkivenergy' }, { region: 'sumy', channel: 'SumyEnergo' }];
  const reads = [];
  const read = async (channel) => {
    reads.push(channel);
    if (channel === 'SumyEnergo') throw new Error('timeout');
    return KHARKIV;
  };
  await writeFile(join(dir, 'news-sumy.json'), '{"items":[{"id":"kept"}]}');

  const first = await publishNews({ outDir: dir, now: NOW, read, sources });
  assert.deepEqual(first, { written: 1, failed: 1, regions: 2 });
  assert.equal(JSON.parse(await readFile(join(dir, 'news-kharkiv.json'), 'utf8')).items.length, 2);
  assert.equal(await readFile(join(dir, 'news-sumy.json'), 'utf8'), '{"items":[{"id":"kept"}]}');

  const again = await publishNews({ outDir: dir, now: NOW, read, sources });
  assert.equal(again.written, 0);
});

test('a channel shared by four regions is read once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'news-'));
  const reads = [];
  await publishNews({ outDir: dir, now: NOW, read: async (channel) => { reads.push(channel); return []; }, sources: NEWS_SOURCES.filter((source) => source.channel === 'dtek_ua') });
  assert.deepEqual(reads, ['dtek_ua']);
});
