import { getText } from '../lib/http.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames, NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * АТ «Укрзалізниця» as an operator of a distribution system: the houses fed from the railway's own networks — by stations and
 * junctions, a few hundred addresses an oblast — get their hours from it and not from the oblenergo around them. A letter of
 * 28 November 2026 asked for them.
 *
 * It keeps one page an oblast (`region.uz.page`, the number in its address). Between the heading «Інформація про графіки
 * погодинних відключень електроенергії споживачам, які приєднані до мереж системи розподілу АТ "Укрзалізниця"» and «Перелік
 * адрес, що знеструмлюються по чергах та підчергах ГПВ» stands the announcement, typed by hand in a text editor:
 *
 *   28 листопада, за вказівкою НЕК "Укренерго" діятимуть графіки погодинних відключень електричної енергії
 *   | Години відключення   | 06-00 08-00 | 08-00 11-30      | …
 *   | черги ГПВ (підчерги) | 3(1) 4(1,2) | 4(2) 5(1,2) 6(1,2) | …
 *   Слідкуйте за оновленням інформації. Час застосування та обсяг обмежень протягом доби можуть змінитися.
 *
 * — a date with no year, and a table of two rows: the hours, and under each the queues without power then, «4(1,2)» being
 * підчерги 4.1 and 4.2 of Укренерго's national scheme. As seen on the twenty pages that had one that day: «06-00», «06:30»
 * and «08.00» for a time; minutes that are no half-hour («00-12», «07:10», «15-20»); intervals that overlap; «5(1.2)»; «-»
 * for nobody; yesterday's table left above today's (Рівне, Черкаси); and two tables for one day where two railways serve an
 * oblast («в межах обслуговування РФ "Південно-Західна залізниця"», then «РФ "Одеська залізниця"»: Вінниця, Суми). In place
 * of a table: «В Дніпропетровській області застосовані аварійні відключення електроенергії. …» (Дніпро, Запоріжжя).
 *
 * Hand-typed, so read strictly. A word that is none of the known ones, a table of another shape, two tables for one day — the
 * list of addresses does not say which railway a house is on — and the page is refused whole: the region then reads as one the
 * mirror cannot see, with the operator's page to go to, which is true, where a guessed hour would not be. «Відміна ГПВ» under
 * a table (Черкаси, 28 November) is such a word until it is known what exactly it takes back.
 *
 * robots.txt closes `/files/` and the like; these pages are open. One page per region, asked no more often than
 * `minIntervalMinutes` says.
 */
const BASE = 'https://www.uz.gov.ua/about/activity/electropostachannia/electro_consumers/temporary_shutdown/grafikiobmezhen';
export const pageURL = (page) => `${BASE}/${page}/`;

const HEADING = /Інформація про графіки погодинних відключень/u;
const ADDRESSES = /Перелік адрес/u;

const MONTHS = {
  січня: 1, лютого: 2, березня: 3, квітня: 4, травня: 5, червня: 6,
  липня: 7, серпня: 8, вересня: 9, жовтня: 10, листопада: 11, грудня: 12
};
const DATE = new RegExp(`(?<![\\d.:-])(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})(?![\\p{L}])`, 'u');

const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", laquo: '«', raquo: '»', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘' };
const text = (markup) => markup
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
  .replace(/\s+/g, ' ')
  .trim();

/** The words an announcement is made of, apart from its dates and tables. Whatever is left after them is not understood. */
const KNOWN = [
  /за вказівкою НЕК\s*["«“]Укренерго["»”]/giu,
  /діятимуть\s+графіки погодинних відключень електричної енергії/giu,
  /застосовуються\s+графіки погодинного відключення/giu,
  /Слідкуйте за оновленням інформації\.?/giu,
  /Час застосування та обсяг обмежень протягом доби можуть змінитися\.?/giu
];
/**
 * The heading, up to the operator's name that ends it. Its own words are not checked beyond that: the editor leaves spaces
 * inside them («електрое нергії» on Хмельницький's page, «Укрзалізниц я», «Укрзалізниця "»), and they say nothing of the day.
 */
