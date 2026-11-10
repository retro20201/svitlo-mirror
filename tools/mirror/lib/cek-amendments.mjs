import { parseLine } from './chernihiv-amendments.mjs';
import { parseGpvPost, dayOfPost } from './telegram.mjs';

/**
 * ЦЕК changes a day's table in the course of the day, in posts that open «Повідомляємо про зміни у ГПВ …» (or «в ГПВ»), two ways:
 *
 *   rows      🔹 Черга 3.1            The plan for the period, restated: «зміни у ГПВ на 03 ЛИСТОПАДА з 18:30 до 24:00» lists 3.1, 3.2 and 4.2,
 *             18:30-24:00           and no other queue is off between 18:30 and 24:00. A post with no period («зміни в ГПВ 03 ЛИСТОПАДА»,
 *                                   the evening before) restates the whole day, one with «з 17:00» only, the rest of it.
 *   a phrase  «з 22:00 до 24:00 застосовуються відлючення черг: 1.1, 1.2, 2.1 …»
 *             «З 07:00 додатково застосовуються черги 1.1, 1.2»                         (no end)
 *             «з 18:00 додатково … черги 1.1, 1.2 та черги 4.1, 4.2 - з 21:30 до 22:00»    (two clauses)
 *             These ADD: what the table had stays.
 *
 * The 3 November sequence is why rows replace (#4310 at 06:50 restates 08:00–22:00 for all twelve queues, #4311 at 12:50 15:00–22:00,
 * #4312 at 16:38 18:30–24:00 for three): added to the table instead, a block the operator moved would be on the screen twice.
 *
 * A phrase never takes anything out, and where it gives no end the queue is `possible` from its start on, as in
 * lib/chernihiv-amendments.mjs, whose clause reader this uses: the wrong way to be wrong costs a fridge, the other a power bank.
 *
 * Павлоград's own grid («1 черга», «2 черга») names no queue of the twelve and is no part of this.
 */

const REVISION = /зміни\s+(?:в|у)\s+ГПВ/iu;
const PAVLOHRAD = /ПАВЛОГРАД/iu;
/** The line every table has that the shared reader needs, so that a post with a few rows is believed to be rows and not an address list. */
const ROWS_HEADER = 'Години відсутності електропостачання.';
/** «з 18:30 до 24:00», «з 17:00», «з 7:00 до 24:00»: the period a post gives before its first row. */
const PERIOD = /(?<![\p{L}\d])з\s+(\d{1,2}):(\d{2})(?:\s+(?:до|по)\s+(\d{1,2}):(\d{2}))?/iu;

const KYIV_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const slot = (hour, minute) => Math.min(48, Math.floor((Number(hour) * 60 + Number(minute)) / 30));

/** The half-hour of the Kyiv day a post went out in. */
function postSlot(postedAt) {
  const [hour, minute] = KYIV_CLOCK.format(new Date(postedAt)).split(':').map(Number);
  return slot(hour, minute);
}

/** The typos and run-togethers this operator's posts carry, taken out before a post is read. */
export function tidy(text) {
  return String(text ?? '')
    .replace(/[  ]/g, ' ')
    // «відлючення» (the «к» missing) is the commonest word of these posts
    .replace(/відлючен/giu, 'відключен')
    // «НЕК "Укренерго"З 07:00 додатково» — no space before the «З»
    .replace(/(["”»])\s*([Зз])\s+(\d)/gu, '$1 $2 $3')
    .replace(/[–—]/g, '-');
}

/** A phrase's clauses, each read for the queues it names and the time it gives: `{ key, from, to, state }`. */
function phraseDelta(text, atSlot) {
  const changes = [];
  // «…черги 1.1, 1.2 та черги 4.1, 4.2 - з 21:30 до 22:00»: a new clause begins at «та черги»
  for (const sentence of text.replace(/[ \t]+/g, ' ').split(/\n+|‼️|(?<=\.)\s+(?=[А-ЯІЇЄҐ])/u)) {
    for (const clause of sentence.split(/\s+та\s+(?=черг)/iu)) {
      const read = parseLine(clause.replace(/\b([1-6])\.([12])\b/g, '$1/$2'), atSlot);
      if (Array.isArray(read)) changes.push(...read);
      else if (read?.unparsed) changes.push(...read.unparsed.map((key) => ({ key, from: atSlot, to: 48, state: 'possible' })));
    }
  }
  return changes;
}

/**
 * One post → an amendment `{ id, postedAt, at, epoch, replace }` (the plan for a period) or `{ …, delta }` (what is added), or null
 * when the post changes no queue. Only a post that opens «зміни у ГПВ» is one, and Павлоград's is not.
 */
export function amendmentOf(post) {
  if (!REVISION.test(post.text) || PAVLOHRAD.test(post.text)) return null;
  const text = tidy(post.text);
  const day = dayOfPost({ ...post, text });
  if (!day) return null;
  const atSlot = postSlot(post.postedAt);
  // a post that went out before its day began speaks from the start of it
  const start = Date.parse(post.postedAt) < day.epoch * 1000 ? 0 : atSlot;

  const table = parseGpvPost({ ...post, text: `${ROWS_HEADER} ${text.replace(/^[^\p{L}\p{N}\n]+(?=\d{1,2}:\d{2})/gmu, '')}` });
  if (table?.halves) {
    const header = text.slice(0, Math.max(0, text.search(/Черга\s+[1-6]\.[12]/iu)) || text.length);
    const period = PERIOD.exec(header);
    const from = period ? Math.max(slot(period[1], period[2]), start) : start;
    const to = period?.[3] !== undefined ? (slot(period[3], period[4]) || 48) : 48;
    return to > from ? { ...day, replace: { from, to, halves: table.halves } } : null;
  }
  const delta = phraseDelta(text, start);
  return delta.length ? { ...day, delta } : null;
}

/**
 * Applies amendments to the days of half-hours (`{ epoch: { GPV1.1: [48 × on|possible|off] } }`), oldest first, and returns what it
 * made. A day an amendment names that has no table has nothing to change.
 */
export function applyAmendments(halves, amendments) {
  const days = Object.fromEntries(Object.entries(halves).map(([epoch, queues]) => [epoch, Object.fromEntries(
    Object.entries(queues).map(([key, slots]) => [key, [...slots]])
  )]));
  for (const amendment of [...amendments].sort((a, b) => a.at - b.at || a.id - b.id)) {
    const day = days[amendment.epoch];
    if (!day) continue;
    if (amendment.replace) {
      const { from, to, halves: listed } = amendment.replace;
      for (const key of new Set([...Object.keys(day), ...Object.keys(listed)])) {
        day[key] ??= Array(48).fill('on');
        for (let at = from; at < to; at++) day[key][at] = listed[key]?.[at] ?? 'on';
      }
    } else {
      for (const { key, from, to, state } of amendment.delta) {
        day[key] ??= Array(48).fill('on');
        for (let at = from; at < to; at++) {
          if (state === 'off' || day[key][at] === 'on') day[key][at] = state;
        }
      }
    }
  }
  return days;
}
