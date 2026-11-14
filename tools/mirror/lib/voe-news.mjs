import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getText, USER_AGENT } from './http.mjs';
import { kyivDayStart, kyivTomorrowStart } from './canonical.mjs';
import { decodeEntities } from './national-news.mjs';
import { cut, isAboutPower, EXCERPT_CHARS, MAX_AGE_MS, MAX_ITEMS, TITLE_CHARS } from './operator-posts.mjs';

/**
 * «Новини оператора» for Вінниччина, from the news list of the operator's own site — `v1/news-vinnytsia.json`, the shape
 * lib/operator-posts.mjs writes for the regions that have a Telegram channel.
 *
 * АТ «Вінницяобленерго» has no public channel (a bot and a closed group), and since November 2026 its address search — the
 * only place a черга's hours are — turns this server away (sources/vinnytsia.mjs). What it does publish in the open, every
 * day there are outages, is a card on www.voe.com.ua/news: «Введення ГПВ. Дата та час відключень - 14.11.26. Будуть
 * застосовані з 06:00 - 24:00», and «Зміни по ГПВ» when the order changes. Without it the app can only tell people who are
 * being switched off by the hour that the operator's data cannot be read; with it they read that the schedules are in force,
 * for which day and from when to when, and open the operator's own page for the hours.
 *
 * Not a copy of the operator's text: the card's title with its day and hours as the headline, the card's own first lines as
 * the excerpt, and the address of the news item itself.
 *
 * The list dates a card by the day («13 листопада, 2026»), not the minute, so `at` is when this server first saw it, held
 * inside the day the operator gives; a card already in the served feed keeps the `at` it has there. The site is asked on the
 * slow turn only (mirror.mjs) — one page in five and a half minutes. On the turns between, and when the site cannot be read,
 * the served feed is put back as it is: the checkout is cleaned every cycle (vps/run.sh), and a full deploy of a tree without
 * the file would take it off the site.
 *
 * «ГОП» — the power limits for businesses, the same page's other daily card — is no news to a household.
 */
export const LIST = 'https://www.voe.com.ua/news';
const SITE = 'https://www.voe.com.ua';
const SERVED = 'https://koly-svitlo.web.app/v1/news-vinnytsia.json';
const REGION = 'vinnytsia';

const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

