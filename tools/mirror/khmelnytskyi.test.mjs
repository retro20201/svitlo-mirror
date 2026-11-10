import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArchive } from './sources/khmelnytskyi.mjs';

/** Verbatim shape of hoe.com.ua's archive listing, including the two traps it carries. */
const PAGE = `
<div class="files">
  <a href="/Content/Uploads/2026/06/file20260630194428959.png">Графік погодинних відключень 01.07.2026</a>
  <a href="/Content/Uploads/2026/04/file20260409203903009.png">Графік погодинних відключень 10.04.2026</a>
  <a href="/Content/Uploads/2026/04/file20260413084312342.png">Графік погодинних відключень 10.04.2026 (оновлення)</a>
  <a href="https://hoe.com.ua/Content/Uploads/2026/04/file20260410081543190.pdf">Графік погодинних відключень 09.04.2026 (оновлення)</a>
  <a href="/Content/Uploads/2026/04/file20260401120000000.pdf">Порядок подання показників лічильника</a>
</div>`;
const URL = 'https://hoe.com.ua/page/arhiv-grafikiv-pogodinnih-vidkljuchen-2026';
const kyiv = (s) => new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric'
}).format(new Date(s.dayStart * 1000));

test('a day is filed under the date the operator printed, not the day the file was uploaded', () => {
  const sheets = parseArchive(PAGE, URL);
  // The 01.07 schedule was uploaded on 30.06 — day-ahead publishing is the norm here, and filing
  // it under the upload day would show tomorrow's outages as today's.
  assert.ok(sheets.some((s) => kyiv(s) === '01.07.2026'));
  assert.ok(sheets.some((s) => kyiv(s) === '10.04.2026'));
});

test('an amended day replaces the original rather than appearing twice', () => {
  const sheets = parseArchive(PAGE, URL);
  const tenth = sheets.filter((s) => kyiv(s) === '10.04.2026');
  assert.equal(tenth.length, 1);
  assert.equal(tenth[0].isRevision, true);
  assert.match(tenth[0].imageUrl, /file20260413084312342\.png$/);
});

test('attachments that are not schedules are left alone', () => {
  const sheets = parseArchive(PAGE, URL);
  assert.equal(sheets.some((s) => /лічильник/i.test(s.caption)), false);
  assert.equal(sheets.length, 3);
});

test('relative and absolute hrefs both resolve to a fetchable address', () => {
  for (const sheet of parseArchive(PAGE, URL)) {
    assert.match(sheet.imageUrl, /^https:\/\/hoe\.com\.ua\/Content\/Uploads\//);
    assert.equal(sheet.sourceUrl, URL);
  }
});

test('sheets come back oldest first, so "today" is not a matter of luck', () => {
  const days = parseArchive(PAGE, URL).map((s) => s.dayStart);
  assert.deepEqual(days, [...days].sort((a, b) => a - b));
});

// ── the contract the app depends on ─────────────────────────────────────────
import { buildSnapshot, hasSchedule, validate, kyivDayStart } from './lib/canonical.mjs';

const sheet = { dayStart: kyivDayStart(), imageUrl: 'https://hoe.com.ua/x.png',
                sourceUrl: 'https://hoe.com.ua/page/a', caption: 'Графік', isRevision: false };

test('a picture-only region is valid without queues, which it can never have', () => {
  const snap = buildSnapshot({ regionId: 'khmelnytskyi', title: 'X', queues: {},
                               sheets: [sheet], sheetBased: true, source: 'khmelnytskyi' });
  assert.deepEqual(validate(snap), []);
  assert.equal(hasSchedule(snap), true);
});

test('out of season it stays valid and simply carries nothing', () => {
  const snap = buildSnapshot({ regionId: 'khmelnytskyi', title: 'X', queues: {},
                               sheets: [], sheetBased: true, source: 'khmelnytskyi' });
  assert.deepEqual(validate(snap), []);
  assert.equal(hasSchedule(snap), false, 'nothing published means the region is not offered');
  assert.equal(snap.sheets, undefined, 'an empty list is omitted rather than sent as []');
});

test('a region that is NOT picture-based still has to produce queues', () => {
  const snap = buildSnapshot({ regionId: 'kyiv', title: 'X', queues: {}, source: 'dtek' });
  assert.deepEqual(validate(snap), ['no queues'], 'a silently empty parser must still be caught');
});

// ── the channel's text tables (since 6 листопада 2026) ───────────────────────
import { readFileSync } from 'node:fs';
import { hasChannelTable } from './sources/khmelnytskyi.mjs';
import { scheduleFromPosts } from './lib/telegram.mjs';

/** The channel's last fifteen posts as t.me/s/khmelnytskoblenergo served them on 10 листопада 2026, verbatim. */
const POSTS = JSON.parse(readFileSync(new globalThis.URL('./khmelnytskyi.fixture-posts.json', import.meta.url), 'utf8'));
const days = (posts) => scheduleFromPosts(posts, { since: 0 });
const dayOf = (month, day) => String(kyivDayStart(new Date(Date.UTC(2026, month - 1, day, 12))));
/** The hours (1 = 00:00–01:00) a queue is off on a day. */
const offHours = (schedule, month, day, queue) =>
  Object.entries(schedule.fact[dayOf(month, day)][`GPV${queue}`]).filter(([, state]) => state === 'no').map(([hour]) => Number(hour));

test('the channel holds tables for 7 to 10 листопада, read as text', () => {
  assert.equal(hasChannelTable(POSTS, { since: 0 }), true);
  const schedule = days(POSTS);
  assert.deepEqual(Object.keys(schedule.fact).sort(), [dayOf(11, 7), dayOf(11, 8), dayOf(11, 9), dayOf(11, 10)].sort());
  assert.equal(schedule.queues.length, 12);
});

test('10 листопада reads as the post says: «Підчерга 5.1 – 11:00-15:00; 19:00-23:00»', () => {
  const schedule = days(POSTS);
  assert.deepEqual(offHours(schedule, 11, 10, '5.1'), [12, 13, 14, 15, 20, 21, 22, 23]);
  assert.deepEqual(offHours(schedule, 11, 10, '1.1'), [7, 8, 9, 10, 11, 16, 17, 18, 19]);
  // «Підчерга 4.1 – 06:00-11:00; 15:00-18:00; 23:00-24:00» — the last hour of the day closes at 24:00
  assert.deepEqual(offHours(schedule, 11, 10, '4.1'), [7, 8, 9, 10, 11, 16, 17, 18, 24]);
});

test('an «оновлено» post replaces a day from its own hour on and leaves the morning as first posted', () => {
  // 9 листопада: the evening-before table (20:05) and two updates (08:51, 15:07); the 15:07 one lists 18:00-21:00; 23:00-24:00 for 1.1.
  assert.deepEqual(offHours(days(POSTS), 11, 9, '1.1'), [11, 12, 13, 14, 15, 19, 20, 21, 24]);
});

test('posts that are not tables are not read as one', () => {
  const others = POSTS.filter((post) => !/Підчерга 1\.1/.test(post.text));
  assert.ok(others.length >= 5, 'the fixture keeps the channel\'s other posts, among them the explainer about ГПВ and the industrial ГОП notice');
  assert.equal(hasChannelTable(others, { since: 0 }), false);
});

test('before the days the posts name, the channel is no table (so the region falls back to the archive)', () => {
  assert.equal(hasChannelTable(POSTS, { since: Date.UTC(2026, 11, 1) / 1000 }), false);
});
