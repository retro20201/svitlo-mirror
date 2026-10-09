import { readFileSync } from 'node:fs';
import {
  fetchChannel, scheduleFromPosts, parseGpvPost, dayOfPost, mergeVersions, unionHalves, factFromHalves, closingDiv
} from '../lib/telegram.mjs';
import { getTextTrusting } from '../lib/https-ca.mjs';
import { buildSnapshot, halvesFromHours, kyivDayStart, queueNames, stampTime, NATIONAL_QUEUES } from '../lib/canonical.mjs';
import { markCarried } from '../lib/carried.mjs';

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
    // Rows pasted from Facebook come as <div dir="auto">1.1: …</div>, one per line.
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<div[^>]*>|<\/li>/gi, '\n')
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
    // The body up to the </div> that closes it, not the first one inside it: a table pasted as
    // <div> rows ended at its first row, and every subqueue after it read as light.
    const open = /<div class="content">/.exec(body);
    const end = open ? closingDiv(body, open.index + open[0].length) : -1;
    const content = open ? plain(body.slice(open.index + open[0].length, end === -1 ? undefined : end)) : '';
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
    // A post with no time is placed no earlier than noon the day before its subject: chained only
    // from the post before it, a first table could inherit a time days old and be refused as
    // implausibly far from the day it names.
    let at = item.at ?? Math.max(previous === null ? -Infinity : previous + 1000, (item.subject.epoch - DAY_SECONDS / 2) * 1000);
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
  // Without the site this cycle, what phones already have stands in for it. Publishing the channel
  // alone turned every hour only the site called dark back to light for one cycle and dark again
  // the next — a wake-up for the whole oblast each way, and «світло є» in between. The cost is that
  // a dark hour the channel later cancels stays dark until the site answers or the day is over.
  // The site is the table itself, so such a read is no fresh look at the region at all (carried.mjs).
  const leaned = site.status === 'rejected' && region.previous?.fact?.data && !Array.isArray(region.previous.fact.data);
  if (leaned) {
    const kept = {};
    for (const [epoch, queues] of Object.entries(region.previous.fact.data)) {
      if (Number(epoch) < since) continue;
      kept[epoch] = Object.fromEntries(Object.entries(queues).map(([key, hours]) => [key, halvesFromHours(hours)]));
    }
    readings.push({ halves: kept, queues: Object.keys(Object.values(kept)[0] ?? {}), update: region.previous.fact.update ?? null });
  }

  const halves = unionHalves(...readings.map((reading) => reading.halves));
  const seen = new Set(readings.flatMap((reading) => reading.queues));
  const update = readings.map((reading) => reading.update).filter(Boolean)
    .sort((a, b) => stampTime(a) - stampTime(b)).at(-1) ?? null;

  const snapshot = buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: { ...queueNames(NATIONAL_QUEUES), ...queueNames([...seen].map((key) => key.replace(/^GPV/, ''))) },
    fact: factFromHalves(halves),
    todayEpoch: kyivDayStart(now),
    update,
    source: 'zaporizhzhia'
  });
  return leaned ? markCarried(snapshot, true) : snapshot;
}