const HEADING_END = /^[\s\S]*?АТ\s*["«“]\s*Укрзалізниц\s?я\s*["»”]/u;
const BRANCH = /в межах обслуговування РФ\s*["«“]([^"»”]+)["»”]/iu;
const EMERGENCY = /застосовані аварійні відключення/iu;

/** «06-00», «06:30», «08.00» → minutes of the day. */
function minutes(time) {
  const match = /^(\d{1,2})[-:.](\d{2})$/.exec(time);
  const value = match && Number(match[2]) <= 59 ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
  if (!Number.isFinite(value) || value > 24 * 60) throw new Error(`uz: «${time}» is not a time of day`);
  return value;
}

/** «3(1) 4(1,2)» → ['3.1', '4.1', '4.2']; «-» and an empty cell → nobody. */
function queuesOf(cell) {
  const queues = [];
  const rest = cell.replace(/([1-6])\s*\(\s*([12])(?:\s*[,.]\s*([12]))?\s*\)/g, (_, queue, first, second) => {
    for (const sub of [first, second]) if (sub && !queues.includes(`${queue}.${sub}`)) queues.push(`${queue}.${sub}`);
    return ' ';
  });
  if (/[^\s–—-]/u.test(rest)) throw new Error(`uz: «${cell}» is not a list of queues`);
  return queues;
}

/** One table of the announcement → `[{ from, to, queues }]`, minutes of the day. */
function slotsOf(table) {
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => text(cell[1])));
  const [hours, queues] = rows;
  if (rows.length !== 2 || !/Години відключення/iu.test(hours[0] ?? '') || !/черг/iu.test(queues[0] ?? '') || hours.length !== queues.length || hours.length < 2) {
    throw new Error(`uz: a table of ${rows.length} row(s) of ${rows.map((row) => row.length).join(' and ')} cells, expected the hours and the queues under them`);
  }
  return hours.slice(1).map((cell, index) => {
    const times = cell.split(/\s+/);
    if (times.length !== 2) throw new Error(`uz: «${cell}» is not a start and an end`);
    const [from, to] = times.map(minutes);
    if (!(from < to)) throw new Error(`uz: «${cell}» ends before it starts`);
    return { from, to, queues: queuesOf(queues[index + 1]) };
  });
}

/**
 * The announcement as it stands on the page, in order.
 *
 * @returns {{ blocks: Array<{ day: number, month: number, branch: string|null, slots: Array<{from:number,to:number,queues:string[]}> }>,
 *   emergency: { day: number, month: number }|null }} `emergency` — the last thing the page says is an order, and of what date
 */
export function parseAnnouncement(html) {
  const from = html.search(HEADING);
  const to = from < 0 ? -1 : html.slice(from).search(ADDRESSES);
  if (from < 0 || to < 0) throw new Error('uz: the page has no announcement between its heading and its list of addresses');
  const body = html.slice(from, from + to);

  const blocks = [];
  let date = null;
  let branch = null;
  let emergency = null;
  let opened = false;
  const words = (piece) => {
    let rest = text(piece);
    if (!opened) {
      if (!HEADING_END.test(rest)) throw new Error('uz: the heading does not end with the operator\'s name');
      rest = rest.replace(HEADING_END, ' ').trim();
      opened = true;
    }
    if (!rest) return;
    const order = rest.search(EMERGENCY);
    if (order >= 0) {
      // The notice is prose and is not read word by word: its date is the last one above the phrase, and a date after the
      // phrase opens whatever follows the notice — «28 листопада» and a table, when the hours are back.
      const above = [...rest.slice(0, order).matchAll(new RegExp(DATE.source, 'gu'))].at(-1);
      if (above) date = { day: Number(above[1]), month: MONTHS[above[2]] };
      if (!date) throw new Error('uz: an order with no date');
      emergency = { ...date };
      branch = null;
      const next = DATE.exec(rest.slice(order));
      if (!next) return;
      rest = rest.slice(order + next.index);
    }
    for (const known of KNOWN) rest = rest.replace(known, ' ');
    const named = BRANCH.exec(rest);
    if (named) { branch = named[1].trim(); rest = rest.replace(BRANCH, ' '); }
    const dated = DATE.exec(rest);
    if (dated) { date = { day: Number(dated[1]), month: MONTHS[dated[2]] }; rest = rest.replace(DATE, ' '); if (!named) branch = null; }
    if (/[\p{L}\d]/u.test(rest)) throw new Error(`uz: words not understood: «${rest.replace(/\s+/g, ' ').trim().slice(0, 120)}»`);
  };

  let at = 0;
  for (const table of body.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    words(body.slice(at, table.index));
    if (!date) throw new Error('uz: a table with no date above it');
    blocks.push({ ...date, branch, slots: slotsOf(table[0]) });
    // A table answers the order above it, if there was one: the page's last word is then the table.
    emergency = null;
    at = table.index + table[0].length;
  }
  words(body.slice(at));
  if (/<table/i.test(body.slice(at))) throw new Error('uz: a table that does not close');
  return { blocks, emergency };
}

