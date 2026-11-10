import { fetchChannel, gpvSnapshot } from '../lib/telegram.mjs';
import { readerOf } from '../lib/dtek-emergency.mjs';
import { withChannelEmergency } from './dtek.mjs';

const CHANNEL = 'cek_info';

/**
 * ПрАТ «ПЕЕМ «ЦЕК» (Центральна енергетична компанія) — the Dnipropetrovsk-oblast subscribers ДТЕК does not serve: Жовті Води,
 * Вільногірськ, Павлоград, part of Дніпро and Кривий Ріг. The hours are NOT ДТЕК's under the same numbers (9 November 2026: CEK's
 * 1.1 was 01:30–04:00, 07:30–14:30, 21:30–24:00; ДТЕК Дніпро's 1.2, 00:00–01:00, 07:30–14:30, 18:00–23:00), so this is a region
 * of its own.
 *
 * The operator posts to @cek_info (and pastes the same posts, undated, onto cek.dp.ua/…/vidkliuchennia.html — the channel is
 * read because it carries the time of each). Every evening the next day's table goes out, one block per queue:
 *
 *   📢 Шановні споживачі! Повідомляємо, що за розпорядженням диспетчерського центру НЕК "Укренерго", 10 ЛИСТОПАДА з 00:00 до 24:00
 *   застосовуватимуться відключення наступних черг:
 *   🔹 Черга 1.1
 *   06:00-11:30
 *   18:30-22:00
 *
 * That is the layout lib/telegram.mjs reads (stacked windows under the label), with two wrinkles `prepare` takes out: the post names
 * neither «ГПВ» nor «погодинні», which the shared reader wants before it believes a post is a schedule, and the windows of one
 * day's table carry a ✅ before each (9 November) and of another's nothing (10 November).
 *
 * Not read yet, by design — each leaves the table as published rather than guess:
 *  - «зміни в ГПВ …» posts, free text («з 18:00 додатково застосовуються відлючення черги 1.1, 1.2 та черги 4.1, 4.2 — з 21:30 до
 *    22:00»): the table can be shorter than the evening's cuts, and the banner under it says the schedule may change;
 *  - Павлоград's own two-queue schedule («1 черга», «2 черга»), a grid the twelve queues do not describe.
 *
 * «Діють ЕКСТРЕНІ ВІДКЛЮЧЕННЯ» / «скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ» on the same channel is the emergency signal
 * (lib/dtek-emergency.mjs, area 'own').
 */

/** The sentence a day's table opens with. */
const DAY_TABLE = /застосовуватимуться\s+відключення\s+наступних\s+черг/iu;

/** A ✅ or ✔️ in front of a window on its own line. */
const MARK_BEFORE_WINDOW = /^[^\p{L}\p{N}\n]+(?=\d{1,2}:\d{2})/gmu;

/** The posts as lib/telegram.mjs reads them: a day's table says «ГПВ» and has its windows bare. Everything else is left as it is. */
export function prepare(posts) {
  return posts.map((post) => (DAY_TABLE.test(post.text)
    ? { ...post, text: `ГПВ. ${post.text.replace(MARK_BEFORE_WINDOW, '')}` }
    : post));
}

/** The region's snapshot from the channel's posts, as `fetchRegion` makes it: the tables, and the emergency the channel declares. */
export async function snapshotFrom(posts, region, { now = new Date(), log = (line) => console.log(`[emergency] ${line}`) } = {}) {
  const ready = prepare(posts);
  const snapshot = await gpvSnapshot({ region, channel: CHANNEL, source: 'cek', posts: ready });
  return withChannelEmergency(snapshot, region, { read: readerOf(ready), now, log });
}

export async function fetchRegion(region) {
  return snapshotFrom(await fetchChannel(CHANNEL), region);
}
