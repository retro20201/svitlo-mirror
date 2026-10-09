import { getBytes } from './http.mjs';
import { fetchChannelPage, parsePhotoPosts, mergeVersions } from './telegram.mjs';
import { buildSnapshot, kyivDayStart, queueNames, NATIONAL_QUEUES } from './canonical.mjs';
import { markCarried } from './carried.mjs';

/**
 * The shared half of an adapter for an operator whose only table is a picture it posts to its
 * Telegram channel (Суми, Закарпаття). The adapter says which posts are schedules and which day
 * each is about, and reads a picture into half-hours; this does the rest:
 *
 *  - every schedule picture for yesterday onward is read, one download at a time;
 *  - per day, if the newest picture reads, its hours (merged with the day's earlier readable
 *    versions, each in force from when it was posted) are published;
 *  - if the newest picture does not read, the picture itself is published for that day — the
 *    app shows it when it has no hours — and not an older reading it may have replaced.
 */
const DAY_SECONDS = 86400;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Today onward, a day the served copy has and this read has nothing for at all — no hours, no
 * picture — keeps the served copy. These channels never take a schedule back by deleting its post;
 * a change is a new post, which this read would have seen. So a day that vanishes is a page served
 * without the post, or a post caught mid-edit, for one fetch: on 6 October that emptied Суми's day
 * for five minutes and woke every phone in the oblast twice. Returns the days kept.
 */
function keepServedDays(previous, { fact, sheets, from }) {
  const data = previous?.fact?.data;
  const days = data && !Array.isArray(data) ? data : {};
  const covered = (epoch) => fact[epoch] !== undefined || sheets.some((sheet) => sheet.dayStart === epoch);
  const kept = [];
  for (const [day, queues] of Object.entries(days)) {
    const epoch = Number(day);
    if (epoch < from || covered(epoch)) continue;
    fact[epoch] = queues;
    kept.push(epoch);
  }
  for (const sheet of previous?.sheets ?? []) {
    if (sheet.dayStart < from || covered(sheet.dayStart)) continue;
    sheets.push(sheet);
    kept.push(sheet.dayStart);
  }
  return kept;
}

export async function pictureChannelSnapshot(region, {
  channel, source, dayOf, read, amendment = () => null, now = new Date(), spacing = 500,
  fetchPage = fetchChannelPage, fetchImage = getBytes
}) {
  const since = kyivDayStart(now) - DAY_SECONDS;
  const posts = parsePhotoPosts(await fetchPage(channel))
    .map((post) => ({ post, day: dayOf(post) }))
    .filter(({ day }) => day && day.epoch >= since)
    .sort((a, b) => a.post.id - b.post.id);

  const byDay = new Map();
  for (const { post, day } of posts) {
    if (post.photos.length !== 1) {
      console.warn(`[${source}] post ${post.id} has ${post.photos.length} pictures; which is the table is not guessed`);
      continue;
    }
    await pause(spacing);
    // A download that fails is a lost packet, not an unreadable picture, so it fails the region:
    // that keeps the last good copy and wakes no one. Treated as unreadable, it published the day
    // without the picture's hours and woke every phone in the oblast for a schedule that had not
    // changed.
    const bytes = await fetchImage(post.photos[0]);
    // A reader that throws (a picture in a format it does not handle) has read nothing; it must
    // not take the whole region down with it.
    let result;
    try {
      result = read(bytes);
    } catch (error) {
      result = { error: error.message };
    }
    // A picture that is no table at all (a stock banner, an infographic) is never published in a
    // schedule's place; its caption may still amend the day.
    if (result.notTable) {
      const delta = amendment(post, day);
      if (!delta) continue;
      result = { delta };
    } else if (result.error) {
      console.warn(`[${source}] post ${post.id} did not read (${result.error}); publishing the picture`);
    }
    if (!byDay.has(day.epoch)) byDay.set(day.epoch, []);
    byDay.get(day.epoch).push({ post, day, result });
  }

  const versions = [];
  const sheets = [];
  for (const [epoch, list] of byDay) {
    const tables = list.filter(({ result }) => !result.delta);
    const newest = tables.at(-1);
    if (!newest) continue;
    if (newest.result.error) {
      sheets.push({
        dayStart: epoch,
        imageUrl: newest.post.photos[0],
        sourceUrl: `https://t.me/${channel}/${newest.post.id}`,
        caption: newest.post.text.split('\n').find((line) => line.trim()) ?? null,
        isRevision: tables.length > 1
      });
      continue;
    }
    for (const { day, result } of list) {
      if (result.delta) versions.push({ ...day, delta: result.delta });
      else if (!result.error) versions.push({ ...day, halves: result.halves });
    }
  }
  const { fact, update } = mergeVersions(versions, { since });
  const kept = keepServedDays(region.previous, { fact, sheets, from: kyivDayStart(now) });

  // Kept days are no look at the channel (carried.mjs); the days this page did carry are.
  return markCarried(buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: queueNames(NATIONAL_QUEUES),
    fact,
    todayEpoch: kyivDayStart(now),
    update: update ?? (kept.length ? region.previous.fact?.update ?? null : null),
    sheets: sheets.sort((a, b) => a.dayStart - b.dayStart),
    source
  }), kept);
}
