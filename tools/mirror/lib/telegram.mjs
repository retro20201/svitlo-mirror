import { getText } from './http.mjs';
import {
  buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES
} from './canonical.mjs';

/**
 * Reading ГПВ tables off the operators' own public Telegram channels.
 *
 * Харків and Запоріжжя answer only Ukrainian IPs, Черкаси's site re-posts the channel, and
 * Кіровоград serves its table over a tokenised POST — but each operator broadcasts the same tables
 * to tens of thousands of subscribers on an official channel. That broadcast is the route: it is
 * the operator publishing to citizens, and reading it circumvents nothing.
 *
 * `https://t.me/s/<channel>` is Telegram's *preview page* — public HTML meant for search engines
 * and link previews, not a documented API, and t.me serves no robots.txt at all (404). It carries
 * no rate limit we could rely on either, so an adapter must be satisfied with one request per
 * poll: the last page holds ~20 posts, which during the season is two to four days of tables.
 * If Telegram ever moves this markup the hardened replacement is MTProto (a real client session
 * against the same public channel), not a heavier scrape of the preview.
 */
const PREVIEW_BASE = 'https://t.me/s';

/** Genitive month names — the only form these posts use ("у неділю, 9 листопада"). */
const MONTHS = new Map([
  ['січня', 1], ['лютого', 2], ['березня', 3], ['квітня', 4], ['травня', 5], ['червня', 6],
  ['липня', 7], ['серпня', 8], ['вересня', 9], ['жовтня', 10], ['листопада', 11], ['грудня', 12]
]);

/**
 * `1.1`, optionally several of them merged into one row ("2.1, 2.2 не вимикаються"), optionally
 * behind an emoji and the word itself ("⚡ Черга 1.1" — Запоріжжя, April 2026).
 */
const QUEUE_ROW = /^\s*(?:[^\p{L}\p{N}\s]+\s*)?(?:(?:під)?черг[аи]\s+)?((?:[1-6]\.[12](?:\s*[,;]\s*)?)+)\s*:?\s*(.*)$/iu;
const RANGE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;
/**
 * Кропивницький's rows: whole hours with no minutes, "Черга 1.1: 00-01, 02-04, 15:30-18:00", and
 * a lone "-" for a subqueue that stays on. Hours are only read that way on a row that holds
 * nothing else, so a house range in an address list ("вул. Соборна 1-17") is never a window.
 */
const HOURS_ONLY = /^\s*(?:\d{1,2}(?::\d{2})?\s*-\s*\d{1,2}(?::\d{2})?\s*[,;]?\s*)+$/;
const BARE_HOUR = /(?<![\d:])(\d{1,2})(?![\d:])/g;
const STAYS_ON = /^\s*-\s*$/;

/** A line holding nothing but one window — the second line of a stacked "⚡ Черга 1.1" row. */
const RANGE_ONLY = /^\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*[,;]?\s*$/;

/**
 * The line every one of these operators puts above a table. Since spring 2026 they list only the
 * subqueues that are switched off ("Решта черг/ підчерг у ГПВ не задіяна"), so under this header
 * a single row is a whole day's table.
 */
const TABLE_HEADER = /Години\s+відсутності\s+електропостачання|Час\s+відключень\s+для\s+черг/i;

/**
 * Without that header a post has to look like a whole day before it is believed — the stacked
 * layout carries no header, and twelve labelled hours are not something a news post does by
 * accident.
 */
const MIN_ROWS = 8;

/**
 * A post withdrawing hours rather than adding them: "Графіки погодинних відключень … скасовано до
 * 14:00" (Харків), "застосування графіків погодинних відключень (ГПВ) не заплановано" and "…від
 * НЕК «Укренерго» НЕ НАДХОДИЛО" (Запоріжжя). Only ГПВ counts: the same channels cancel ГАВ, which
 * this schedule never carried.
 */
const WITHDRAWN = /(?:ГПВ|погодинн)[^\n]{0,160}?(?:скасован\S*(?:\s+до\s+(\d{1,2}):(\d{2}))?|не\s+заплановано|не\s+надходило)/iu;

/** A dateless post that is still plainly about the day it went out. */
const SAME_DAY = /сьогодні|замінено\s+на\s+графік|скасовано\s+до\s+\d/i;

/** "ОНОВЛЕНО 03.04.2026 О 11:46", "ОНОВЛЕНО о 20:20" — a post edited in place to a later version. */
const REVISED = /оновлено\s+(?:(\d{2})\.(\d{2})\.(\d{4})\s+)?о\s+(\d{1,2}):(\d{2})/iu;

