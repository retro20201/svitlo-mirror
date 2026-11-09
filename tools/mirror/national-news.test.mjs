import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIONAL_SOURCES, RESERVED, decodeEntities, itemsOf, mergeFeeds, parseRss, postsOf, publishNational, unshout } from './lib/national-news.mjs';

const NOW = new Date('2026-11-07T06:00:00Z');
const source = (id) => NATIONAL_SOURCES.find((candidate) => candidate.id === id);
/** The channel of Укренерго, as the page reader would give it: nothing, for the tests of the outlets. */
const NO_CHANNEL = async () => [];

// Items shaped as the three feeds wrote them on the morning of 7 November 2026 (the story text of the second one cut short).
const UKRINFORM = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Укрінформ</title>
<item>
  <guid isPermaLink="false">4182307</guid>
  <title><![CDATA[НРК уперше виконали понад 30 тисяч логістичних та евакуаційних місій за місяць]]></title>
  <link>https://www.ukrinform.ua/rubric-ato/4182307-nrk-uperse-vikonali-ponad-30-tisac-logisticnih-ta-evakuacijnih-misij-za-misac.html</link>
  <enclosure url="https://static.ukrinform.com/photos/2026_05/thumb_files/630_360_1778251460-815.jpg" length="1" type="image/jpeg"></enclosure>
  <description><![CDATA[Наземні роботизовані комплекси упродовж жовтня виконали 31 тисячу 398 логістичних та евакуаційних місій.]]></description>
  <pubDate>Sat, 07 Nov 2026 06:33:00 +0200</pubDate>
  <category><![CDATA[Війна]]></category>
</item></channel></rss>`;

const PRAVDA = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Українська правда</title><item><title>РФ за добу втратила ще 2280 військових та 44 артсистеми – Генштаб</title><link>https://www.pravda.com.ua/news/2026/11/07/8061673/</link><pubDate>Sat, 07 Nov 2026 06:47:00 +0200</pubDate><content:encoded><![CDATA[<p> <span>За минулу добу Сили оборони знищили ТЕКСТ-ЩО-НЕ-МАЄ-ПОТРАПИТИ-ДО-СТРІЧКИ</span></p>]]></content:encoded></item></channel></rss>`;

const UNIAN = `<rss version="2.0"><channel><title>УНІАН</title>
<item><pubDate>Sat, 07 Nov 2026 06:30:00 +0200</pubDate><title><![CDATA[Кімнатна рослина розкриє вашу головну суперсилу: тест на особистість]]></title><description><![CDATA[Перший вибір підкаже, яка сильна риса характеру допомагає вам у житті.]]></description><link>https://www.unian.ua/curiosities/test-na-osobistist-oberit-kimnatnu-roslinu-13550535.html</link><category>Интересности</category></item>
<item><pubDate>Sat, 07 Nov 2026 06:10:00 +0200</pubDate><title><![CDATA[В Україні знову запроваджують графіки відключень світла: що відомо]]></title><description><![CDATA[Укренерго повідомило про нові обмеження.]]></description><link>https://www.unian.ua/economics/energetika-grafiki-13550600.html</link><category>Энергетика</category></item>
</channel></rss>`;

test('a feed is read for its title, description, link, date and category — and for nothing else', () => {
  const [item] = parseRss(UKRINFORM);
  assert.equal(item.title, 'НРК уперше виконали понад 30 тисяч логістичних та евакуаційних місій за місяць');
  assert.equal(item.description, 'Наземні роботизовані комплекси упродовж жовтня виконали 31 тисячу 398 логістичних та евакуаційних місій.');
  assert.equal(item.pubDate, 'Sat, 07 Nov 2026 06:33:00 +0200');
  assert.equal(item.category, 'Війна');
  assert.ok(item.link.startsWith('https://www.ukrinform.ua/rubric-ato/4182307-'));
  assert.deepEqual(Object.keys(item).sort(), ['category', 'description', 'link', 'pubDate', 'title']);
});

test('the story an outlet puts in its feed is never carried, nor its picture', () => {
  const [item] = itemsOf(parseRss(PRAVDA), source('pravda'), { now: NOW });
  const written = JSON.stringify(item);
  assert.ok(!written.includes('ТЕКСТ-ЩО-НЕ-МАЄ'), written);
  assert.ok(!written.includes('.jpg'), written);
  assert.equal(item.excerpt, '');
  assert.equal(item.source, 'Українська правда');
});

