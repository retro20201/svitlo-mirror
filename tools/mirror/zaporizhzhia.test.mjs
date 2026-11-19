import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseListing, readSiteEmergency, fetchRegion } from './sources/zaporizhzhia.mjs';
import { scheduleFromPosts, parseGpvPost } from './lib/telegram.mjs';
import { kyivDayStart, validate } from './lib/canonical.mjs';
import { carriedParts } from './lib/carried.mjs';

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

test('10 квітня at 22:30: the site\'s 22:27 revision darkens 5.1 and 5.2, and the channel\'s older table no longer holds 2.2 dark', async () => {
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
  // The channel kept 2.2 out 16:30–20:30 — the site's own table of 10:36, word for word — and the site cut it short to 17:30 at
  // 17:16. «Either one calling it dark is enough» stood here until the channel's day was seen for what it is: the state the site
  // had replaced, and from the half-hour of that revision the site's newer word stands alone (`withoutSuperseded`).
  assert.deepEqual(['17', '18', '19', '20', '21'].map((h) => tenth['GPV2.2'][h]), ['second', 'first', 'yes', 'yes', 'yes']);
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

test('a table pasted as <div> rows is read to its last row (3 квітня, post 387542)', () => {
  const one = SITE.match(/<article id="post-387542"[\s\S]*?<\/article>/)[0];
  const [post] = parseListing(one, new Date('2026-04-03T04:00:00Z'));
  const version = parseGpvPost(post);
  const dark = Object.entries(version.halves).filter(([, slots]) => slots.includes('off')).map(([key]) => key);
  assert.deepEqual(dark, ['GPV1.1', 'GPV2.1', 'GPV3.2', 'GPV6.2']);
});

test('a first table with no time is not dated days back by an older post above it', () => {
  const listing = [
    article(2, '5 КВІТНЯ ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ ДІЯТИМУТЬ ГПВ'),
    article(1, 'ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ НА 2 КВІТНЯ НЕ ЗАПЛАНОВАНІ', '<p>2 квітня введення ГПВ не заплановано</p>')
  ].join('\n');
  const posts = parseListing(listing, new Date('2026-04-05T05:00:00Z'));
  const first = posts.find((post) => post.id === 2);
  assert.equal(at(first), '04/04, 12:00');
  assert.ok(parseGpvPost(first)?.halves, 'the table was refused as implausibly dated');
});

test('when the site does not answer, what phones have stands in for it — no flip back to light', async () => {
  const now = new Date('2026-04-10T19:30:00Z');
  const channel = async () => CHANNEL.filter((post) => Date.parse(post.postedAt) <= now);
  const { value: both } = await quiet(() => fetchRegion(REGION, now, { fetchSite: async () => SITE, fetchTelegram: channel }));
  const { value: next, seen } = await quiet(() => fetchRegion({ ...REGION, previous: both }, now, {
    fetchSite: async () => { throw new Error('connect ETIMEDOUT'); },
    fetchTelegram: channel
  }));
  assert.deepEqual(next.fact.data, both.fact.data);
  assert.match(seen.join('\n'), /site: connect ETIMEDOUT/);
  // The site is the table itself: without it the read is no fresh look at the region at all.
  assert.equal(carriedParts(next), true);
  assert.equal(carriedParts(both), null);
});

// 14 November 2026, a letter at 08:18: queue 5.2, «05:30–10:30» on the screen, the light on at home. The channel's only post about
// the day was the evening's table; the site had revised it seven times since, pushing 5.2's morning cut back and at 08:01 taking it
// out. The page is as the Kyiv server got it at 10:50, the posts about 13–14 November only; the channel's posts are 3590–3596.
const SITE_NOV = readFileSync(new URL('./zaporizhzhia.fixture-2026-11-14-site.html', import.meta.url), 'utf8');
const CHANNEL_NOV = JSON.parse(readFileSync(new URL('./zaporizhzhia.fixture-2026-11-14-channel.json', import.meta.url), 'utf8'));
const dark = (hours) => Object.entries(hours).filter(([, state]) => state !== 'yes').map(([hour]) => Number(hour));

test('a channel that only repeats a table the site has since replaced does not hold the day dark', async () => {
  const now = new Date('2026-11-14T08:50:00Z');
  const snapshot = await fetchRegion(REGION, now, { fetchSite: async () => SITE_NOV, fetchTelegram: async () => CHANNEL_NOV });
  const today = snapshot.fact.data[day('2026-11-14')];
  assert.deepEqual(dark(today['GPV5.2']), [20, 21, 22, 23, 24], 'the evening cut only: the morning one was taken out at 08:01');
  assert.deepEqual(dark(today['GPV1.1']), [12, 13, 14, 15, 24], '11:00, not the evening table\'s 10:00');
  assert.equal(snapshot.fact.update, '14.11.2026 09:26', 'the stamp of the site\'s last revision');
  assert.deepEqual(validate(snapshot), []);
  // The day before, which both outlets told and neither has replaced since, is as it was: united.
  assert.deepEqual(dark(snapshot.fact.data[day('2026-11-13')]['GPV5.2']), [11, 12, 13, 14]);
});

test('…but a table the site never had stays united with the site\'s', async () => {
  const now = new Date('2026-11-14T08:50:00Z');
  // The channel's own revision: the evening's table with one more cut late in the day, which no version of the site's has.
  const own = CHANNEL_NOV.map((post) => (post.id === 3596
    ? { ...post, text: post.text.replace('⚡ Черга 2.1\n', '⚡ Черга 2.1\n з 22:00 до 23:00\n') }
    : post));
  assert.notEqual(JSON.stringify(own), JSON.stringify(CHANNEL_NOV), 'the fixture has the line that is changed');
  const snapshot = await fetchRegion(REGION, now, { fetchSite: async () => SITE_NOV, fetchTelegram: async () => own });
  const today = snapshot.fact.data[day('2026-11-14')];
  assert.ok(dark(today['GPV2.1']).includes(23), 'the cut only the channel has');
  assert.ok(dark(today['GPV5.2']).includes(8), 'and with it the channel\'s whole table, as before');
});

test('a cut of the channel\'s own that was over before the site\'s next revision stays, and the hours ahead of it are the site\'s', async () => {
  const now = new Date('2026-11-14T08:50:00Z');
  // The same table with a cut at 03:00–04:00 instead: from the site's 05:11 revision on, the channel says of the rest of the day
  // exactly what the site had said until then — the state the site went on to replace.
  const own = CHANNEL_NOV.map((post) => (post.id === 3596
    ? { ...post, text: post.text.replace('⚡ Черга 2.1\n', '⚡ Черга 2.1\n з 03:00 до 04:00\n') }
    : post));
  const snapshot = await fetchRegion(REGION, now, { fetchSite: async () => SITE_NOV, fetchTelegram: async () => own });
  const today = snapshot.fact.data[day('2026-11-14')];
  assert.ok(dark(today['GPV2.1']).includes(4), 'what the channel alone said of the night stays');
  assert.deepEqual(dark(today['GPV5.2']), [20, 21, 22, 23, 24], 'the morning cut the site took out at 08:01 is not held by the channel');
});

test('the channel alone, or equal to the site\'s newest table, is read as before', async () => {
  const now = new Date('2026-11-14T08:50:00Z');
  const { value: alone } = await quiet(() => fetchRegion(REGION, now, {
    fetchSite: async () => { throw new Error('timeout'); }, fetchTelegram: async () => CHANNEL_NOV
  }));
  assert.ok(dark(alone.fact.data[day('2026-11-14')]['GPV5.2']).includes(8), 'no site this cycle: the channel is all there is');
});

// 19 November 2026, a letter at 14:49: queue 4.1, «14:30–19:30» on the screen, the light on at home. The site had moved the cut to
// 16:30 at 14:09. The channel had two posts about the day — the evening's table (3634) and the 05:42 «оновлено ГПВ» (3635), which
// the operator has since edited in place to the site's 07:52 version — and laid over one another they are no table the site ever
// had, so the rule above, which looked at the channel's day as a whole, left nothing out. The page is as the Kyiv server got it at
// 14:53, the channel's posts 3630–3636 as its preview page had them then.
const SITE_19 = readFileSync(new URL('./zaporizhzhia.fixture-2026-11-19-site.html', import.meta.url), 'utf8');
const CHANNEL_19 = JSON.parse(readFileSync(new URL('./zaporizhzhia.fixture-2026-11-19-channel.json', import.meta.url), 'utf8'));

test('two posts of the channel, each an older version of the site\'s, do not hold back the site\'s newest table', async () => {
  const now = new Date('2026-11-19T12:53:00Z');
  const snapshot = await fetchRegion(REGION, now, { fetchSite: async () => SITE_19, fetchTelegram: async () => CHANNEL_19 });
  const today = snapshot.fact.data[day('2026-11-19')];
  assert.deepEqual(dark(today['GPV4.1']), [17, 18, 19, 20], '16:30–19:30, as the site has had it since 14:09 — not 14:30');
  assert.equal(today['GPV4.1']['17'], 'second');
  assert.equal(snapshot.fact.update, '19.11.2026 14:09', 'the stamp of the site\'s last revision');
  // The hours before the revision the channel missed (11:09) stay united, as they were shown all morning: 1.2's night cut is
  // the channel's evening table, which the site itself had taken back at 23:07 the night before.
  assert.deepEqual(dark(today['GPV1.2']).slice(0, 3), [1, 2, 3]);
  assert.deepEqual(validate(snapshot), []);

  // And a cycle without the site does not bring the channel's 14:30 back: only what the channel has posted since the table
  // phones have is added to it.
  const { value: next } = await quiet(() => fetchRegion({ ...REGION, previous: snapshot }, now, {
    fetchSite: async () => { throw new Error('connect ETIMEDOUT'); }, fetchTelegram: async () => CHANNEL_19
  }));
  assert.deepEqual(next.fact.data, snapshot.fact.data);
});

test('…and a post of the channel\'s that is no version of the site\'s still unites with it, the day having two posts or not', async () => {
  const now = new Date('2026-11-19T12:53:00Z');
  // The channel's own revision of the morning post: 2.1 an hour earlier, which no version of the site's has.
  const own = CHANNEL_19.map((post) => (post.id === 3635 ? { ...post, text: post.text.replace('2.1: 16:00 - 21:00', '2.1: 15:00 - 21:00') } : post));
  assert.notEqual(JSON.stringify(own), JSON.stringify(CHANNEL_19), 'the fixture has the line that is changed');
  const snapshot = await fetchRegion(REGION, now, { fetchSite: async () => SITE_19, fetchTelegram: async () => own });
  const today = snapshot.fact.data[day('2026-11-19')];
  assert.ok(dark(today['GPV2.1']).includes(16), 'the hour only the channel has');
  assert.ok(dark(today['GPV4.1']).includes(16), 'and with it that post\'s whole table, 4.1 from 14:30, as before');
});

// 16–18 November 2026: Укренерго's emergency schedules (ГАВ) and the special ones (СГАВ) started and lifted five times over, each
// time in a post of the site's own between its tables. On the 17th both stood from 06:05 to 19:36, and four letters came from
// queues the table had in the light (09:46, 12:29, 13:50, 15:37) with no «Аварійні відключення» on the screen: nothing read it.
// The page is as the Kyiv server got it on the 18th at 19:16, its twenty posts.
const SITE_ORDERS = readFileSync(new URL('./zaporizhzhia.fixture-2026-11-18-site.html', import.meta.url), 'utf8');
/** The page as it stood while post `id` was its newest: the listing is newest first. */
const pageWhenNewest = (id) => SITE_ORDERS.slice(SITE_ORDERS.indexOf(`<article id="post-${id}"`));
const hushed = async (fn) => { const log = console.log; console.log = () => {}; try { return await quiet(fn); } finally { console.log = log; } };

test('the site\'s own posts say when the emergency schedules stand and when they are lifted', () => {
  const read = (id, now) => readSiteEmergency(pageWhenNewest(id), new Date(now));
  const off = { active: false, since: null, note: null };
  // Before the first of them: the page says nothing either way.
  assert.equal(read(393162, '2026-11-16T14:30:00Z'), null);
  // 16:35 on the 16th, both at once, in one post.
  assert.deepEqual(read(393190, '2026-11-16T14:40:00Z'), {
    active: true, since: '2026-11-16T14:35:00.000Z',
    note: 'запроваджено графіки аварійних відключень (ГАВ) та спеціальні графіки аварійних відключень (СГАВ)'
  });
  // 19:06, 21:20, 22:30: the special ones lifted, started, lifted. The first order stands through all of it — and the post that
  // started both is no longer quoted, since half of what it says is not so.
  for (const [id, now] of [[393188, '2026-11-16T17:10:00Z'], [393180, '2026-11-16T19:25:00Z'], [393183, '2026-11-16T20:35:00Z']]) {
    assert.deepEqual(read(id, now), { active: true, since: '2026-11-16T14:35:00.000Z', note: null }, String(id));
  }
  // A table for the 17th at 00:13 changes nothing; at 00:45 the first order is lifted, and nothing is in force.
  assert.equal(read(393166, '2026-11-16T22:20:00Z').active, true);
  assert.deepEqual(read(393185, '2026-11-16T22:50:00Z'), off);
  // 06:05 and 06:15 on the 17th: ГАВ in full, then СГАВ for three queues — still so at the hour of each letter.
  assert.deepEqual(read(393186, '2026-11-17T04:10:00Z'), {
    active: true, since: '2026-11-17T04:05:00.000Z', note: 'запроваджено у повному обсязі графіки аварійних відключень (ГАВ)'
  });
  for (const now of ['2026-11-17T07:46:00Z', '2026-11-17T10:29:00Z', '2026-11-17T11:50:00Z', '2026-11-17T13:37:00Z']) {
    assert.deepEqual(read(393187, now), {
      active: true, since: '2026-11-17T04:05:00.000Z',
      note: 'запроваджено у повному обсязі графіки аварійних відключень (ГАВ); запроваджено спеціальні графіки аварійних відключень (СГАВ) в обсязі 3 черг'
    }, now);
  }
  // 19:36: both lifted in one post. A day and nine tables later the times, which carry no date, still fall where they were.
  assert.deepEqual(read(393197, '2026-11-17T17:40:00Z'), off);
  assert.deepEqual(readSiteEmergency(SITE_ORDERS, new Date('2026-11-18T17:16:00Z')), off);
});

test('while an order stands the region carries the warning, in the operator\'s words, and loses it when the order is lifted', async () => {
  const at = (id, now) => hushed(() => fetchRegion(REGION, new Date(now), { fetchSite: async () => pageWhenNewest(id), fetchTelegram: async () => [] }));
  const { value: morning } = await at(393187, '2026-11-17T07:46:00Z');
  assert.deepEqual(morning.fact.emergency, [day('2026-11-17')]);
  assert.match(morning.fact.emergencyNote, /^запроваджено у повному обсязі графіки аварійних відключень \(ГАВ\); /);
  assert.deepEqual(validate(morning), []);
  assert.equal(carriedParts(morning), null);
  // The table is the one it would have been without the warning.
  assert.deepEqual(dark(morning.fact.data[day('2026-11-17')]['GPV5.2']), [2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 20, 21, 22, 23, 24]);

  const { value: evening } = await at(393197, '2026-11-17T17:40:00Z');
  assert.equal('emergency' in evening.fact, false);
  assert.equal('emergencyNote' in evening.fact, false);
});

test('a page with no word on the orders, or no page at all, leaves the warning phones have — for the rest of its day', async () => {
  const { value: warned } = await hushed(() => fetchRegion(REGION, new Date('2026-11-17T07:46:00Z'), {
    fetchSite: async () => pageWhenNewest(393187), fetchTelegram: async () => []
  }));
  const region = { ...REGION, previous: warned };
  // The order's post has left the first page: tables only.
  const tablesOnly = article(9, 'ОНОВЛЕНО ГПВ НА 17 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено 12:10)');
  const { value: kept } = await hushed(() => fetchRegion(region, new Date('2026-11-17T10:30:00Z'), { fetchSite: async () => tablesOnly, fetchTelegram: async () => [] }));
  assert.deepEqual(kept.fact.emergency, [day('2026-11-17')]);
  assert.equal(kept.fact.emergencyNote, warned.fact.emergencyNote);
  assert.deepEqual(carriedParts(kept), ['emergency']);

  const down = { fetchSite: async () => { throw new Error('connect ETIMEDOUT'); }, fetchTelegram: async () => [] };
  const { value: held } = await hushed(() => fetchRegion(region, new Date('2026-11-17T10:30:00Z'), down));
  assert.deepEqual(held.fact.emergency, [day('2026-11-17')]);
  assert.equal(carriedParts(held), true);

  // Past midnight it is yesterday's warning, and goes.
  const { value: next } = await hushed(() => fetchRegion(region, new Date('2026-11-17T22:30:00Z'), down));
  assert.equal('emergency' in next.fact, false);
  // And a region that had none gets none from a silent page.
  const { value: none } = await hushed(() => fetchRegion(REGION, new Date('2026-11-17T10:30:00Z'), { fetchSite: async () => tablesOnly, fetchTelegram: async () => [] }));
  assert.equal('emergency' in none.fact, false);
  assert.equal(carriedParts(none), null);
});

test('an order the page has carried for a day and a half with nothing to lift it is not believed any more', () => {
  const order = '<p>За вказівкою НЕК “Укренерго” по Запорізькій області запроваджено у повному обсязі графіки аварійних відключень (ГАВ).</p>';
  const listing = (newest) => [
    article(4, `ОНОВЛЕНО ГПВ НА 20 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено ${newest})`),
    article(3, 'ОНОВЛЕНО ГПВ НА 19 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено 07:00)'),
    article(2, 'УВАГА! ДІЮТЬ ГРАФІКИ АВАРІЙНИХ ВІДКЛЮЧЕНЬ (оновлено о 06:05)', order),
    article(1, 'ОНОВЛЕНО ГПВ НА 19 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено 05:30)')
  ].join('\n');
  // Under a table revised at 07:00 on the 19th, 06:05 is that morning's: thirty-four hours old at 16:30 on the 20th, thirty-nine at 21:30.
  const afternoon = readSiteEmergency(listing('16:00'), new Date('2026-11-20T14:30:00Z'));
  assert.deepEqual(afternoon, { active: true, since: '2026-11-19T04:05:00.000Z', note: 'запроваджено у повному обсязі графіки аварійних відключень (ГАВ)' });
  assert.deepEqual(readSiteEmergency(listing('21:00'), new Date('2026-11-20T19:30:00Z')), { active: false, since: null, note: null });
});

test('a title that names neither order speaks of both, and its own words decide whether it starts or lifts them', () => {
  const page = (title, body) => article(2, title, `<p>${body}</p>`) + article(1, 'ОНОВЛЕНО ГПВ НА 17 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено 05:00)');
  const now = new Date('2026-11-17T08:00:00Z');
  const started = readSiteEmergency(page('УВАГА! АВАРІЙНІ ВІДКЛЮЧЕННЯ (оновлено о 09:40)', 'По Запорізькій області застосовано аварійні відключення.'), now);
  assert.deepEqual(started, { active: true, since: '2026-11-17T07:40:00.000Z', note: 'застосовано аварійні відключення' });
  const lifted = readSiteEmergency(page('УВАГА! АВАРІЙНІ ВІДКЛЮЧЕННЯ (оновлено о 09:40)', 'Аварійні відключення по Запорізькій області скасовано.'), now);
  assert.deepEqual(lifted, { active: false, since: null, note: null });
  // The reminder under a table is no post about an order, whatever it mentions.
  const table = article(1, 'ОНОВЛЕНО ГПВ НА 17 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено 05:00)', '<p>1.1: 09:00 – 14:00</p><p>У разі запровадження ГАВ графіки не діють.</p>');
  assert.equal(readSiteEmergency(table, now), null);
});