const NATIONAL_KEYS = NATIONAL_QUEUES.map((queue) => `GPV${queue}`);

const DAY_SECONDS = 86400;

/** How far ahead of (or behind) a post its subject day may plausibly be. */
const MAX_LEAD_DAYS = 3;

/** One page of a public channel's preview, newest last. `before`/`after` page through the archive. */
export async function fetchChannel(channel, { before = null, after = null } = {}) {
  const query = before ? `?before=${before}` : after ? `?after=${after}` : '';
  return parsePosts(await getText(`${PREVIEW_BASE}/${channel}${query}`), channel);
}

/**
 * Preview HTML → `[{ id, postedAt, text, photos }]` for the posts that carry photos: the picture
 * operators post when their table exists only as an image. `photos` are Telegram's CDN URLs,
 * signed and short-lived, so they are fetched in the same run that reads the page.
 */
export function parsePhotoPosts(html) {
  return html.split('<div class="tgme_widget_message_wrap').slice(1).flatMap((wrap) => {
    const photos = [...wrap.matchAll(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/g)].map((m) => m[1]);
    const [post] = parsePosts(wrap);
    return photos.length && post ? [{ ...post, photos }] : [];
  });
}

/** One page of a public channel's preview, raw — for adapters that need more than the text. */
export async function fetchChannelPage(channel, { before = null } = {}) {
  return getText(`${PREVIEW_BASE}/${channel}${before ? `?before=${before}` : ''}`);
}

/** Preview HTML → `[{ channel, id, postedAt, text }]`. */
export function parsePosts(html, channel = '') {
  const marks = [...html.matchAll(/data-post="[^"]*?\/(\d+)"/g)];
  const opening = /<div class="tgme_widget_message_text[^"]*"[^>]*>/g;
  const posts = [];

  let match;
  while ((match = opening.exec(html))) {
    const start = opening.lastIndex;
    const end = closingDiv(html, start);
    if (end < 0) break;
    opening.lastIndex = end;

    // The id sits on the message wrapper, above the text; the timestamp in the footer, below it.
    const mark = marks.filter((entry) => entry.index < match.index).pop();
    const postedAt = (html.slice(end).match(/<time[^>]+datetime="([^"]+)"/) || [])[1];
    if (!mark || !postedAt) continue;

    posts.push({ channel, id: Number(mark[1]), postedAt, text: toPlainText(html.slice(start, end)) });
  }
  return posts;
}

/**
 * One post → the day it describes and that day's hours, or `null` when it is not a ГПВ table.
 *
 * Most posts on these channels are news, ГОП notices for industry, or address lists that happen to
 * carry queue labels; only a real table survives the gates below. A table names the queues that
 * switch off; every other national subqueue stays on that day, and is published as such, because
 * "not listed" is the operator's way of saying so and "no schedule" would read as a failure.
 *
 * A post that withdraws hours instead comes back with `withdrawn` set: the slots it switches back
 * on, from the moment it went out until `until`.
 */
export function parseGpvPost(post) {
  return parseVersion(post);
}

/** The shared front half of `parseGpvPost`: the day a post names and when its version was written. */
export function dayOfPost(post) {
  const text = normalise(post.text);
  const postedAt = new Date(post.postedAt);
  const target = targetDate(text, postedAt) ?? (SAME_DAY.test(text) ? postedAt : null);
  if (!target) return null;
  return { id: post.id, postedAt: post.postedAt, at: revisedAt(text, postedAt), epoch: kyivDayStart(target) };
}