test('each headline keeps its outlet\'s name, its own address and a date in UTC', () => {
  const [item] = itemsOf(parseRss(UKRINFORM), source('ukrinform'), { now: NOW });
  assert.equal(item.at, '2026-11-07T04:33:00.000Z');
  assert.equal(item.source, 'Укрінформ');
  assert.ok(item.url.startsWith('https://www.ukrinform.ua/'));
  assert.ok(item.id.startsWith('ukrinform//rubric-ato/4182307'), item.id);
  assert.ok(item.excerpt.startsWith('Наземні роботизовані'));
});

test('a feed that mixes in quizzes and horoscopes is let through only by its news categories', () => {
  const items = itemsOf(parseRss(UNIAN), source('unian'), { now: NOW });
  assert.deepEqual(items.map((item) => item.url), ['https://www.unian.ua/economics/energetika-grafiki-13550600.html']);
});

test('a link that leaves the outlet\'s own site, or is not https, is not passed on', () => {
  const item = (link) => `<item><title>Достатньо довгий заголовок новини</title><link>${link}</link><pubDate>Sat, 07 Nov 2026 06:30:00 +0200</pubDate></item>`;
  const xml = item('https://ads.example.com/click?to=ukrinform.ua') + item('http://www.ukrinform.ua/rubric-ato/1-a.html') + item('https://www.ukrinform.ua/rubric-ato/2-b.html') + item('https://evil-ukrinform.ua/x');
  assert.deepEqual(itemsOf(parseRss(xml), source('ukrinform'), { now: NOW }).map((entry) => entry.url), ['https://www.ukrinform.ua/rubric-ato/2-b.html']);
});

test('what is older than two days, or from the future, or sold as an advertisement, is left out', () => {
  const item = (title, date) => `<item><title>${title}</title><link>https://www.ukrinform.ua/rubric-ato/${encodeURIComponent(title).length}-x.html</link><pubDate>${date}</pubDate></item>`;
  const xml = [
    item('Давня новина про щось дуже давнє', 'Wed, 04 Nov 2026 06:00:00 +0200'),
    item('Новина з майбутнього, якої ще нема', 'Mon, 09 Nov 2026 06:00:00 +0200'),
    item('Партнерський матеріал: купуйте наші товари', 'Sat, 07 Nov 2026 06:00:00 +0200'),
    item('Звичайна свіжа новина про звичайне', 'Sat, 07 Nov 2026 06:00:00 +0200')
  ].join('');
  assert.deepEqual(itemsOf(parseRss(xml), source('ukrinform'), { now: NOW }).map((entry) => entry.title), ['Звичайна свіжа новина про звичайне']);
});

test('a description that only repeats the headline is not an excerpt', () => {
  const xml = '<item><title>Укренерго: завтра графіки не діятимуть</title><link>https://www.ukrinform.ua/rubric-ato/3-x.html</link><description>Укренерго: завтра графіки не діятимуть.</description><pubDate>Sat, 07 Nov 2026 06:00:00 +0200</pubDate></item>';
  assert.equal(itemsOf(parseRss(xml), source('ukrinform'), { now: NOW })[0].excerpt, '');
});

test('markup and entities in a feed\'s lines are read as the text they mean', () => {
  assert.equal(decodeEntities('&laquo;Тест&raquo; &amp; &#39;ще&#39; &#x27;раз&#x27; &unknown;'), '«Тест» & \'ще\' \'раз\' &unknown;');
  const [item] = parseRss('<item><title>Рада ухвалила &quot;закон&quot; про <b>світло</b></title><link>https://www.pravda.com.ua/news/1/</link></item>');
  assert.equal(item.title, 'Рада ухвалила "закон" про світло');
});

