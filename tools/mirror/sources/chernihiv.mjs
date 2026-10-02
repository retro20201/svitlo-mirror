import { readFileSync } from 'node:fs';
import { dayOfPost } from '../lib/telegram.mjs';
import { pictureChannelSnapshot } from '../lib/picture-channel.mjs';
import { readChernihivPicture, loadDigits } from '../lib/chernihiv-picture.mjs';
import { parseAmendment } from '../lib/chernihiv-amendments.mjs';
import { kyivDayStart, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * АТ «Чернігівобленерго» — the ГПВ tables and amendments it posts to @chernigivoblenergo.
 *
 * Its website bans an address for fetching robots.txt and is not touched. The channel carries:
 *  - the day's table as a picture — a colour grid (October 2025 – March 2026) or twelve tiles
 *    (February 2026 on), both read in `lib/chernihiv-picture.mjs`;
 *  - amendments in the caption of a stock banner ("🕗 З 22:00 до 24:00 додатково відключається
 *    черга 5/1"), applied on top of the day's table (`lib/chernihiv-amendments.mjs`);
 *  - infographics that mention ГПВ, which are neither and are ignored.
 *
 * The day: the caption names it ("10 квітня в області діятиме Графік", "зміни … на 9 квітня");
 * an amendment that names none is about the day it was posted, unless it says "завтра".
 */
const CHANNEL = 'chernigivoblenergo';
const MODEL = JSON.parse(readFileSync(new URL('./chernihiv-model.json', import.meta.url), 'utf8'));
const DIGITS = loadDigits(MODEL);
const KYIV_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function scheduleDay(post) {
  if (!/погодинн|ГПВ|черг[аи]\s+\d\s*\/\s*\d/i.test(post.text)) return null;
  const dated = dayOfPost(post);
  if (dated) return dated;
  if (/завтра/i.test(post.text)) return null;
  const posted = new Date(post.postedAt);
  return { id: post.id, postedAt: post.postedAt, at: posted.getTime(), epoch: kyivDayStart(posted) };
}

/** The half-hour of the day `day.epoch` the post went out in (0 if the day before). */
function postSlot(post, day) {
  const posted = new Date(post.postedAt);
  if (kyivDayStart(posted) < day.epoch) return 0;
  const [h, m] = KYIV_CLOCK.format(posted).split(':').map(Number);
  return Math.floor((h * 60 + m) / 30);
}

export function amendmentOf(post, day) {
  const { changes } = parseAmendment(post.text, postSlot(post, day));
  return changes.length ? changes : null;
}

export async function fetchRegion(region, options = {}) {
  return pictureChannelSnapshot(region, {
    channel: CHANNEL,
    source: 'chernihiv',
    dayOf: scheduleDay,
    read: (bytes) => {
      const result = readChernihivPicture(bytes, MODEL, DIGITS);
      if (result.error) return result;
      return { halves: Object.fromEntries(NATIONAL_QUEUES.map((label, i) => [`GPV${label}`, result.rows[i]])) };
    },
    amendment: amendmentOf,
    ...options
  });
}