function parseVersion(post) {
  const text = normalise(post.text);
  if (!/ГПВ|погодинн/i.test(text)) return null;

  const postedAt = new Date(post.postedAt);
  const target = targetDate(text, postedAt) ?? (SAME_DAY.test(text) ? postedAt : null);
  if (!target) return null;

  const at = revisedAt(text, postedAt);
  const version = { id: post.id, postedAt: post.postedAt, at, epoch: kyivDayStart(target) };

  const halves = {};
  let rows = 0;
  for (const line of stackRows(text.split('\n'))) {
    const row = QUEUE_ROW.exec(line);
    if (!row) continue;

    const spec = HOURS_ONLY.test(row[2]) ? row[2].replace(BARE_HOUR, '$1:00') : row[2];
    const ranges = [...spec.matchAll(RANGE)];
    // "не вимикається" / "не вимикаються" / "-" is the operator stating this queue stays on —
    // quite different from an address list, which carries the same label and nothing else at all.
    const stated = ranges.length > 0 || /не\s+вимика/i.test(spec) || STAYS_ON.test(spec);
    if (!stated) continue;

    for (const label of row[1].match(/[1-6]\.[12]/g) ?? []) {
      halves[`GPV${label}`] ??= Array(48).fill('on');
      for (const [, h1, m1, h2, m2] of ranges) markOff(halves[`GPV${label}`], +h1, +m1, +h2, +m2);
      rows++;
    }
  }
  if (rows === 0 || (rows < MIN_ROWS && !TABLE_HEADER.test(text))) {
    const withdrawn = rows === 0 ? WITHDRAWN.exec(text) : null;
    if (!withdrawn) return null;
    const until = withdrawn[1] ? Math.ceil((+withdrawn[1] * 60 + +withdrawn[2]) / 30) : 48;
    return { ...version, withdrawn: { until: Math.min(48, until) } };
  }

  for (const key of NATIONAL_KEYS) halves[key] ??= Array(48).fill('on');
  return { ...version, halves, queues: hoursOf(halves) };
}

/**
 * Posts → canonical `fact`, the queue keys seen, and the operator's own newest timestamp.
 *
 * A day's table is revised repeatedly — Запоріжжя published five versions of 13 грудня between
 * 05:18 and 17:46, and posted 11 грудня's plan an hour *before* amending 10 грудня's. So "the
 * newest post" is not "today's table": every post is keyed by the date it names.
 *
 * And a revision speaks only from the moment it goes out. Черкаси's 21:01 "Оновлений графік" for
 * 9 квітня lists the windows still ongoing or ahead, nothing that already happened; Запоріжжя's
 * 17:32 one for 1 липня keeps only 4.1, the others having been and gone. So the first table of a
 * day lays down all of it, and each later version overwrites from its own half-hour onward —
 * replacing the whole day with the newest post erased the morning's outages from the timeline.
 */
export function scheduleFromPosts(posts, { since = kyivDayStart() - DAY_SECONDS } = {}) {
  return mergeVersions(posts.map(parseGpvPost).filter(Boolean), { since });
}

/**
 * Versions of days → canonical `fact`. A version is `{ id, postedAt, at, epoch, halves }` (a table),
 * `{ …, withdrawn: { until } }`, or `{ …, delta: [{ key, from, to, state }] }` (an amendment); `at` orders them, `postedAt` is when each took effect. Shared
 * by every adapter that reads a channel, whether the table came as text or as a picture.
 */
export function mergeVersions(list, { since = kyivDayStart() - DAY_SECONDS } = {}) {
  const versions = new Map();
  for (const parsed of list) {
    if (parsed.epoch < since) continue;
    if (!versions.has(parsed.epoch)) versions.set(parsed.epoch, []);
    versions.get(parsed.epoch).push(parsed);
  }

  const fact = {};
  const halves = {};
  const queues = new Set();
  let update = null;
  for (const epoch of [...versions.keys()].sort((a, b) => a - b)) {
    let day = null;
    for (const version of versions.get(epoch).sort((a, b) => a.at - b.at || a.id - b.id)) {
      // A withdrawal or an amendment with nothing published before it has no table to change.
      if ((version.withdrawn || version.delta) && !day) continue;
      if (version.delta) {
        // A free-text amendment (Чернігів): only the half-hours it names change; off outranks
        // possible, and possible never lightens an off.
        for (const { key, from, to, state } of version.delta) {
          day[key] ??= Array(48).fill('on');
          for (let slot = from; slot < to; slot++) {
            if (state === 'off' || day[key][slot] === 'on') day[key][slot] = state;
          }
        }
        if (!update || version.at > update.at) update = version;
        continue;
      }
      // Ordered by when the version was written, but in force from when the post went out: an
      // edit restates the post, and the post has been the operator's word since then.
      const from = day ? slotWithin(epoch, Date.parse(version.postedAt)) : 0;
      day ??= {};
      if (version.withdrawn) {
        for (const slots of Object.values(day)) slots.fill('on', from, Math.max(from, version.withdrawn.until));
      } else {
        for (const key of new Set([...Object.keys(day), ...Object.keys(version.halves)])) {
          day[key] ??= Array(48).fill('on');
          for (let slot = from; slot < 48; slot++) day[key][slot] = version.halves[key]?.[slot] ?? 'on';
        }
      }
      if (!update || version.at > update.at) update = version;
    }
    if (!day) continue;
    fact[epoch] = hoursOf(day);
    halves[epoch] = day;
    for (const key of Object.keys(day)) queues.add(key);
  }
  return {
    fact,
    // The same days as half-hours, for an adapter that has two sources to combine (Запоріжжя).
    halves,
    queues: [...queues].sort(),
    update: update && (update.at === Date.parse(update.postedAt) ? update.postedAt : new Date(update.at).toISOString())
  };
}