const textOf = (html) => decodeEntities(String(html ?? '').replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim();

/** «13 листопада, 2026» → the start of that day in Kyiv, or null. */
export function dayOf(label) {
  const found = String(label ?? '').trim().match(/^(\d{1,2})\s+(\p{L}+),?\s+(\d{4})$/u);
  const month = found ? MONTHS.indexOf(found[2].toLowerCase()) : -1;
  if (month < 0) return null;
  const day = Number(found[1]);
  if (day < 1 || day > 31) return null;
  // Noon UTC of that calendar day is that same day in Kyiv, whichever side of the clock change it is on.
  return new Date(kyivDayStart(new Date(Date.UTC(Number(found[3]), month, day, 12))) * 1000);
}

/**
 * The cards of the list page, as it lays them out (and as the home page's «Новини» block does): a node number, the item's
 * address, a day, a title and the first lines of the text. A card missing any of them is not a card.
 *
 * @returns {Array<{ node: number, path: string, day: Date, title: string, body: string }>}
 */
export function cardsOf(html) {
  const cards = [];
  const seen = new Set();
  for (const block of String(html ?? '').split(/(?=<div class="node news news-\d+)/u).slice(1)) {
    const node = Number(block.match(/^<div class="node news news-(\d+)/u)?.[1]);
    const head = block.match(/__title">\s*<a href="(\/news\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/u);
    const day = dayOf(textOf(block.match(/class="date-format">([^<]*)</u)?.[1]));
    const body = block.match(/class="[^"]*\bfield body\b[^"]*">([\s\S]*?)<\/div>/u);
    const title = textOf(head?.[2]);
    if (!node || !head || !day || !title || seen.has(node)) continue;
    seen.add(node);
    cards.push({ node, path: head[1], day, title, body: textOf(body?.[1]) });
  }
  return cards;
}

const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{N}])';
/** The limits for businesses: the card says so in its title. */
const BUSINESS = new RegExp(`${NOT_LETTER_BEFORE}ГОП${NOT_LETTER_AFTER}`, 'u');
/** The operator's own line under such a title: the day, then the hours — «14.11.26. Будуть застосовані з 06:00 - 24:00», «13.11.2026 з 17:00 до 24:00», «13.11.2026 з 07:00». */
const WHEN = /^Дата та час відключень\s*[-–—:]\s*(\d{1,2})\.(\d{1,2})\.(?:\d{4}|\d{2})\.?\s*(?:Будуть застосовані\s*)?(?:з\s*(\d{1,2})[:.-](\d{2})(?:\s*(?:-|–|—|до)\s*(\d{1,2})[:.-](\d{2}))?)?[.\s]*/iu;

const two = (number) => String(number).padStart(2, '0');

/** The text flattened by the page runs sentences together («24:00.Від НЕК», «24:00Отримали»): a space where one ends. */
const spaced = (text) => text.replace(/([.!?…])(?=\p{Lu})/gu, '$1 ').replace(/\s+/gu, ' ').trim();

/**
 * The card's lines as an excerpt. The list cuts its teaser mid-sentence: a word or two of the next one («…для Вінницької
 * області. Протягом») are dropped, and a sentence cut well into itself is kept and marked as cut.
 */
function excerptOf(text) {
  const lines = spaced(text);
  if (!lines || /[.!?…]$/u.test(lines)) return cut(lines, EXCERPT_CHARS);
  const whole = lines.match(/^.*[.!?…](?=\s)/su)?.[0] ?? '';
  const stub = lines.slice(whole.length).trim();
  return cut(whole && stub.length < 30 ? whole : `${lines}…`, EXCERPT_CHARS);
}

/**
 * A card as a feed item's words, or null when it is not about a household's power.
 *
 * @returns {{ title: string, excerpt: string } | null}
 */
export function wordsOf(card) {
  if (BUSINESS.test(card.title)) return null;
  if (!isAboutPower(`${card.title}\n${card.body}`)) return null;
  const when = card.body.match(WHEN);
  if (!when) return { title: cut(card.title, TITLE_CHARS), excerpt: excerptOf(card.body) };
  const [whole, day, month, fromHour, fromMinute, toHour, toMinute] = when;
  let hours = '';
  if (fromHour !== undefined) hours += ` з ${two(fromHour)}:${fromMinute}`;
  if (toHour !== undefined) hours += ` до ${two(toHour)}:${toMinute}`;
  return {
    title: cut(`${card.title}: ${two(day)}.${two(month)}${hours}`, TITLE_CHARS),
    excerpt: excerptOf(card.body.slice(whole.length))
  };
}

/**
 * The cards as the region's feed, newest first.
 *
 * @param {ReturnType<typeof cardsOf>} cards
 * @param {{ now?: Date, served?: Array<{ id: string, at: string }> | null }} options `served`: the feed on the site now, or
 *   null when there is none yet — then nothing has been watched, and a card of an earlier day is dated to that day's noon.
 */
export function feedOf(cards, { now = new Date(), served = null } = {}) {
  const held = new Map((served ?? []).map((item) => [item.id, Date.parse(item.at)]));
  const items = [];
  for (const card of cards) {
    const words = wordsOf(card);
    if (!words) continue;
    const id = `voe/${card.node}`;
    const start = card.day.getTime();
    const end = kyivTomorrowStart(card.day) * 1000 - 1000;
    let at = held.get(id);
    if (!Number.isFinite(at)) {
      if (now.getTime() <= end) at = Math.max(start, now.getTime());
      else at = served ? end : start + 12 * 60 * 60 * 1000;
    }
    if (at < now.getTime() - MAX_AGE_MS) continue;
    items.push({ id, at: new Date(at).toISOString(), ...words, url: `${SITE}${card.path}`, node: card.node });
  }
  return items
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.node - a.node)
    .slice(0, MAX_ITEMS)
    .map(({ node, ...item }) => item);
}

/** The feed as the site serves it: its text, or null when there is none yet (a 404). Anything else is an error. */
async function servedCopy() {
  const response = await fetch(SERVED, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

const itemsOf = (text) => {
  try {
    const items = JSON.parse(text)?.items;
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
};

/**
 * Writes `news-vinnytsia.json`: the list read anew when `ask` is set and the site answers, the served feed put back otherwise.
 * Nothing is written when there is neither.
 *
 * @returns {Promise<{ written: boolean, asked: boolean, failed: boolean, changed: boolean }>} `changed`: the feed differs from the served one.
 */
export async function publishVinnytsiaNews({
  outDir, now = new Date(), ask = true, read = () => getText(LIST, { retries: 1, timeoutMs: 20000 }), readServed = servedCopy
} = {}) {
  const servedText = await readServed();
  const served = servedText === null ? null : itemsOf(servedText);
  let body = served ? servedText : null;
  let failed = false;
  if (ask) {
    try {
      const cards = cardsOf(await read());
      // A page that answers 200 with no cards on it is a page that changed its layout, not a week without news.
      if (!cards.length) throw new Error('no cards on the page');
      body = JSON.stringify({ items: feedOf(cards, { now, served }) });
    } catch (error) {
      failed = true;
      console.warn(`[news] ${REGION}: ${LIST} not read: ${error.message}`);
    }
  }
  if (body === null) return { written: false, asked: ask, failed, changed: false };
  await writeFile(join(outDir, `news-${REGION}.json`), body, 'utf8');
  return { written: true, asked: ask, failed, changed: body !== servedText };
}
