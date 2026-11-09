import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getText } from './http.mjs';
import { pageOf } from './dtek-emergency.mjs';
import { feedOf } from './operator-posts.mjs';

/**
 * «Новини України»: the headlines of a few Ukrainian news outlets, as a headline, the line the outlet's own feed gives with it,
 * and a link to the story on the outlet's own site — `v1/news-ua.json`, one file for the whole country.
 *
 * What is taken is only what an RSS feed is published for: `title`, `description`, `link`, `pubDate`. Never `content:encoded` or
 * `fulltxt` (the story), never a picture. The reader who wants the story opens it where the outlet wrote it, and the source's
 * name stands under every headline.
 *
 * The feeds are read with the mirror's honest user agent, once per slow turn on the Kyiv server (about every five and a half
 * minutes), and a feed that cannot be read is left out of that file — the other outlets still go out; when none can be read,
 * nothing is written and the file already served stays.
 */

/**
 * `hosts`: a story's link must lead to the outlet's own site — a feed that carries someone else's link (an advertisement, a
 * redirect) is not passed on. `allow`: the categories an outlet's feed mixes with horoscopes and quizzes; with none, all pass.
 *
 * `telegram`: a source that has no feed to read but a public channel — Укренерго's own site is behind a challenge that no
 * honest client passes, and its channel says the same first («Інформація про відключення», «Стан енергосистеми»). Read as an
 * operator's channel is (lib/operator-posts.mjs): only what is about the power, as a headline and a line, and the post's own
 * address, so that whoever wants the rest opens it where it was written.
 */
export const NATIONAL_SOURCES = [
  { id: 'ukrinform', name: 'Укрінформ', url: 'https://www.ukrinform.ua/rss/block-lastnews', hosts: ['ukrinform.ua'] },
  { id: 'pravda', name: 'Українська правда', url: 'https://www.pravda.com.ua/rss/view_news/', hosts: ['pravda.com.ua'] },
  {
    id: 'unian', name: 'УНІАН', url: 'https://www.unian.ua/rss', hosts: ['unian.ua'],
    allow: /^(?:Украина|Война|Политика|Финансы|Энергетика|Мир|Происшествия|Экология|Транспорт)$/iu
  },
  {
    id: 'ukrenergo', name: 'Укренерго', telegram: 'ukrenergo',
    // The operator-feed rule counts the company's own name as being about the power, and here that lets an award through:
    // the national grid operator's posts are held to the words of an outage itself.
    about: /відключен|електропостачан|знеструм|графік|обмеження споживання|обмеження потужності|енергосистем|дефіцит/iu
  }
];

const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const PER_SOURCE = 12;
const MAX_ITEMS = 30;
const TITLE_CHARS = 160;
const EXCERPT_CHARS = 200;
/** Said by the outlet itself to be an advertisement, not news. */
const PROMOTED = /на правах реклами|партнерськ(?:ий|і) матеріал|партнёрск|реклама\b|промо\b/iu;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…' };

/** `&amp;`, `&#39;`, `&#x27;` — what a feed writes inside a title — and nothing else is touched. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/giu, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    try { return String.fromCodePoint(code); } catch { return whole; }
  });
}

const tagText = (block, tag) => {
  const found = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'iu'));
  if (!found) return '';
  const cdata = found[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/u);
  return cdata ? cdata[1] : found[1];
};

/** Plain text of a feed field: no markup, no entities, one line. */
const plain = (text) => decodeEntities(String(text ?? '').replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim();

function cut(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const whole = head.replace(/\s+\S*$/u, '');
  return `${(whole.length > limit / 2 ? whole : head).replace(/[\s,;:–—-]+$/u, '')}…`;
}

/** The items of an RSS 2.0 document — only the four fields a feed is published for, and the category. */
export function parseRss(xml) {
  const items = [];
  for (const found of String(xml ?? '').matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/giu)) {
    const block = found[1];
    items.push({
      title: plain(tagText(block, 'title')),
      link: plain(tagText(block, 'link')),
      description: plain(tagText(block, 'description')),
      pubDate: plain(tagText(block, 'pubDate')),
      category: plain(tagText(block, 'category'))
    });
  }
  return items;
}

const onHost = (link, hosts) => {
  let url;
  try { url = new URL(link); } catch { return false; }
  return url.protocol === 'https:' && hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
};

