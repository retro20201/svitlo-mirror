import { getText } from '../lib/http.mjs';
import { fetchChannel, gpvSnapshot, scheduleFromPosts } from '../lib/telegram.mjs';
import { buildSnapshot, kyivDayStart, queueNames, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * АТ «Хмельницькобленерго» — text from its channel when it posts text, its picture when it posts
 * only a picture.
 *
 * Through last season (118 photos on the channel, not one text table) the schedule was a picture
 * and only a picture, so this adapter carried the operator's own image through, dated, and left
 * the reading to the person — a grid misread the wrong way round says «світло є» when there is
 * none, the worst error this app can make.
 *
 * Since 6 листопада 2026 the operator posts each day's table to @khmelnytskoblenergo as text, one
 * line to a subqueue, in the layout lib/telegram.mjs reads for the other channels:
 *
 *   За розпорядженням НЕК «Укренерго» 10 листопада на Хмельниччині будуть застосовані графіки
 *   погодинних відключень (ГПВ). Години відсутності електроенергії:
 *   Підчерга 1.1 – 06:00-11:00; 15:00-19:00.
 *
 * and revises a day in place of a new table («оновлено графік … на 9 листопада»), which the shared
 * reader already treats as a later version speaking from its own half-hour on. That is the route
 * now: a text row names its hours, so there is no polarity to get wrong. Its posts are checked
 * against the rows of 7–10 листопада in tools/mirror/khmelnytskyi.fixture-posts.json.
 *
 * When the channel holds no table — out of season, or if the operator goes back to pictures — the
 * archive route below is what the region has always done.
 *
 * The archive page is the picture source rather than Telegram because it removes the one dangerous
 * ambiguity: every link there is captioned «Графік погодинних відключень DD.MM.YYYY», so a file is
 * known to *be* a schedule and known to be *for which day*. In the channel the same picture sits
 * among posts about meter readings, and telling them apart would be guesswork. (The archive stopped
 * at 17 жовтня 2026; the channel did not.)
 *
 * `hoe.com.ua` serves no robots.txt at all (404), so nothing is disallowed.
 */
const CHANNEL = 'khmelnytskoblenergo';
const BASE = 'https://hoe.com.ua';
const ARCHIVE = (year) => `${BASE}/page/arhiv-grafikiv-pogodinnih-vidkljuchen-${year}`;

/** `<a href="...png">Графік погодинних відключень 01.07.2026 (оновлення)</a>` */
const LINK = /<a[^>]+href="([^"]+\.(?:png|jpe?g|pdf))"[^>]*>([\s\S]*?)<\/a>/gi;
const LABEL_DATE = /(\d{2})\.(\d{2})\.(\d{4})/;

function absolute(href) {
  return href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** Kyiv midnight for a DD.MM.YYYY the operator printed, as epoch seconds. */
function dayStartFrom(day, month, year) {
  // Noon UTC lands on the intended calendar day in Kyiv whatever the offset, and `kyivDayStart`
  // then resolves the actual midnight — including the 25-hour day in October.
  return kyivDayStart(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12)));
}

export function parseArchive(html, pageUrl) {
  const byDay = new Map();
  for (const [, href, inner] of html.matchAll(LINK)) {
    const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/графік/i.test(label)) continue;          // the page carries other attachments too
    const when = LABEL_DATE.exec(label);
    if (!when) continue;

    const dayStart = dayStartFrom(when[1], when[2], when[3]);
    const isRevision = /оновлен/i.test(label);
    const sheet = {
      dayStart,
      imageUrl: absolute(href),
      sourceUrl: pageUrl,
      caption: label,
      isRevision
    };
    // A day is published once and then amended; the operator marks the amendments, and the last
    // one wins. Where nothing is marked, the file uploaded later wins — the upload stamp is baked
    // into the file name (fileYYYYMMDDHHMMSSmmm).
    const seen = byDay.get(dayStart);
    if (!seen || rank(sheet) >= rank(seen)) byDay.set(dayStart, sheet);
  }
  return [...byDay.values()].sort((a, b) => a.dayStart - b.dayStart);
}

function rank(sheet) {
  const stamp = /file(\d{14})/.exec(sheet.imageUrl)?.[1] ?? '0';
  return Number(stamp) + (sheet.isRevision ? 0.5 : 0);
}

/** Whether the channel's posts hold at least one day's table (the days before yesterday are not counted, unless `since` says). */
export function hasChannelTable(posts, options) {
  return Object.keys(scheduleFromPosts(posts, options).halves ?? {}).length > 0;
}

/**
 * The region from the channel's text tables when it has any, else from the archive's pictures.
 * `posts` is for tests; a channel that cannot be read is no table.
 */
export async function fetchRegion(region, { posts = null } = {}) {
  let channel = posts;
  if (!channel) {
    try { channel = await fetchChannel(CHANNEL); } catch { channel = []; }
  }
  if (hasChannelTable(channel)) return gpvSnapshot({ region, channel: CHANNEL, source: 'khmelnytskyi', posts: channel });
  return fetchArchive(region);
}

async function fetchArchive(region) {
  const year = new Date().getUTCFullYear();
  // At the turn of the year the current season spans two archive pages; a missing one is normal.
  const pages = await Promise.all(
    [year, year + 1].map(async (y) => {
      try {
        return { url: ARCHIVE(y), html: await getText(ARCHIVE(y)) };
      } catch {
        return null;
      }
    })
  );

  const today = kyivDayStart();
  const sheets = pages
    .filter(Boolean)
    .flatMap((p) => parseArchive(p.html, p.url))
    // Yesterday is still worth carrying: someone opening the app at 00:30 is usually asking about
    // the night that is still running.
    .filter((s) => s.dayStart >= today - 86400)
    .sort((a, b) => a.dayStart - b.dayStart)
    .slice(0, 3);

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    // The daily sheet is a picture, so nothing here computes hours — but the queue list is still
    // a fact about the region, and the app refuses to commit a черга it cannot name. Without it
    // the address lookup would find someone's підчерга and then be unable to apply it. The
    // operator's own address file uses the national 1.1–6.2 scheme, which build-khmelnytskyi.mjs
    // re-checks against this list every time it runs.
    queues: queueNames(NATIONAL_QUEUES),
    todayEpoch: today,
    sheets,
    sheetBased: true,
    source: 'khmelnytskyi'
  });
}
