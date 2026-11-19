import { readFileSync } from 'node:fs';
import {
  fetchChannel, parseGpvPost, dayOfPost, mergeVersions, slotWithin, unionHalves, factFromHalves, closingDiv
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
 *
 * The same page says when Укренерго's emergency schedules are in force and when they are lifted
 * (`readSiteEmergency`): that is where the region's «Аварійні відключення» comes from.
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

/** The page's posts as it lists them, newest first: each one's number, title and text. */
function articlesOf(html) {
  const articles = [...html.matchAll(/<article id="post-(\d+)"[^>]*>([\s\S]*?)<\/article>/g)];
  // A page with no posts is a changed layout or a block page, not a quiet day.
  if (articles.length === 0) throw new Error('no posts on the outage page');
  return articles.map(([, id, body]) => {
    const title = plain(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(body)?.[1] ?? '');
    // The body up to the </div> that closes it, not the first one inside it: a table pasted as
    // <div> rows ended at its first row, and every subqueue after it read as light.
    const open = /<div class="content">/.exec(body);
    const end = open ? closingDiv(body, open.index + open[0].length) : -1;
    const content = open ? plain(body.slice(open.index + open[0].length, end === -1 ? undefined : end)) : '';
    return { id: Number(id), title, content };
  });
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
  const items = [];
  for (const { id, title, content } of articlesOf(html)) {
    const stamp = STAMP.exec(title);
    // The stamp is taken out before parsing, so "(оновлено о 20:55)" is not read again as an
    // in-place edit of whatever day it happens to fall on.
    const text = `${title.replace(STAMP, '').trim()}\n${content}`;
    const subject = dayOfPost({ id, postedAt: now.toISOString(), text });
    if (subject) items.push({ id, text, subject, stamp, at: null });
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

// «УВАГА! ДІЮТЬ ГРАФІКИ АВАРІЙНИХ ВІДКЛЮЧЕНЬ (оновлено о 06:05)», «… СПЕЦІАЛЬНІ ГРАФІКИ АВАРІЙНИХ ВІДКЛЮЧЕНЬ – СКАСОВАНО! (оновлено о 22:30)».
const ORDER_TITLE = /аварійн\S*\s+відключен|(?<![\p{L}])С?ГАВ(?![\p{L}])/iu;
// Two orders, started and lifted apart: «графіки аварійних відключень (ГАВ)» and «спеціальні графіки аварійних відключень (СГАВ)».
const SCHEDULES = /(спеціальн\S*\s+)?графік\S*\s+аварійн\S*\s+відключен/giu;
const SPECIAL = /(?<![\p{L}])СГАВ(?![\p{L}])/iu;
const ORDINARY = /(?<![\p{L}])ГАВ(?![\p{L}])/iu;
const LIFTED = /скасован|припинен/iu;
const IN_FORCE = /діють|запроваджен|застосов|введен/iu;
// The operator's sentence, from its verb on: «запроваджено у повному обсязі графіки аварійних відключень (ГАВ)».
const SAID = /(?:запроваджен|застосов|введен)[^.\n]*/iu;
/** The site lifts every order it starts, in a post of its own; one left standing longer than this was not lifted there. */
const ORDER_MAX_AGE_MS = 36 * 3600 * 1000;

/** Which of the two orders a title is about; both, when it names neither. */
function ordersOf(title) {
  const named = new Set();
  for (const match of title.matchAll(SCHEDULES)) named.add(match[1] ? 'special' : 'ordinary');
  if (SPECIAL.test(title)) named.add('special');
  if (ORDINARY.test(title)) named.add('ordinary');
  return named.size ? [...named] : ['ordinary', 'special'];
}

/** The latest moment at `minutes` past a Kyiv midnight that is not after `upper`. */
function lastBefore(minutes, upper) {
  let day = kyivDayStart(new Date(upper));
  for (let back = 0; back < 2; back++) {
    const candidate = (day + minutes * 60) * 1000;
    if (candidate <= upper) return candidate;
    day = kyivDayStart(new Date(day * 1000 - 3600 * 1000));
  }
  return null;
}

/**
 * The outage page → whether Укренерго's emergency schedules are in force in the oblast right now.
 *
 * Between its tables the page carries the operator's word on them, each in a post of its own: «УВАГА! ДІЮТЬ ГРАФІКИ АВАРІЙНИХ
 * ВІДКЛЮЧЕНЬ (оновлено о 06:05)» — «запроваджено у повному обсязі графіки аварійних відключень (ГАВ)» — and, when the order ends,
 * «УВАГА! ГРАФІКИ АВАРІЙНИХ ВІДКЛЮЧЕНЬ (ГАВ) – СКАСОВАНО! (оновлено о 00:45)». The special ones (СГАВ, «в обсязі 3 черг») are a
 * second order beside the first, started and lifted on its own; either one in force is the region's «Аварійні відключення».
 *
 * On 17 November 2026 both stood from 06:05 to 19:36 and four letters came in, 09:46 to 15:37, from queues the table had in the
 * light: the hours on the screen were the operator's, and nothing on it said they did not hold. The channel is not read for this:
 * it announces an order but not its end at night (lifted at 22:30 and 00:45 on the 16th–17th, on the site only).
 *
 * A title's time has no date, as a table's has none. Walking down from the newest post, each takes the latest such time that is
 * not after the post above it; the tables between them, which do name their day, keep that honest to within a day. So an order is
 * never read as older than it is, and `maxAgeMs` drops one the page has carried for a day and a half with nothing to lift it.
 *
 * @returns {{ active: boolean, since: string|null, note: string|null }|null} `null` when the page has no such post at all: it
 *   says nothing either way, and what phones have stays (an order's post can leave the first page while the order stands).
 */
export function readSiteEmergency(html, now = new Date(), { maxAgeMs = ORDER_MAX_AGE_MS } = {}) {
  const latest = {};
  let upper = now.getTime() + 5 * 60_000;
  for (const { id, title, content } of articlesOf(html)) {
    const stamp = STAMP.exec(title);
    if (!stamp) continue;
    const minutes = Number(stamp[1]) * 60 + Number(stamp[2]);
    if (!ORDER_TITLE.test(title)) {
      // A table: it only says how late the posts under it can be.
      const subject = dayOfPost({ id, postedAt: now.toISOString(), text: `${title.replace(STAMP, '').trim()}\n${content}` });
      const fits = subject && [subject.epoch, subject.epoch - DAY_SECONDS]
        .map((epoch) => (epoch + minutes * 60) * 1000)
        .find((candidate) => candidate <= upper);
      if (fits) upper = fits;
      continue;
    }
    const at = lastBefore(minutes, upper);
    if (at === null) continue;
    upper = at;
    const heading = title.replace(STAMP, '');
    const lifted = LIFTED.test(heading) || (!IN_FORCE.test(heading) && LIFTED.test(content));
    if (!lifted && !IN_FORCE.test(heading) && !IN_FORCE.test(content)) continue;
    const orders = ordersOf(heading);
    const post = { id, at, on: !lifted, orders, said: lifted ? null : SAID.exec(content)?.[0].trim().replace(/\s+/g, ' ') ?? null };
    // Newest first: the first post about an order is the last word on it.
    for (const order of orders) latest[order] ??= post;
  }

  const known = Object.values(latest);
  if (known.length === 0) return null;
  const standing = Object.entries(latest)
    .filter(([, post]) => post.on && now.getTime() - post.at <= maxAgeMs)
    .sort(([, a], [, b]) => a.at - b.at);
  if (standing.length === 0) return { active: false, since: null, note: null };
  // The operator's words, and only while they are true: a post that started both orders says too much once one of them is lifted.
  const whole = (post) => post.said && post.orders.every((order) => latest[order] === post);
  const posts = [...new Set(standing.map(([, post]) => post))];
  const note = posts.every(whole) ? posts.map((post) => post.said).join('; ') : null;
  return { active: true, since: new Date(standing[0][1].at).toISOString(), note };
}

/**
 * The region's snapshot with what the page says of the emergency schedules. Without a word from the page — it did not answer, or
 * carries no such post — the warning phones already have stays for the rest of its day, marked as carried: it is what they have,
 * not a second look.
 */
function withSiteEmergency(snapshot, region, reading, now) {
  const today = kyivDayStart(now);
  if (!reading) {
    const held = (region.previous?.fact?.emergency ?? []).map(Number).filter((day) => day >= today);
    if (!held.length) return snapshot;
    const note = region.previous.fact.emergencyNote;
    return markCarried({ ...snapshot, fact: { ...snapshot.fact, emergency: held, ...(note ? { emergencyNote: note } : {}) } }, ['emergency']);
  }
  if (!reading.active) return snapshot;
  console.log(`[emergency] ${region.id}: emergency since ${reading.since}${reading.note ? ` (${reading.note})` : ''}`);
  return { ...snapshot, fact: { ...snapshot.fact, emergency: [today], ...(reading.note ? { emergencyNote: reading.note } : {}) } };
}

/**
 * The channel's reading without the half-hours in which it only repeats a state of the site's table that the site has since replaced.
 *
 * The union of the two outlets never says light where either says dark — right while they are two tellings of the same
 * revision, wrong once one of them is simply old. On 14 November 2026 the channel still carried the evening's table for the day
 * (its only post, 21:47 the night before) while the site revised it at 23:02, 00:31, 05:11, 06:09, 06:46, 08:01 and 09:26, each
 * time with fewer hours dark; the union kept every hour of the evening's table, and at 08:18 queue 5.2 was «05:30–10:30» on the
 * screen with the light on at home and no such cut in the operator's table since 06:09.
 *
 * The first rule left a day of the channel's out when it was, half-hour for half-hour, one of the site's own tables with a later
 * one after it — which holds only while the channel has one post for the day. On 19 November 2026 it had two: the evening's
 * table and the 05:42 «оновлено ГПВ», since edited in place to the site's 07:52 version (the channel edits posts in place, so a
 * post's time says little). Laid over one another they were no single table the site ever had, nothing was left out, and when
 * the site moved 4.1 from «14:30–19:30» to «16:30–19:30» at 14:09 the screen kept 14:30: a person wrote at 14:49 with the light on.
 *
 * So the day is compared as the app is given it — versions laid over one another (lib/telegram.mjs, `mergeVersions`) — with the
 * site's day as it stood before each of its revisions, and only from the half-hour that revision went out: a revision speaks of
 * what is still ahead, and what the two outlets said of the hours before it is history either way. Where the channel says, of
 * everything from that half-hour on, exactly what the site said until then, it is that older state, and from there the site's
 * newer word stands alone. The hours before stay united, as they were shown. A table the site never had — a revision only the
 * channel made, or the same revision told differently — is united with the site's as before.
 */
export function withoutSuperseded(channelReading, siteVersions) {
  const halves = { ...channelReading.halves };
  let cuts = 0;
  for (const [epoch, day] of Object.entries(channelReading.halves ?? {})) {
    const versions = siteVersions
      .filter((version) => String(version.epoch) === String(epoch))
      .sort((a, b) => a.at - b.at || a.id - b.id);
    let cut = 48;
    for (let index = 1; index < versions.length; index++) {
      const from = slotWithin(Number(epoch), Date.parse(versions[index].postedAt));
      if (from >= cut) continue;
      const before = mergeVersions(versions.slice(0, index), { since: Number(epoch) }).halves[epoch];
      if (before && sameFrom(before, day, from)) cut = from;
    }
    if (cut === 48) continue;
    halves[epoch] = Object.fromEntries(Object.entries(day).map(([queue, slots]) =>
      [queue, slots.map((state, slot) => (slot >= cut ? 'on' : state))]));
    cuts++;
  }
  return cuts ? { ...channelReading, halves } : channelReading;
}

/** Two tellings of one day that say the same of every queue either of them names, from half-hour `from` on. */
function sameFrom(a, b, from) {
  for (const queue of new Set([...Object.keys(a), ...Object.keys(b)])) {
    for (let slot = from; slot < 48; slot++) if ((a[queue]?.[slot] ?? 'on') !== (b[queue]?.[slot] ?? 'on')) return false;
  }
  return true;
}

export async function fetchRegion(region, now = new Date(), {
  fetchSite = () => getTextTrusting(SITE, { intermediate: INTERMEDIATE }),
  fetchTelegram = () => fetchChannel(CHANNEL)
} = {}) {
  const [site, channel] = await Promise.allSettled([
    fetchSite().then((html) => ({ posts: parseListing(html, now), emergency: readSiteEmergency(html, now) })),
    fetchTelegram()
  ]);
  if (site.status === 'rejected' && channel.status === 'rejected') {
    throw new Error(`site: ${site.reason.message}; channel: ${channel.reason.message}`);
  }
  if (site.status === 'rejected') console.warn(`[zaporizhzhia] site: ${site.reason.message}; channel only`);
  if (channel.status === 'rejected') console.warn(`[zaporizhzhia] channel: ${channel.reason.message}; site only`);

  const since = kyivDayStart(now) - DAY_SECONDS;
  const siteVersions = site.status === 'fulfilled' ? site.value.posts.map(parseGpvPost).filter(Boolean) : null;
  // Without the site this cycle, what phones already have stands in for it (below), and of the channel only what it has posted
  // since the table phones have: an older post of its is in that table already — or was left out of it as a state the site had
  // replaced (`withoutSuperseded`), and one cycle without the site must not bring its dark hours back for a cycle.
  const leaned = site.status === 'rejected' && region.previous?.fact?.data && !Array.isArray(region.previous.fact.data);
  const held = leaned ? stampTime(region.previous.fact.update) : NaN;
  const channelVersions = channel.status === 'fulfilled'
    ? channel.value.map(parseGpvPost).filter(Boolean).filter((version) => Number.isNaN(held) || version.at > held)
    : null;
  const channelReading = channelVersions ? mergeVersions(channelVersions, { since }) : null;
  const readings = [
    siteVersions ? mergeVersions(siteVersions, { since }) : null,
    channelReading && siteVersions ? withoutSuperseded(channelReading, siteVersions) : channelReading
  ].filter(Boolean);
  // Without the site this cycle, what phones already have stands in for it. Publishing the channel
  // alone turned every hour only the site called dark back to light for one cycle and dark again
  // the next — a wake-up for the whole oblast each way, and «світло є» in between. The cost is that
  // a dark hour the channel later cancels stays dark until the site answers or the day is over.
  // The site is the table itself, so such a read is no fresh look at the region at all (carried.mjs).
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
  const warned = withSiteEmergency(snapshot, region, site.status === 'fulfilled' ? site.value.emergency : null, now);
  return leaned ? markCarried(warned, true) : warned;
}