test('an outlet gives at most twelve, and the list is newest first with a story told twice kept once', () => {
  const many = Array.from({ length: 20 }, (_, index) => `<item><title>Новина номер ${index + 100} про щось важливе</title><link>https://www.pravda.com.ua/news/2026/11/07/${index}/</link><pubDate>Sat, 07 Nov 2026 0${Math.floor(index / 10) + 4}:${String(index % 10 * 5).padStart(2, '0')}:00 +0200</pubDate></item>`).join('');
  const pravda = itemsOf(parseRss(many), source('pravda'), { now: NOW });
  assert.equal(pravda.length, 12);
  const ukrinform = itemsOf(parseRss(`<item><title>Новина номер 119 про щось важливе!</title><link>https://www.ukrinform.ua/rubric-ato/9-x.html</link><pubDate>Sat, 07 Nov 2026 05:59:00 +0200</pubDate></item>`), source('ukrinform'), { now: NOW });
  const merged = mergeFeeds([pravda, ukrinform]);
  assert.equal(merged.length, 12);
  assert.deepEqual(merged.map((item) => item.at), [...merged.map((item) => item.at)].sort().reverse());
  assert.equal(merged.filter((item) => item.title.startsWith('Новина номер 119')).length, 1);
});

test('publishing writes one file, only when it changed, and survives an outlet that is down', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ua-'));
  const feeds = { [source('ukrinform').url]: UKRINFORM, [source('pravda').url]: PRAVDA };
  const read = async (url) => {
    if (url === source('unian').url) throw new Error('HTTP 503');
    return feeds[url];
  };
  const first = await publishNational({ outDir: dir, now: NOW, read, readPage: NO_CHANNEL });
  assert.deepEqual(first, { written: true, read: 3, failed: 1 });
  const file = JSON.parse(await readFile(join(dir, 'news-ua.json'), 'utf8'));
  assert.deepEqual(file.items.map((item) => item.source), ['Українська правда', 'Укрінформ']);

  const again = await publishNational({ outDir: dir, now: NOW, read, readPage: NO_CHANNEL });
  assert.equal(again.written, false);
});

test('when no outlet can be read, nothing is written and the file already served stays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ua-'));
  const result = await publishNational({ outDir: dir, now: NOW, read: async () => { throw new Error('offline'); }, readPage: async () => { throw new Error('offline'); } });
  assert.deepEqual(result, { written: false, read: 0, failed: 4 });
  await assert.rejects(stat(join(dir, 'news-ua.json')));
});

// --- Укренерго, from its public channel.

const UKRENERGO_POSTS = [
  { id: 5625, postedAt: '2026-11-07T04:37:32+00:00', text: "Через ворожі атаки на енергооб'єкти на ранок є знеструмлення у Вінницькій, Дніпропетровській, Донецькій областях.\nЕнергетики працюють над відновленням.\n▪️Підписуйтеся та поділіться каналом" },
  { id: 5623, postedAt: '2026-11-06T09:27:11+00:00', text: 'УВАГА! ІНФОРМАЦІЯ ПРО ВІДКЛЮЧЕННЯ\nЗавтра, 7 ЛИСТОПАДА, у частині областей України вимушено будуть застосовуватись заходи обмеження споживання: 00:00 – 23:59 – графіки обмеження потужності для промисловості.' },
  { id: 5616, postedAt: '2026-11-06T08:52:51+00:00', text: 'Укренерго – переможець премії UNIC «Ділова репутація і доброчесність». Компанія посіла перше місце в номінації.' },
  { id: 5500, postedAt: '2026-10-30T08:00:00+00:00', text: 'Завтра у частині областей застосовуватимуться графіки відключень електроенергії.' }
];

test('Укренерго is read from its channel: only what is about the power, with its name under it and the post as its address', () => {
  const items = postsOf(UKRENERGO_POSTS, source('ukrenergo'), { now: NOW });
  assert.deepEqual(items.map((item) => item.id), ['ukrenergo/5625', 'ukrenergo/5623'], 'the prize and the post of last week are left out');
  assert.ok(items.every((item) => item.source === 'Укренерго'));
  assert.equal(items[0].url, 'https://t.me/ukrenergo/5625');
  assert.ok(items[0].title.startsWith('Через ворожі атаки'));
});

test('a headline of the channel goes into the list of the country beside the outlets, newest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'national-'));
  const read = async (url) => (url.includes('ukrinform') ? UKRINFORM : url.includes('pravda') ? PRAVDA : UNIAN);
  await publishNational({ outDir: dir, now: NOW, read, readPage: async () => UKRENERGO_POSTS });
  const items = JSON.parse(await readFile(join(dir, 'news-ua.json'), 'utf8')).items;
  assert.ok(items.some((item) => item.source === 'Укренерго'));
  assert.deepEqual(items.map((item) => item.at), [...items.map((item) => item.at)].sort().reverse());
});

