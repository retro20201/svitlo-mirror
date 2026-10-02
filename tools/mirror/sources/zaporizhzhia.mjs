import { readFileSync } from 'node:fs';
import {
  fetchChannel, scheduleFromPosts, parseGpvPost, dayOfPost, mergeVersions, unionHalves, factFromHalves
} from '../lib/telegram.mjs';
import { getTextTrusting } from '../lib/https-ca.mjs';
import { buildSnapshot, kyivDayStart, queueNames, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * АТ «Запоріжжяобленерго» — ГПВ tables from two of their own outlets, combined.
 *
 * @Zaporizhzhyaoblenergo_news (87.5K subscribers) is the daytime channel. It revises a day up to
 * five times, posts tomorrow's table before amending today's — so every post is keyed by the day
 * it names — lists only the subqueues switched off, sometimes stacked one window per line, and
 * edits posts in place ("ОНОВЛЕНО о 20:20").
 *
 * www.zoe.com.ua/outage/ is the round-the-clock one — the operator's words: changes go out "на
 * наших інформаційних ресурсах протягом робочого дня та на нашому сайті … у цілодобовому режимі".
 * Over eight in-season days of 2025–26 the site carried revisions the channel never did (16 Dec
 * 00:26 and 04:41, 10 Apr 22:27, …), revisions that added outages: on the channel alone the app
 * would have said «світло є» for ~600 queue-minutes when the operator said otherwise. Each site
 * version is its own post restating the day, its time only in the title ("(оновлено 21:26)",
 * "(оновлено о 21-35)", "(20:13)"), with no date.
 *
 * The two are combined half-hour by half-hour, off over possible over on. Their texts sometimes
 * disagree on the same revision, and the site's times carry no date, so "newest wins" could pick
 * the lighter one; the union never says light where either says dark (it over-warns ~370
 * queue-minutes over the same days, a charged power bank against a spoiled fridge).
 *
 * Either outlet alone still publishes: the site answers only Ukrainian addresses (the GitHub
 * fallback gets the channel only), and sends its certificate without the intermediate, which is
 * supplied from certs/ for that one request.
 */
const SITE = 'https://www.zoe.com.ua/outage/';
const CHANNEL = 'Zaporizhzhyaoblenergo_news';
const INTERMEDIATE = readFileSync(new URL('../certs/certum-dv-tls-g2-r39-ca.pem', import.meta.url), 'utf8');
const DAY_SECONDS = 86400;

/** "(оновлено 21:26)", "(оновлено о 21-35)", "(оновлено об 11:25)", "( оновлено о 20:55)", "(20:13)". */
const STAMP = /\(\s*(?:оновлено\s*(?:об?\s*)?)?(\d{1,2})[:.\-](\d{2})\s*\)/iu;

function plain(fragment) {
  return fragment
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

/**
 * The outage page → posts for `parseGpvPost`, oldest first, each given the moment its version was
 * written. The page lists newest first and its post ids are not chronological, so page order is
 * the only order there is.
 *
 * A title's time has no date: it is on the day the post is about or the day before (a table for
 * the 16th is revised at 23:44 on the 15th). Walking from the newest post back, each takes the
 * later of the two that is neither in the future nor after the post above it — "8 квітня
 * (оновлено 14:18)" is the 8th, not the 7th, and the 15th's 23:44 sits below the 16th's 00:26.
 * A post with no time follows the one before it.
 */
export function parseListing(html, now = new Date()) {
  const articles = [...html.matchAll(/<article id="post-(\d+)"[^>]*>([\s\S]*?)<\/article>/g)];
  // A page with no posts is a changed layout or a block page, not a quiet day.
  if (articles.length === 0) throw new Error('no posts on the outage page');

  const items = [];
  for (const [, id, body] of articles) {
    const title = plain(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(body)?.[1] ?? '');
    const content = plain(/<div class="content">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? '');
    const stamp = STAMP.exec(title);
    // The stamp is taken out before parsing, so "(оновлено о 20:55)" is not read again as an
    // in-place edit of whatever day it happens to fall on.
    const text = `${title.replace(STAMP, '').trim()}\n${content}`;
    const subject = dayOfPost({ id: Number(id), postedAt: now.toISOString(), text });
    if (subject) items.push({ id: Number(id), text, subject, stamp, at: null });
  }

  // Newest first, as the page lists them.
  let upper = now.getTime() + 5 * 60_000;
  for (const item of items) {
    if (!item.stamp) continue;
    const minutes = Number(item.stamp[1]) * 60 + Number(item.stamp[2]);
    const fits = [item.subject.epoch, item.subject.epoch - DAY_SECONDS]
      .map((epoch) => (epoch + minutes * 60) * 1000)
      .find((candidate) => candidate <= upper);
    if (fits === undefined) continue;
    item.at = fits;
    upper = fits;
  }

  const posts = [];
  let previous = null;
  for (const item of items.reverse()) {
    let at = item.at ?? (previous === null ? (item.subject.epoch - DAY_SECONDS / 2) * 1000 : previous + 1000);
    if (previous !== null && at <= previous) at = previous + 1000;
    previous = at;
    posts.push({ id: item.id, postedAt: new Date(at).toISOString(), text: item.text });
  }
  return posts;
}

export async function fetchRegion(region, now = new Date(), {
  fetchSite = () => getTextTrusting(SITE, { intermediate: INTERMEDIATE }),
  fetchTelegram = () => fetchChannel(CHANNEL)
} = {}) {
  const [site, channel] = await Promise.allSettled([
    fetchSite().then((html) => parseListing(html, now)),
    fetchTelegram()
  ]);
  if (site.status === 'rejected' && channel.status === 'rejected') {
    throw new Error(`site: ${site.reason.message}; channel: ${channel.reason.message}`);
  }
  if (site.status === 'rejected') console.warn(`[zaporizhzhia] site: ${site.reason.message}; channel only`);
  if (channel.status === 'rejected') console.warn(`[zaporizhzhia] channel: ${channel.reason.message}; site only`);

  const since = kyivDayStart(now) - DAY_SECONDS;
  const readings = [
    site.status === 'fulfilled' ? mergeVersions(site.value.map(parseGpvPost).filter(Boolean), { since }) : null,
    channel.status === 'fulfilled' ? scheduleFromPosts(channel.value, { since }) : null
  ].filter(Boolean);

  const halves = unionHalves(...readings.map((reading) => reading.halves));
  const seen = new Set(readings.flatMap((reading) => reading.queues));
  const update = readings.map((reading) => reading.update).filter(Boolean)
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: { ...queueNames(NATIONAL_QUEUES), ...queueNames([...seen].map((key) => key.replace(/^GPV/, ''))) },
    fact: factFromHalves(halves),
    todayEpoch: kyivDayStart(now),
    update,
    source: 'zaporizhzhia'
  });
}
