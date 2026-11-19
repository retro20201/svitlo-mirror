import { pageOf, lastEndFromChannel } from './dtek-emergency.mjs';
import { markCarried, carriedParts } from './carried.mjs';
import { kyivDayStart } from './canonical.mjs';

/**
 * «Аварійні відключення» for the oblasts whose own operator says nothing a machine can read, off Укренерго's public channel.
 *
 * Укренерго gives the order, and names the oblasts under it in its morning summary and in a post of its own on a hard day:
 * «❗ Через пошкодження енергетичного обладнання у Сумській, Полтавській, Харківській та Дніпропетровській областях наразі
 * вимушено застосовуються аварійні відключення» (19 November 2026, 10:39 Kyiv). Полтаваобленерго's page and site carried not a
 * word of it that morning, the app showed no warning, and a person in the dark eight minutes after their window wrote in.
 *
 * It is a coarse word and is kept as one: the whole oblast, once or twice a day, with no end ever written for it. So
 *  – only a sentence that names oblasts counts («в окремих регіонах України запроваджені аварійні відключення» names nobody);
 *  – the oblasts are read from that sentence alone — the same post lists, a paragraph up, where the shelling left people without
 *    power, and that is not an order;
 *  – the newest post that names any is Укренерго's word as of its hour: an oblast it leaves out is no longer under the order
 *    (17 November: Харківська at 10:06, gone from the list of 11:58), and «зранку застосовувалися» is said of a morning that is over;
 *  – a word nobody takes back is believed for twelve hours, as an operator's channel that writes no ends is (regions.mjs).
 * The banner carries the sentence, the channel's name and the hour, so the person sees whose word it is and how old.
 *
 * `https://t.me/s/Ukrenergo` is the channel's public preview page, asked for once a cycle for every oblast that reads it.
 *
 * It also stands in where an operator has a word of its own and did not say it. On 19 November 2026 the same post named
 * Дніпропетровська область; ДТЕК's channel, which announces each order there, wrote nothing all day, YASNO marked nothing, and
 * at 16:29 ДТЕК's own bot told a person on просп. Героїв in Дніпро «Екстренні відключення (Аварійне без застосування графіку
 * погодинних відключень)» while the app had their queue in the light and no warning over it. There the operator's word stays
 * the nearer one: its own warning for today is left as it is, and an order it has ended since Укренерго spoke is ended —
 * Укренерго names the oblast once a morning and never says when an order there is over.
 */
export const CHANNEL = 'Ukrenergo';
export const MAX_AGE_MS = 12 * 3600 * 1000;
/** The preview page holds about twenty posts, a week of this channel; a word older than a day and a half is not looked at. */
const LOOKBACK_MS = 36 * 3600 * 1000;

// «аварійні відключення», «графіки аварійних відключень». Not «аварійно-відновлювальні роботи», in every summary.
const EMERGENCY = /аварійн\S*\s+відключен/iu;
// «у Сумській, Полтавській, Харківській та Дніпропетровській областях», «лише у Харківській області»: the adjectives before the noun.
const NAME = String.raw`\p{Lu}[\p{L}'’ʼ-]*[сцз]ьк\p{L}*`;
const LIST = new RegExp(String.raw`(${NAME}(?:(?:\s*,\s*|\s+(?:та|і|й)\s+)${NAME})*)\s+област`, 'gu');
// «Аварійні відключення будуть скасовані, щойно це дозволить стан енергосистеми», «будуть застосовані»: about later, and no
// word on what is on at this hour either way.
const LATER = /буд\S*\s+(?:\S+\s+){0,2}?(?:застосован|запроваджен|скасован)/iu;
// «зранку застосовувалися графіки аварійних відключень» (10, 11 and 16 November 2026), «скасовано аварійні відключення».
const OVER = /застосовувалис|скасован/iu;
// «вимушено запроваджені», «наразі вимушено застосовуються», «застосовані», «аварійні відключення діють у …»,
// «продовжують діяти лише у Харківській області».
const NOW = /запроваджен|застосовуютьс|застосован|діють|продовжують\s+діяти/iu;

const sentencesOf = (text) => text.split(/(?<=[.!?…])\s+|\n+/u).map((line) => line.trim()).filter(Boolean);

/**
 * What a post says of the oblasts under the order at its hour: the lists it names as under it now, and the sentence each came
 * in. `null` for a post that names none either way — it changes nothing that was said before it.
 * @returns {{ on: Array<{ names: string, sentence: string }> }|null}
 */
export function statementOf(text) {
  const on = [];
  let said = false;
  for (const sentence of sentencesOf(text ?? '')) {
    if (!EMERGENCY.test(sentence) || LATER.test(sentence)) continue;
    const lists = [...sentence.matchAll(LIST)].map((match) => match[1]);
    if (!lists.length) continue;
    if (OVER.test(sentence)) said = true;
    else if (NOW.test(sentence)) {
      said = true;
      on.push({ names: lists.join(', '), sentence: sentence.replace(/^[^\p{L}«]+/u, '').replace(/\s+/g, ' ').replace(/[.\s]+$/u, '') });
    }
  }
  return said ? { on } : null;
}

const HOUR = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Posts → whether Укренерго's last word puts `oblast` under the order now.
 *
 * @param {Array<{id:number, postedAt:string, text:string}>} posts
 * @param {{ oblast: string, now?: Date, maxAgeMs?: number }} options `oblast` is the stem the channel declines: «Полтавськ» for
 *   «у Полтавській області», «Полтавська», «Полтавської».
 * @returns {{ active: boolean, since: string|null, note: string|null }}
 */
