import { readFileSync } from 'node:fs';
import { getBytes } from '../lib/http.mjs';
import { fetchChannelPage, parsePhotoPosts, dayOfPost, mergeVersions } from '../lib/telegram.mjs';
import { readSchedulePicture } from '../lib/sumy-picture.mjs';
import { buildSnapshot, kyivDayStart, queueNames, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * АТ «Сумиобленерго» — the ГПВ table it posts to @SumyEnergo, read off the picture.
 *
 * The operator's site renders its schedule in the browser from /api/, which its robots.txt
 * disallows; the channel (linked from soe.com.ua) carries the same table as a picture with a
 * caption that names the day. So the picture is read (`lib/sumy-picture.mjs`), and when it does
 * not read cleanly the picture itself is published — the app shows it when it has no hours.
 *
 * The day comes from the caption: "Завтра, 21 січня", "на 10 березня", "на 30-06-2026". Updates
 * posted without a date ("Маємо оновлення в застосуванні ГПВ…", November–December 2025) were, in
 * all 16 transcribed, about the day they went out, posted between 08:18 and 18:50; one posted
 * after 20:00 could be about tomorrow, so it is skipped rather than guessed.
 */
const CHANNEL = 'SumyEnergo';
const MODEL = JSON.parse(readFileSync(new URL('./sumy-model.json', import.meta.url), 'utf8'));
const SPACING_MS = 500;
const DAY_SECONDS = 86400;

const KYIV_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' });

/** The day a schedule post is about, or null. */
export function scheduleDay(post) {
  if (!/ГПВ|погодинн/i.test(post.text)) return null;
  const dated = dayOfPost(post);
  if (dated) return dated;
  if (!/оновлен|внесено зміни/i.test(post.text)) return null;
  const posted = new Date(post.postedAt);
  if (Number(KYIV_HOUR.format(posted)) >= 20) return null;
  return { id: post.id, postedAt: post.postedAt, at: posted.getTime(), epoch: kyivDayStart(posted) };
}

/** A read picture → half-hour slots per subqueue, as the channel adapters' versions carry them. */
export function halvesFromRows(rows) {
  const halves = {};
  NATIONAL_QUEUES.forEach((label, i) => {
    const slots = Array(48).fill('on');
    for (const { start, end } of rows[i]) for (let s = Math.floor(start / 30); s < Math.ceil(end / 30); s++) slots[s] = 'off';
    halves[`GPV${label}`] = slots;
  });
  return halves;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchRegion(region, { now = new Date(), read = readSchedulePicture, fetchPage = fetchChannelPage, fetchImage = getBytes, spacing = SPACING_MS } = {}) {
  const since = kyivDayStart(now) - DAY_SECONDS;
  const posts = parsePhotoPosts(await fetchPage(CHANNEL))
    .map((post) => ({ post, day: scheduleDay(post) }))
    .filter(({ day }) => day && day.epoch >= since)
    .sort((a, b) => a.post.id - b.post.id);

  const byDay = new Map();
  for (const { post, day } of posts) {
    if (post.photos.length !== 1) {
      console.warn(`[sumy] post ${post.id} has ${post.photos.length} pictures; which is the table is not guessed`);
      continue;
    }
    await pause(spacing);
    const result = read(await fetchImage(post.photos[0]), MODEL);
    if (result.error) console.warn(`[sumy] post ${post.id} did not read (${result.error}); publishing the picture`);
    if (!byDay.has(day.epoch)) byDay.set(day.epoch, []);
    byDay.get(day.epoch).push({ post, day, result });
  }

  const versions = [];
  const sheets = [];
  for (const [epoch, list] of byDay) {
    const newest = list.at(-1);
    if (newest.result.error) {
      // The operator's latest word for the day is a picture we cannot read: show the picture,
      // not an older reading it may have replaced.
      sheets.push({
        dayStart: epoch,
        imageUrl: newest.post.photos[0],
        sourceUrl: `https://t.me/${CHANNEL}/${newest.post.id}`,
        caption: newest.post.text.split('\n').find((line) => line.trim()) ?? null,
        isRevision: list.length > 1
      });
      continue;
    }
    for (const { day, result } of list) if (!result.error) versions.push({ ...day, halves: halvesFromRows(result.rows) });
  }
  const { fact, update } = mergeVersions(versions, { since });

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: queueNames(NATIONAL_QUEUES),
    fact,
    todayEpoch: kyivDayStart(now),
    update,
    sheets: sheets.sort((a, b) => a.dayStart - b.dayStart),
    source: 'sumy'
  });
}
