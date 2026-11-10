import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pageOf } from './dtek-emergency.mjs';

/**
 * «Новини оператора»: what the operators say on their own public Telegram channels about the light, per region, as a short
 * excerpt and a link back to the post — `v1/news-<region>.json`.
 *
 * Not a copy of anyone's text: the first sentence as a headline, a couple of lines after it, and the post's own address, so a
 * reader who wants the rest opens it where the operator wrote it. The channel is the operator speaking to its customers; the
 * page it is read from is the one lib/telegram.mjs describes, and this asks it for nothing the schedules and the emergency
 * notices have not already asked for (`pageOf` keeps a page for a minute).
 *
 * Only what is about the power: the same channels carry memorial plaques, fire-safety leaflets and the ministry's explainers,
 * and a feed of those under «Світло» would be noise. A post that is a day's table is left to the schedule, which shows it better.
 */

/**
 * Regions with a channel of their own, and ДТЕК's one channel shared by four: there a post is told apart by the place it opens
 * with («Київщина: …», «Одещина: …»), the way lib/dtek-emergency.mjs reads them.
 */
export const NEWS_SOURCES = [
  { region: 'kharkiv', channel: 'kharkivenergy' },
  { region: 'chernihiv', channel: 'chernigivoblenergo' },
  { region: 'cherkasy', channel: 'pat_cherkasyoblenergo' },
  { region: 'zaporizhzhia', channel: 'Zaporizhzhyaoblenergo_news' },
  { region: 'sumy', channel: 'SumyEnergo' },
  { region: 'zakarpattia', channel: 'zakarpatenergyofficial' },
  { region: 'zhytomyr', channel: 'ztoe_ua' },
  { region: 'cek', channel: 'cek_info' },
  { region: 'kyiv', channel: 'dtek_ua', opens: /^Київ(?![а-яіїєґ'’])/iu },
  { region: 'kyiv-region', channel: 'dtek_ua', opens: /^(?:Київщин|Київськ(?:а|ої)\s+област)/iu },
  { region: 'dnipro', channel: 'dtek_ua', opens: /^(?:Дніпро(?![а-яіїєґ'’])|Дніпропетровщин|Дніпровськ)/iu },
  { region: 'odesa', channel: 'dtek_ua', opens: /^Оде(?:щин|са(?![а-яіїєґ'’]))/iu }
];

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 12;
const TITLE_CHARS = 110;
const EXCERPT_CHARS = 220;

/** About the power: the words an operator uses for it. «Енергетик» and «ремонт» are not among them — a memorial to a lineman has both. */
const ABOUT_POWER = /відключен|електропостачан|знеструм|графік|ГПВ|ГАВ|аварі|Укренерго|енергосистем|світл[оау]\b/iu;
/** Not the power, whatever else the post says: a memorial or a farewell anywhere in it… */
const NOT_POWER = /меморіальн|вшанув|прощання|загинув|народився/iu;
/** …and a fire-safety leaflet, which says so in its first words (an outage caused by a fire says it later). */
const NOT_POWER_HEAD = /пожеж|привітаємо|вітаємо/iu;
/** A day's table: a post with this many queue rows is the schedule, not news. */
const QUEUE_ROW = /^\s*(?:[^\p{L}\p{N}\s]+\s*)?(?:(?:під)?черг[аи]\s+)?[1-6]\.[12]\b/iu;
const TABLE_ROWS = 4;
/**
 * The tail every one of these posts ends with («▪️У разі змін повідомимо в нашому Telegram-каналі. ‼️Підписуйтеся та поділіться
 * каналом»). The page flattens a post to one line, so it is cut where it begins, not dropped by line.
 */
const TAIL = /[\s▪•‼️❗]*(?:у разі змін повідомимо|в разі змін будемо|підписуйтес|підписуйся|поділіться)/iu;
/** A greeting is not a headline: «Шановні споживачі електроенергії!». */
const GREETING = /^(?:шановн[іа][^.!?]{0,60}[!.]|увага[!.])\s*/iu;
const BARE_LINK = /^https?:\/\/\S+$/u;

const WORD_BREAK = /\s+\S*$/u;
/**
 * «UPD: екстрені відключення скасовано» — the operator edits it into the END of the post it is correcting, after the tail that
 * plainOf cuts at. It is the latest word on the post, so it is read first and said first.
 */
const UPDATE = /(?:^|\n)\s*(?:UPD|UPDATE|ОНОВЛЕНО|ОНОВЛЕННЯ)\s*[:\-–—]\s*(.+)$/imu;

/** The operator's own correction at the end of a post, or null. */
export function updateOf(text) {
  const found = String(text ?? '').match(UPDATE);
  const note = found ? found[1].replace(/https?:\/\/\S+/gu, '').replace(/\s+/gu, ' ').trim() : '';
  return note.length >= 8 ? note : null;
}

/** The text without its leading emoji, its calls to subscribe, its links, and its line breaks. */
export function plainOf(text) {
  const lines = String(text ?? '').split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line && !BARE_LINK.test(line));
  // The tail is cut by lines first, so the paragraph before it is the last one and is left as the operator wrote it.
  const tailLine = lines.findIndex((line) => TAIL.test(line));
  const paragraphs = tailLine > 0 && lines.slice(0, tailLine).join(' ').length > 20 ? lines.slice(0, tailLine) : lines;
  // A paragraph the operator ended without a full stop is still a sentence: joined bare, «…екстрені відключення» and «Нагадаємо, …»
  // read as one headline.
  const joined = paragraphs.map((line, index) => (index < paragraphs.length - 1 && /[\p{L}\p{N}»”")\]]$/u.test(line) ? `${line}.` : line)).join(' ');
  const tail = joined.search(TAIL);
  const body = tail > 20 ? joined.slice(0, tail) : joined;
  const plain = body.replace(/^[^\p{L}\p{N}«"]+/u, '').replace(/https?:\/\/\S+/gu, '').replace(/\s+/gu, ' ').trim();
  const greeted = plain.replace(GREETING, '');
  return greeted.length >= 25 ? greeted : plain;
}

const capital = (text) => text.replace(/^\p{L}/u, (letter) => letter.toUpperCase());

function cut(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const whole = head.replace(WORD_BREAK, '');
  return `${(whole.length > limit / 2 ? whole : head).replace(/[\s,;:–—-]+$/u, '')}…`;
}

/** First sentence as the headline, the next lines as the excerpt. */
export function headlineOf(plain) {
  const end = plain.slice(0, TITLE_CHARS + 40).search(/[.!?](?:\s|$)/u);
  const first = end >= 0 && end < TITLE_CHARS + 30 ? plain.slice(0, end + 1) : plain;
  const title = capital(cut(first, TITLE_CHARS));
  const rest = plain.slice(title.endsWith('…') ? title.length - 1 : first.length).replace(/^[^\p{L}\p{N}«"]+/u, '').trim();
  return { title, excerpt: rest ? cut(rest, EXCERPT_CHARS) : '' };
}

export function isAboutPower(text) {
  const plain = String(text ?? '');
  if (NOT_POWER.test(plain) || NOT_POWER_HEAD.test(plain.slice(0, 120))) return false;
  if (plain.split(/\r?\n/u).filter((line) => QUEUE_ROW.test(line)).length >= TABLE_ROWS) return false;
  return ABOUT_POWER.test(plain);
}

/**
 * One channel's posts → the feed of a region.
 *
 * @param {Array<{id:number, postedAt:string, text:string}>} posts
 * @param {{ channel: string, opens?: RegExp, now?: Date }} options
 */
export function feedOf(posts, { channel, opens = null, now = new Date() } = {}) {
  const since = now.getTime() - MAX_AGE_MS;
  const items = [];
  for (const post of posts) {
    const at = Date.parse(post.postedAt);
    if (!(at >= since && at <= now.getTime() + 5 * 60 * 1000)) continue;
    if (!isAboutPower(post.text)) continue;
    const plain = plainOf(post.text);
    if (opens && !opens.test(plain.slice(0, 40))) continue;
    if (plain.length < 25) continue;
    const said = headlineOf(opens ? plain.replace(/^[^:]{1,40}:\s*/u, (head) => (opens.test(head) ? '' : head)) : plain);
    // A post corrected in place leads with its correction; what it first said follows as the excerpt.
    const update = updateOf(post.text);
    const title = update ? capital(cut(update, TITLE_CHARS)) : said.title;
    const excerpt = update ? cut(`${said.title} ${said.excerpt}`.trim(), EXCERPT_CHARS) : said.excerpt;
    items.push({ id: `${channel}/${post.id}`, at: new Date(at).toISOString(), title, excerpt, url: `https://t.me/${channel}/${post.id}` });
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1)).slice(0, MAX_ITEMS);
}

/**
 * Writes `news-<region>.json` for every region with a channel — only the ones whose feed changed, and never over a good file
 * when the channel could not be read.
 *
 * @returns {Promise<{ written: number, failed: number, regions: number }>}
 */
export async function publishNews({ outDir, now = new Date(), read = pageOf, sources = NEWS_SOURCES, known = null } = {}) {
  const pages = new Map();
  const pageFor = (channel) => {
    if (!pages.has(channel)) pages.set(channel, Promise.resolve().then(() => read(channel)));
    return pages.get(channel);
  };
  let written = 0;
  let failed = 0;
  for (const source of sources) {
    if (known && !known.has(source.region)) continue;
    let posts;
    try {
      posts = await pageFor(source.channel);
    } catch (error) {
      failed++;
      console.warn(`[news] ${source.region}: ${source.channel} not read: ${error.message}`);
      continue;
    }
    const body = JSON.stringify({ items: feedOf(posts, { channel: source.channel, opens: source.opens ?? null, now }) });
    const file = join(outDir, `news-${source.region}.json`);
    const held = await readFile(file, 'utf8').catch(() => null);
    if (held === body) continue;
    await writeFile(file, body, 'utf8');
    written++;
  }
  return { written, failed, regions: sources.length };
}
