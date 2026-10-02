import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseListing, fetchRegion } from './sources/zaporizhzhia.mjs';
import { scheduleFromPosts } from './lib/telegram.mjs';
import { kyivDayStart, validate } from './lib/canonical.mjs';

// www.zoe.com.ua/outage/ (pages 7–8 as saved from the Kyiv server on 2026-10-01, posts only) and
// @Zaporizhzhyaoblenergo_news posts 3076–3096: the same days, 8–10 квітня 2026, from both outlets.
const SITE = readFileSync(new URL('./zaporizhzhia.fixture-site-2026-04.html', import.meta.url), 'utf8');
const OFF_SEASON = readFileSync(new URL('./zaporizhzhia.fixture-site-offseason.html', import.meta.url), 'utf8');
const CHANNEL = JSON.parse(readFileSync(new URL('./zaporizhzhia.fixture-channel-2026-04.json', import.meta.url), 'utf8'));

const REGION = { id: 'zaporizhzhia', title: 'Запорізька область' };
const day = (iso) => kyivDayStart(new Date(`${iso}T12:00:00Z`));
const kyiv = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const at = (post) => kyiv.format(new Date(post.postedAt));
const quiet = async (fn) => { const warn = console.warn; const seen = []; console.warn = (m) => seen.push(m); try { return { value: await fn(), seen }; } finally { console.warn = warn; } };

const article = (id, title, body = '<p>Години відсутності електропостачання:</p><p>1.1: 09:00 – 14:00</p>') =>
  `<article id="post-${id}"><h2>${title}</h2><div class="content">${body}</div></article>`;

test('a title\'s undated time lands on the day it can only be', () => {
  const posts = parseListing(SITE, new Date('2026-04-10T19:30:00Z'));
  const byId = Object.fromEntries(posts.map((post) => [post.id, post]));
  assert.equal(at(byId[387655]), '08/04, 14:18');   // "НА 8 КВІТНЯ (оновлено 14:18)" — the 8th, not the 7th
  assert.equal(at(byId[387769]), '10/04, 22:27');   // the late revision the channel never carried
  // Page order is time order; the ids are not (387709 went out after 387713).
  const times = posts.map((post) => Date.parse(post.postedAt));
  assert.ok(times.every((time, i) => i === 0 || time > times[i - 1]));
  assert.ok(posts.findIndex((post) => post.id === 387713) < posts.findIndex((post) => post.id === 387709));
});

test('a revision at 23:44 the evening before stays the evening before, whenever it is read', () => {
  const listing = [
    article(4, 'ОНОВЛЕНО ГПВ НА 16 ГРУДНЯ (оновлено 04:41)'),
    article(3, 'ОНОВЛЕНО ГПВ НА 16 ГРУДНЯ (оновлено о 00-26)'),
    article(2, 'СКОРЕГОВАНИЙ ГПВ НА 16 ГРУДНЯ ( оновлено о 23:44)'),
    article(1, '16 ГРУДНЯ ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ ДІЯТИМУТЬ ГПВ')
  ].join('\n');
  for (const now of ['2025-12-16T04:00:00Z', '2025-12-17T08:00:00Z']) {
    const times = parseListing(listing, new Date(now)).map(at);
    assert.deepEqual(times.slice(1), ['15/12, 23:44', '16/12, 00:26', '16/12, 04:41'], now);
  }
});

test('every spelling of the title\'s time is read, and taken out of the text', () => {
  const spellings = ['(оновлено 21:26)', '(оновлено о 21-35)', '(оновлено об 11:25)', '( оновлено о 20:55)', '(20:13)'];
  const listing = spellings.map((stamp, i) => article(10 - i, `ОНОВЛЕНО ГПВ НА 9 КВІТНЯ ${stamp}`)).join('\n');
  const posts = parseListing(listing, new Date('2026-04-09T21:00:00Z'));
  assert.equal(posts.length, spellings.length);
  assert.ok(posts.every((post) => !/оновлено|\(\d/.test(post.text.split('\n')[0])), 'stamp left in the title');
});

test('10 квітня at 22:30: the site\'s 22:27 revision darkens 5.1 and 5.2, and the channel\'s 2.2 stays dark', async () => {
  const now = new Date('2026-04-10T19:30:00Z');
  const { value: snapshot } = await quiet(() => fetchRegion(REGION, now, {
    fetchSite: async () => SITE,
    fetchTelegram: async () => CHANNEL.filter((post) => Date.parse(post.postedAt) <= now)
  }));
  const tenth = snapshot.fact.data[day('2026-04-10')];
  for (const key of ['GPV5.1', 'GPV5.2']) {
    assert.equal(tenth[key]['23'], 'second', key);
    assert.equal(tenth[key]['24'], 'no', key);
  }
  // The channel kept 2.2 out 16:30–20:30; the site's later revision dropped it. Either one calling
  // it dark is enough.
  assert.deepEqual(['17', '18', '19', '20', '21'].map((h) => tenth['GPV2.2'][h]), ['second', 'no', 'no', 'no', 'first']);
  assert.deepEqual(validate(snapshot), []);
});

test('with the site down the region is exactly what the channel alone says', async () => {
  const now = new Date('2026-04-10T19:30:00Z');
  const posts = CHANNEL.filter((post) => Date.parse(post.postedAt) <= now);
  const { value: snapshot, seen } = await quiet(() => fetchRegion(REGION, now, {
    fetchSite: async () => { throw new Error('connect ETIMEDOUT'); },
    fetchTelegram: async () => posts
  }));
  assert.deepEqual(snapshot.fact.data, scheduleFromPosts(posts, { since: kyivDayStart(now) - 86400 }).fact);
  assert.match(seen.join('\n'), /site: connect ETIMEDOUT; channel only/);
});

test('a page with no posts is a broken page, not a quiet day', async () => {
  assert.throws(() => parseListing('<html><body>Sorry, you have been blocked</body></html>'), /no posts/);
  const { seen } = await quiet(() => fetchRegion(REGION, new Date('2026-04-10T19:30:00Z'), {
    fetchSite: async () => '<html></html>',
    fetchTelegram: async () => CHANNEL
  }));
  assert.match(seen.join('\n'), /no posts on the outage page; channel only/);
});

test('with both outlets down the region fails, and keeps its last good copy', async () => {
  await assert.rejects(fetchRegion(REGION, new Date(), {
    fetchSite: async () => { throw new Error('reset'); },
    fetchTelegram: async () => { throw new Error('HTTP 502'); }
  }), /site: reset; channel: HTTP 502/);
});

test('out of season the site\'s daily «не заплановані» publish no day', async () => {
  const { value: snapshot } = await quiet(() => fetchRegion(REGION, new Date('2026-10-01T12:00:00Z'), {
    fetchSite: async () => OFF_SEASON,
    fetchTelegram: async () => []
  }));
  assert.deepEqual(snapshot.fact.data, []);
  assert.equal(Object.keys(snapshot.preset.sch_names).length, 12);
});