/** «28 листопада» → the Kyiv day it names, of the year that puts it nearest to now. */
export function dayOf({ day, month }, now = new Date()) {
  const year = now.getUTCFullYear();
  const candidates = [year - 1, year, year + 1].map((y) => kyivDayStart(new Date(Date.UTC(y, month - 1, day, 12))));
  return candidates.sort((a, b) => Math.abs(a * 1000 - now.getTime()) - Math.abs(b * 1000 - now.getTime()))[0];
}

/** An order is believed for this long after the date it carries: the page is not always taken down when it ends. */
export const EMERGENCY_MAX_AGE_DAYS = 3;

/**
 * What the announcement says of today and later, as the canonical `fact`: every half-hour an interval touches is without
 * power — «00-00 00-12» darkens the first half-hour, «07:10 08:00» the hour from 07:00 — because a cut warned of and not made
 * costs less than one made and not warned of.
 */
export function factOf({ blocks, emergency }, now = new Date()) {
  const today = kyivDayStart(now);
  const byDay = new Map();
  for (const block of blocks) {
    const epoch = dayOf(block, now);
    if (byDay.has(epoch)) {
      const names = [byDay.get(epoch).branch, block.branch].filter(Boolean).map((name) => `«${name}»`).join(' and ');
      throw new Error(`uz: two tables for one day${names ? ` (${names})` : ''}; which one an address is under is not said`);
    }
    byDay.set(epoch, block);
  }

  const data = {};
  for (const [epoch, block] of byDay) {
    if (epoch < today) continue;
    const halves = Object.fromEntries(NATIONAL_QUEUES.map((queue) => [queue, Array(48).fill('on')]));
    for (const { from, to, queues } of block.slots) {
      for (const queue of queues) halves[queue].fill('off', Math.floor(from / 30), Math.ceil(to / 30));
    }
    data[epoch] = Object.fromEntries(NATIONAL_QUEUES.map((queue) => [
      `GPV${queue}`,
      Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [String(hour + 1), hourStateFromHalves(halves[queue][hour * 2], halves[queue][hour * 2 + 1])]))
    ]));
  }

  const fact = { data };
  if (emergency) {
    const since = dayOf(emergency, now);
    if (since <= today && today - since <= EMERGENCY_MAX_AGE_DAYS * 86400) {
      const month = Object.keys(MONTHS).find((name) => MONTHS[name] === emergency.month);
      fact.emergency = [today];
      fact.emergencyNote = `за повідомленням Укрзалізниці від ${emergency.day} ${month}, в області застосовано аварійні відключення`;
    }
  }
  return fact;
}

export async function fetchRegion(region, { now = new Date() } = {}) {
  if (!region.uz?.page) throw new Error(`uz adapter has no page for "${region.id}"`);
  const { data, emergency, emergencyNote } = factOf(parseAnnouncement(await getText(pageURL(region.uz.page))), now);
  const snapshot = buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: queueNames(NATIONAL_QUEUES),
    fact: data,
    todayEpoch: kyivDayStart(now),
    source: 'uz'
  });
  return emergency ? { ...snapshot, fact: { ...snapshot.fact, emergency, emergencyNote } } : snapshot;
}