const RANK = { on: 0, possible: 1, off: 2 };

/**
 * Two readings of the same days, as half-hours, combined slot by slot: off over possible over on.
 * For an operator with two outlets that each miss revisions the other carries, a half-hour either
 * calls dark is dark — the wrong way to be wrong costs a fridge, the other a power bank.
 */
export function unionHalves(...sources) {
  const days = {};
  for (const source of sources) {
    for (const [epoch, queues] of Object.entries(source ?? {})) {
      days[epoch] ??= {};
      for (const [key, slots] of Object.entries(queues)) {
        const into = (days[epoch][key] ??= Array(48).fill('on'));
        slots.forEach((state, slot) => { if (RANK[state] > RANK[into[slot]]) into[slot] = state; });
      }
    }
  }
  return days;
}

/** Days of half-hours → canonical `fact`. */
export function factFromHalves(days) {
  return Object.fromEntries(Object.entries(days).map(([epoch, queues]) => [epoch, hoursOf(queues)]));
}

/** Half-hour slots → canonical hour states. */
function hoursOf(halves) {
  const queues = {};
  for (const [key, slots] of Object.entries(halves)) {
    const hours = {};
    for (let hour = 1; hour <= 24; hour++) {
      hours[String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
    }
    queues[key] = hours;
  }
  return queues;
}

/**
 * The half-hour of day `epoch` that a version takes effect in: 0 if it went out before the day
 * began, 48 if after it ended. Read off the Kyiv wall clock, so the 25-hour day in October counts
 * its slots the way the operator's table does.
 */
function slotWithin(epoch, at) {
  const day = kyivDayStart(new Date(at));
  if (day < epoch) return 0;
  if (day > epoch) return 48;
  const [hour, minute] = KYIV_CLOCK.format(new Date(at)).split(':').map(Number);
  return Math.floor((hour * 60 + minute) / 30);
}

const KYIV_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

/**
 * When the version in a post was written. Запоріжжя edit posts in place — #3085 went out at 09:23
 * and carries "ОНОВЛЕНО о 20:20" — so the edit time, when the post states one, orders it among the
 * others. A stated time before the post itself is a typo and is ignored.
 */
function revisedAt(text, postedAt) {
  const posted = postedAt.getTime();
  const stated = REVISED.exec(text);
  if (!stated) return posted;
  const [, day, month, year, hour, minute] = stated;
  const date = day ? new Date(Date.UTC(+year, +month - 1, +day, 12)) : postedAt;
  const revised = (kyivDayStart(date) + +hour * 3600 + +minute * 60) * 1000;
  return revised > posted ? revised : posted;
}

/**
 * "⚡ Черга 2.2\n з 13:30 до 16:30\n з 23:30 до 24:00" → "⚡ Черга 2.2, 13:30-16:30, 23:30-24:00":
 * windows stacked under their label are folded back onto its row.
 */
function stackRows(lines) {
  const rows = [];
  for (const line of lines) {
    if (rows.length && RANGE_ONLY.test(line) && QUEUE_ROW.test(rows.at(-1))) rows[rows.length - 1] += `, ${line.trim()}`;
    else rows.push(line);
  }
  return rows;
}

/**
 * The whole of an adapter for an operator that publishes only through Telegram.
 *
 * Queue names fall back to the national 1.1–6.2 scheme rather than to whatever the last post
 * happened to mention: out of season there are no posts at all, and a snapshot with no queues
 * fails validation and is published as degraded. Every oblast on this route runs the national
 * scheme — the full-day tables list all twelve subqueues — so naming them costs nothing and keeps
 * a quiet region honestly "seasonal" instead of broken.
 */
export async function gpvSnapshot({ region, channel, source }) {
  const posts = await fetchChannel(channel);
  const { fact, queues, update } = scheduleFromPosts(posts);

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: {
      ...queueNames(NATIONAL_QUEUES),
      ...queueNames(queues.map((key) => key.replace(/^GPV/, '')))
    },
    fact,
    todayEpoch: kyivDayStart(),
    update,
    source
  });
}

