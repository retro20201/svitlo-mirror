import { getText } from './http.mjs';
import {
  buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES
} from './canonical.mjs';

/**
 * Reading ГПВ tables off the operators' own public Telegram channels.
 *
 * Харків, Запоріжжя and Черкаси all put their websites behind Cloudflare or a geo-fence, but each
 * broadcasts the same tables to tens of thousands of subscribers on an official channel. That
 * broadcast is the route: it is the operator publishing to citizens, and reading it circumvents
 * nothing.
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

/** `1.1`, optionally several of them merged into one row: "2.1, 2.2 не вимикаються". */
const QUEUE_ROW = /^\s*((?:[1-6]\.[12](?:\s*[,;]\s*)?)+)\s*:?\s*(.*)$/;
const RANGE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;

/**
 * A published table always lists every subqueue in the oblast. An amendment that named only two
 * or three would, if accepted, silently erase the other nine — so a post has to look like a whole
 * day before it is allowed to replace one.
 */
const MIN_ROWS = 8;

const DAY_SECONDS = 86400;

/** How far ahead of (or behind) a post its subject day may plausibly be. */
const MAX_LEAD_DAYS = 3;

/** One page of a public channel's preview, newest last. `before`/`after` page through the archive. */
export async function fetchChannel(channel, { before = null, after = null } = {}) {
  const query = before ? `?before=${before}` : after ? `?after=${after}` : '';
  return parsePosts(await getText(`${PREVIEW_BASE}/${channel}${query}`), channel);
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
 * carry queue labels; only a real table survives all three gates below.
 */
export function parseGpvPost(post) {
  const text = normalise(post.text);
  if (!/ГПВ|погодинн/i.test(text)) return null;

  const target = targetDate(text, new Date(post.postedAt));
  if (!target) return null;

  const halves = {};
  let rows = 0;
  for (const line of text.split('\n')) {
    const row = QUEUE_ROW.exec(line);
    if (!row) continue;

    const ranges = [...row[2].matchAll(RANGE)];
    // "не вимикається" / "не вимикаються" is the operator stating this queue stays on — quite
    // different from an address list, which carries the same label and nothing else at all.
    const stated = ranges.length > 0 || /не\s+вимика/i.test(row[2]);
    if (!stated) continue;

    for (const label of row[1].match(/[1-6]\.[12]/g) ?? []) {
      halves[`GPV${label}`] ??= Array(48).fill('on');
      for (const [, h1, m1, h2, m2] of ranges) markOff(halves[`GPV${label}`], +h1, +m1, +h2, +m2);
      rows++;
    }
  }
  if (rows < MIN_ROWS) return null;

  const queues = {};
  for (const [key, slots] of Object.entries(halves)) {
    const hours = {};
    for (let hour = 1; hour <= 24; hour++) {
      hours[String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
    }
    queues[key] = hours;
  }
  return { id: post.id, postedAt: post.postedAt, epoch: kyivDayStart(target), queues };
}

/**
 * Posts → canonical `fact`, the queue keys seen, and the operator's own newest timestamp.
 *
 * The one rule that matters here: a day's table is revised repeatedly — Запоріжжя published five
 * versions of 13 грудня between 05:18 and 17:46, and posted 11 грудня's plan an hour *before*
 * amending 10 грудня's. So "the newest post" is not "today's table". Every post is keyed by the
 * date it names, and the newest post wins for that date only.
 */
export function scheduleFromPosts(posts, { since = kyivDayStart() - DAY_SECONDS } = {}) {
  const latest = new Map();
  for (const post of posts) {
    const parsed = parseGpvPost(post);
    if (!parsed || parsed.epoch < since) continue;
    const held = latest.get(parsed.epoch);
    if (!held || parsed.postedAt > held.postedAt || (parsed.postedAt === held.postedAt && parsed.id > held.id)) {
      latest.set(parsed.epoch, parsed);
    }
  }

  const fact = {};
  const queues = new Set();
  let update = null;
  for (const epoch of [...latest.keys()].sort((a, b) => a - b)) {
    const parsed = latest.get(epoch);
    fact[epoch] = parsed.queues;
    for (const key of Object.keys(parsed.queues)) queues.add(key);
    if (!update || parsed.postedAt > update) update = parsed.postedAt;
  }
  return { fact, queues: [...queues].sort(), update };
}

/**
 * The whole of an adapter for an operator that publishes only through Telegram.
 *
 * Queue names fall back to the national 1.1–6.2 scheme rather than to whatever the last post
 * happened to mention: out of season there are no posts at all, and a snapshot with no queues
 * fails validation and is published as degraded. All three oblasts on this route use the full
 * national scheme — every archived table lists all twelve subqueues — so naming them costs
 * nothing and keeps a quiet region honestly "seasonal" instead of broken.
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
function closingDiv(html, from) {
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
    .replace(/(\d{1,2}:\d{2}):(\d{1,2}:\d{2})/g, '$1-$2');
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
    const resolved = resolveYear(Number(day), month, postedAt);
    const drift = resolved ? Math.abs(resolved - postedAt) / 86400000 : Infinity;
    return drift <= MAX_LEAD_DAYS ? resolved : null;
  }
  return null;
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