test('a channel that cannot be read leaves the outlets going out, and the outlets down leave the channel going out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'national-'));
  const read = async (url) => (url.includes('ukrinform') ? UKRINFORM : url.includes('pravda') ? PRAVDA : UNIAN);
  const withoutChannel = await publishNational({ outDir: dir, now: NOW, read, readPage: async () => { throw new Error('t.me is down'); } });
  assert.equal(withoutChannel.written, true);
  assert.equal(withoutChannel.failed, 1);
  assert.ok(!JSON.parse(await readFile(join(dir, 'news-ua.json'), 'utf8')).items.some((item) => item.source === 'Укренерго'));

  const dir2 = await mkdtemp(join(tmpdir(), 'national-'));
  const onlyChannel = await publishNational({
    outDir: dir2, now: NOW, read: async () => { throw new Error('offline'); }, readPage: async () => UKRENERGO_POSTS
  });
  assert.equal(onlyChannel.written, true);
  assert.deepEqual(JSON.parse(await readFile(join(dir2, 'news-ua.json'), 'utf8')).items.map((item) => item.source), ['Укренерго', 'Укренерго']);
});

test('a headline the channel writes in capitals is read in sentence case, and one that is not is left as it is', () => {
  assert.equal(unshout('ІНФОРМАЦІЯ ПРО ВІДКЛЮЧЕННЯ.'), 'Інформація про відключення.');
  assert.equal(unshout('АВАРІЙНІ ВІДКЛЮЧЕННЯ.'), 'Аварійні відключення.');
  assert.equal(unshout('Через ворожі атаки є знеструмлення.'), 'Через ворожі атаки є знеструмлення.');
  assert.equal(unshout('НРК виконали 30 тисяч місій.'), 'НРК виконали 30 тисяч місій.', 'a lower-case word makes it a sentence');
  assert.equal(unshout('УВАГА'), 'Увага');
  assert.equal(unshout('ЗСУ'), 'ЗСУ', 'three letters are an abbreviation');
});

test('the channel\'s newest posts stay in a list that the outlets\' thirty newest headlines would fill', () => {
  const outlet = (n) => ({ id: `o/${n}`, at: new Date(NOW.getTime() - n * 60_000).toISOString(), title: `Заголовок видання ${n} про щось`, excerpt: '', url: `https://www.ukrinform.ua/${n}`, source: 'Укрінформ' });
  const outlets = Array.from({ length: 40 }, (_, n) => outlet(n));
  const notices = [5, 6, 7].map((hours, i) => ({
    id: `ukrenergo/${i}`, at: new Date(NOW.getTime() - hours * 3600_000).toISOString(), title: `Повідомлення Укренерго ${i}`, excerpt: '', url: `https://t.me/ukrenergo/${i}`, source: 'Укренерго'
  }));

  const crowdedOut = mergeFeeds([outlets, notices]);
  assert.equal(crowdedOut.length, 30);
  assert.equal(crowdedOut.filter((item) => item.source === 'Укренерго').length, 0, 'by recency alone they are never there');

  const kept = mergeFeeds([outlets, notices], notices.slice(0, RESERVED));
  assert.equal(kept.length, 30, 'the room is taken from the list, not added to it');
  assert.equal(kept.filter((item) => item.source === 'Укренерго').length, 3);
  assert.deepEqual(kept.map((item) => item.at), [...kept.map((item) => item.at)].sort().reverse(), 'still newest first');
});

test('publishing keeps the channel\'s newest posts in the file however busy the outlets are', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'national-'));
  const busy = (n) => `<item><title>Новина видання номер ${n}, досить довга для відбору</title><link>https://www.ukrinform.ua/rubric-ato/${n}-x.html</link><pubDate>${new Date(NOW.getTime() - n * 60_000).toUTCString()}</pubDate><category>Війна</category></item>`;
  const feed = `<rss version="2.0"><channel><title>Укрінформ</title>${Array.from({ length: 40 }, (_, n) => busy(n)).join('')}</channel></rss>`;
  const read = async (url) => (url.includes('ukrinform') ? feed : '<rss version="2.0"><channel></channel></rss>');
  await publishNational({ outDir: dir, now: NOW, read, readPage: async () => UKRENERGO_POSTS });
  const items = JSON.parse(await readFile(join(dir, 'news-ua.json'), 'utf8')).items;
  assert.ok(items.length <= 30);
  assert.ok(items.some((item) => item.source === 'Укренерго'), 'their notices are in the file');
});