/** Index of the `</div>` that closes the element opened just before `from`. */
export function closingDiv(html, from) {
  const tag = /<div\b|<\/div\b/g;
  tag.lastIndex = from;
  let depth = 1;
  let found;
  while ((found = tag.exec(html))) {
    depth += found[0] === '</div' ? -1 : 1;
    if (depth === 0) return found.index;
  }
  return -1;
}

function toPlainText(fragment) {
  return fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Repairs the typos these posts are actually shipped with. Every rule below was written against a
 * defect observed in the archive, not against a hypothetical one.
 */
function normalise(text) {
  return text
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[\u2013\u2014\u2012\u2212]/g, '-')
    // "з 06: 00 по 22:00" — a stray space after the colon. The lookbehind protects the queue
    // label, so "2.1: 06:00" is not read as the time "1:06".
    .replace(/(?<![.\d])(\d{1,2}):\s+(\d{2})\b/g, '$1:$2')
    // "00:00 - 02;00". A ';' that separates two ranges always follows a complete time, so
    // requiring a word boundary and no preceding ':' leaves those alone.
    .replace(/(?<!:)\b(\d{1,2});(\d{2})\b/g, '$1:$2')
    // "1.2 07:00:14:00" — the dash between two times typed as a colon.
    .replace(/(\d{1,2}:\d{2}):(\d{1,2}:\d{2})/g, '$1-$2')
    // "з 09:00 до 14:00" — the stacked layout spells a window out in words.
    .replace(/(?<![\p{L}])з\s+(\d{1,2}:\d{2})\s+(?:до|по)\s+(\d{1,2}:\d{2})/gu, '$1-$2')
    // "з 22:30 - 24:00" — the same with a dash (Запоріжжя #3089): left with its "з", a stacked
    // line is no bare window, is not folded onto its row, and the window was lost.
    .replace(/(?<![\p{L}])з\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/gu, '$1-$2');
}

/**
 * Marks a published outage window across the half-hour grid.
 *
 * Ends are rounded outward and starts inward, so a window that touches a half-hour marks the whole
 * of it: over-warning costs a charged power bank, under-warning costs a fridge.
 */
function markOff(slots, startHour, startMinute, endHour, endMinute) {
  const start = Math.floor((startHour * 60 + startMinute) / 30);
  let end = Math.ceil((endHour * 60 + endMinute) / 30);
  // The three spellings of midnight seen in production — "24:00", "23:59" and "00:00" — all land
  // here as an end that is not after the start.
  if (end <= start) end = 48;
  for (let slot = Math.max(0, start); slot < Math.min(48, end); slot++) slots[slot] = 'off';
}

/**
 * The day the post is about, which is rarely the day it was posted.
 *
 * Anything further than `MAX_LEAD_DAYS` from the post is rejected rather than filed: these
 * operators publish a day ahead at most, so a distant date means the operator mistyped the month
 * (Харків announced 17 лютого as "17 січня"), and a table filed under the wrong day is worse than
 * no table at all.
 */
function targetDate(text, postedAt) {
  for (const [, day, word] of text.matchAll(/(\d{1,2})\s+([\p{L}']+)/gu)) {
    const month = MONTHS.get(word.toLowerCase());
    if (!month) continue;
    return plausible(resolveYear(Number(day), month, postedAt), postedAt);
  }
  // Кропивницький name the day only in digits: "За розпорядженням НЕК «Укренерго» 05.02.2026…",
  // Суми with dashes: "на 30-06-2026". A worded date wins when there is one — Запоріжжя's
  // "ОНОВЛЕНО 03.04.2026 О 11:46" dates the edit, not the table.
  const numeric = text.match(/(?<![\d.-])(\d{2})[.-](\d{2})[.-](20\d{2})(?!\d|[.-]\d)/);
  if (!numeric) return null;
  const [, day, month, year] = numeric.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return plausible(date.getUTCDate() === day ? date : null, postedAt);
}

function plausible(resolved, postedAt) {
  const drift = resolved ? Math.abs(resolved - postedAt) / 86400000 : Infinity;
  return drift <= MAX_LEAD_DAYS ? resolved : null;
}

/** Posts name a day without a year, and a 31 грудня post names a day in the next one. */
function resolveYear(day, month, postedAt) {
  const year = postedAt.getUTCFullYear();
  let best = null;
  for (const candidate of [year - 1, year, year + 1].map((y) => new Date(Date.UTC(y, month - 1, day, 12)))) {
    if (candidate.getUTCDate() !== day) continue;
    const distance = Math.abs(candidate - postedAt);
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  return best?.candidate ?? null;
}