export function readUkrenergo(posts, { oblast, now = new Date(), maxAgeMs = MAX_AGE_MS } = {}) {
  const named = new RegExp(String.raw`(?<![\p{L}])${oblast}\p{L}*`, 'u');
  const since = now.getTime() - Math.max(LOOKBACK_MS, maxAgeMs);
  const ordered = posts
    .filter((post) => Date.parse(post.postedAt) >= since && Date.parse(post.postedAt) <= now.getTime() + 5 * 60 * 1000)
    .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt) || a.id - b.id);

  let state = null;
  for (const post of ordered) {
    const statement = statementOf(post.text);
    if (!statement) continue;
    const mine = statement.on.find((entry) => named.test(entry.names));
    state = mine ? { at: post.postedAt, note: `«${mine.sentence}» — Укренерго, ${HOUR.format(new Date(post.postedAt))}` } : null;
  }
  const fresh = state && now.getTime() - Date.parse(state.at) <= maxAgeMs;
  return fresh ? { active: true, since: state.at, note: state.note } : { active: false, since: null, note: null };
}

/** The channel's last page, read for a region's oblast. Throws when it cannot be fetched. */
export async function readUkrenergoFromChannel({ oblast, now = new Date(), maxAgeMs } = {}) {
  return readUkrenergo(await pageOf(CHANNEL), { oblast, now, maxAgeMs });
}

/**
 * An end the operator wrote into its order's own post is an edit, and the page gives no hour for an edit. It is taken as
 * newer than Укренерго's word when the post itself is from the twelve hours before that word: an order announced at 09:00,
 * named by Укренерго at 10:39 and struck out at 14:00 must not warn until 22:39. An older post's edit is taken as older —
 * yesterday morning's order, ended yesterday, says nothing of today.
 */
const IN_PLACE_MS = MAX_AGE_MS;

/** Whether the operator's own channel ended an order after Укренерго's word of `since` (lib/dtek-emergency.mjs `lastEnd`). */
export function endedSince(end, since) {
  if (!end) return false;
  const [ended, said] = [Date.parse(end.at), Date.parse(since)];
  return ended >= said || (end.inPlace && ended >= said - IN_PLACE_MS);
}

/** The last end the region's own channel has said, or null; for a region with no channel of its own, null. */
async function operatorEnd(region, now) {
  const own = region.emergencyTelegram;
  if (!own) return null;
  return lastEndFromChannel({
    channel: own.channel, area: own.area ?? 'oblast', now, skip: own.skip, maxAgeMs: own.maxAgeHours ? own.maxAgeHours * 3600 * 1000 : undefined
  });
}

/**
 * A region with `emergencyUkrenergo` (regions.mjs) has today in `fact.emergency` while Укренерго's word stands, and the word itself
 * in `fact.emergencyNote`. When a channel does not answer, the warning phones already have stays for the day it was given for,
 * marked as carried: it is what they have, not a second look.
 *
 * What the region's own adapter says is nearer and is not touched: its warning for today is returned as it came, the other
 * days it marks (YASNO's tomorrow) stay beside Укренерго's today, and an order its channel has ended since Укренерго spoke
 * is over (`endedSince`).
 */
export async function withUkrenergoEmergency(
  snapshot, region,
  { read = readUkrenergoFromChannel, readEnd = operatorEnd, now = new Date(), log = (line) => console.log(`[ukrenergo] ${line}`) } = {}
) {
  const signal = region.emergencyUkrenergo;
  if (!signal || !snapshot?.fact) return snapshot;
  const today = kyivDayStart(now);
  const own = (snapshot.fact.emergency ?? []).map(Number);
  if (own.includes(today)) return snapshot;
  let reading = null;
  try {
    reading = await read({ oblast: signal.oblast, now, maxAgeMs: signal.maxAgeHours ? signal.maxAgeHours * 3600 * 1000 : undefined });
    if (reading.active && endedSince(await readEnd(region, now), reading.since)) {
      log(`${region.id}: the operator has ended its order since Укренерго's word of ${reading.since}`);
      reading = { active: false, since: null, note: null };
    }
  } catch (error) {
    reading = null;
    log(`${region.id}: channel failed: ${error.message}`);
  }
  // What the adapter itself carried over (Чернівці's tomorrow, a picture channel's day) stays marked on the copy made here.
  const carried = carriedParts(snapshot);
  const kept = (result, parts = []) => markCarried(result, carried === true ? true : [...(carried ?? []), ...parts]);
  const { emergency, emergencyNote, ...rest } = snapshot.fact;
  // The days the adapter marked itself — none of them today — and its note for them.
  const asRead = own.length ? snapshot.fact : rest;
  const withToday = (note) => ({ ...rest, emergency: [...own, today].sort((a, b) => a - b), ...(note ?? emergencyNote ? { emergencyNote: note ?? emergencyNote } : {}) });
  if (!reading) {
    if (!(region.previous?.fact?.emergency ?? []).map(Number).includes(today)) return kept({ ...snapshot, fact: asRead });
    return kept({ ...snapshot, fact: withToday(region.previous.fact.emergencyNote) }, ['emergency']);
  }
  if (!reading.active) return kept({ ...snapshot, fact: asRead });
  log(`${region.id}: emergency since ${reading.since}`);
  return kept({ ...snapshot, fact: withToday(reading.note) });
}