const sameStory = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** One outlet's feed → its newest headlines, in the shape the app reads. */
export function itemsOf(parsed, source, { now = new Date() } = {}) {
  const since = now.getTime() - MAX_AGE_MS;
  const items = [];
  for (const entry of parsed) {
    const at = Date.parse(entry.pubDate);
    if (!(at >= since && at <= now.getTime() + 5 * 60 * 1000)) continue;
    if (!entry.title || entry.title.length < 15 || PROMOTED.test(entry.title)) continue;
    if (source.allow && !source.allow.test(entry.category)) continue;
    if (!onHost(entry.link, source.hosts)) continue;
    const excerpt = entry.description && sameStory(entry.description) !== sameStory(entry.title) ? cut(entry.description, EXCERPT_CHARS) : '';
    items.push({
      id: `${source.id}/${entry.link.replace(/^https:\/\/[^/]+/u, '')}`,
      at: new Date(at).toISOString(),
      title: cut(entry.title, TITLE_CHARS),
      excerpt,
      url: entry.link,
      source: source.name
    });
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, PER_SOURCE);
}

/** «ІНФОРМАЦІЯ ПРО ВІДКЛЮЧЕННЯ.» as the channel shouts it → «Інформація про відключення.»: a headline in capitals is read as an alarm. */
export function unshout(text) {
  const letters = String(text ?? '').replace(/[^\p{L}]/gu, '');
  if (letters.length < 4 || letters !== letters.toUpperCase()) return text;
  const lower = text.toLowerCase();
  return lower.replace(/^\P{L}*\p{L}/u, (head) => head.toUpperCase());
}

/** A channel's posts about the power → its newest headlines, in the shape the app reads: the outlet's name under each. */
export function postsOf(posts, source, { now = new Date() } = {}) {
  const since = now.getTime() - MAX_AGE_MS;
  return feedOf(posts.filter((post) => !source.about || source.about.test(post.text)), { channel: source.telegram, now })
    .filter((item) => Date.parse(item.at) >= since)
    .map((item) => ({ ...item, title: unshout(item.title), source: source.name }))
    .slice(0, PER_SOURCE);
}

/**
 * How many of a channel's newest posts stay in the list whatever the outlets wrote since. The outlets give a headline every few
 * minutes (the thirty newest of them cover about three hours), a channel a few posts a day: by recency alone its notices were
 * never there.
 */
export const RESERVED = 4;

/**
 * The outlets' headlines in one list, newest first; the same story told twice by one headline is kept once. `reserved`: items
 * that are in the list however old they are next to the rest — the room is taken out of the list's size, not added to it.
 */
export function mergeFeeds(lists, reserved = []) {
  const held = new Set(reserved.map((item) => item.id));
  const seen = new Set();
  const merged = [];
  for (const item of lists.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1))) {
    const key = sameStory(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  let room = Math.max(0, MAX_ITEMS - merged.filter((item) => held.has(item.id)).length);
  return merged.filter((item) => held.has(item.id) || room-- > 0);
}

/**
 * Writes `news-ua.json` — only when it changed, and not at all when no outlet could be read.
 *
 * @returns {Promise<{ written: boolean, read: number, failed: number }>}
 */
export async function publishNational({
  outDir, now = new Date(), read = (url) => getText(url, { retries: 1, timeoutMs: 15000 }), readPage = pageOf, sources = NATIONAL_SOURCES
} = {}) {
  const lists = [];
  const reserved = [];
  let failed = 0;
  for (const source of sources) {
    try {
      if (source.telegram) {
        const posts = postsOf(await readPage(source.telegram), source, { now });
        lists.push(posts);
        reserved.push(...posts.slice(0, RESERVED));
      } else {
        lists.push(itemsOf(parseRss(await read(source.url)), source, { now }));
      }
    } catch (error) {
      failed++;
      console.warn(`[news-ua] ${source.id} not read: ${error.message}`);
    }
  }
  if (!lists.length) return { written: false, read: 0, failed };
  const body = JSON.stringify({ items: mergeFeeds(lists, reserved) });
  const file = join(outDir, 'news-ua.json');
  if ((await readFile(file, 'utf8').catch(() => null)) === body) return { written: false, read: lists.length, failed };
  await writeFile(file, body, 'utf8');
  return { written: true, read: lists.length, failed };
}
