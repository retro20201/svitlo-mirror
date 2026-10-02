import { readFileSync } from 'node:fs';
import { dayOfPost } from '../lib/telegram.mjs';
import { pictureChannelSnapshot } from '../lib/picture-channel.mjs';
import { readSchedulePicture } from '../lib/sumy-picture.mjs';
import { kyivDayStart, NATIONAL_QUEUES } from '../lib/canonical.mjs';

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

export async function fetchRegion(region, options = {}) {
  return pictureChannelSnapshot(region, {
    channel: CHANNEL,
    source: 'sumy',
    dayOf: scheduleDay,
    read: (bytes) => {
      const result = readSchedulePicture(bytes, MODEL);
      return result.error ? result : { halves: halvesFromRows(result.rows) };
    },
    ...options
  });
}
