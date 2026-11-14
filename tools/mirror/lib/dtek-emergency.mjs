import { fetchChannel } from './telegram.mjs';

/**
 * «Екстрені відключення» for Київщина, read off ДТЕК's own public Telegram channel.
 *
 * YASNO marks them for Київ and Дніпро (`EmergencyShutdowns`); nothing machine-readable does for the
 * oblast, but ДТЕК announces each one to its subscribers in the same words every time — «‼️Київщина: за
 * командою Укренерго застосовані екстрені відключення у Білоцерківському, Бучанському … районах» — and
 * ends it with a post or an edit: «UPD: екстрені відключення скасовані», «💡Київщина: повертаємось до
 * графіків відключень». That broadcast is the route; it is the operator speaking to its customers.
 *
 * `https://t.me/s/dtek_ua` is the channel's public preview page (see lib/telegram.mjs for what that is
 * and is not). One request per cycle, and only for the region that asks for it.
 *
 * Emergency outages are not accidents («через аварію … відсутнє електропостачання»): those are a fault on
 * a line, with no order from Укренерго behind them, and the app has never had a signal for them. Only
 * the order counts here.
 */
export const CHANNEL = 'dtek_ua';

/** An announcement older than this with nothing to end it is not believed any more: a post that was
 *  never edited and never followed would otherwise warn for the rest of the day. */
export const MAX_AGE_MS = 12 * 3600 * 1000;
/** The preview page holds ~16 posts, two or three days; anything older is not looked at. */
const LOOKBACK_MS = 36 * 3600 * 1000;

// «застосовані / застосовуються / запроваджено екстрені відключення» (an order of Укренерго), «діють екстрені відключення»
// (after an attack, in the districts a post names: «Через пошкодження на магістральних мережах … діють екстрені відключення»).
// «тривають екстрені відключення» is the channel saying, a day or two into an order, that it still stands («Київ, Київська область
// та місто Дніпро: тривають екстрені відключення», 8 November 2026, 08:35 UTC): it renews the order the way the first post made it.
// Without it the order of 6 November was believed for its thirty-six hours and dropped at 00:26 on the 8th, with the power still off.
const APPLIED = /(?:(?:застосов|запроваджен)\S*\s+|діють\s+|тривають\s+|продовжу\S*\s+(?:діяти\s+)?)екстрен\S*\s+відключен/iu;
// The operator's own word that the schedule does not hold, after an attack on its equipment: «через атаку … фіксуються
// аварійні відключення», «аварія на пошкодженому обстрілами обладнанні, графіки тимчасово не діють в … районах».
// «тимчасово» or «наразі» is what tells it from the reminder under every order — «під час екстрених відключень графіки
// не діють» — which is no announcement. A plain «через аварію … відсутнє електропостачання» is a fault on a line, not here.
const ACCIDENT = [
  /аварійн\S*\s+відключен/iu,
  /графіки\s+(?:відключень\s+)?(?:\S+\s+){0,4}?(?:тимчасово|наразі)\s+не\s+діють/iu
];
// The short form some oblenergo channels use for an order: «О 14:00 ГАВ введені в повному обсязі (для 1-10 черг)», «О 17:09 введено ГАВ
// для 6-10 черг», «О 10:28 додатково введено ГАВ для 6-10 черг» (@SumyEnergo, 8–9 November 2026). Not «не введено ГАВ».
const GAV_APPLIED = /(?<![\p{L}])ГАВ\s+(?:введен|застосов|запроваджен)\S*|(?<![Нн]е\s)(?:введен|застосов|запроваджен)\S*\s+(?:додатково\s+)?ГАВ(?![\p{L}])/iu;
// An operator's own word that part of its area is dark beyond any schedule: «Маємо масштабне аварійне знеструмлення в частині
// Сумщини», «Маємо аварійне знеструмлення через збройну агресію російської федерації», «У частині Сумщини маємо знеструмлення …»
// (@SumyEnergo, 22 October – 14 November 2026: six such posts, none of them read; a letter at 08:28 on the 14th, an hour and a half
// after one, from a queue the table had in the light). It is no order and has no end said, so it stands for the region's own
// `maxAgeHours`, and the banner carries the operator's words. Only on a channel of the operator's own: ДТЕК's shared channel says a
// fault on a line in other words, and that is not this.
const BLACKOUT = /маємо\s+((?:масштабн\S*\s+|аварійн\S*\s+){0,2}знеструмлен[^.!\n✅❗]*)/iu;
// «… родин знову зі світлом після обстрілів»: the area is back. Only for a post that announces nothing itself — one
// can say both («170 000 родин знову зі світлом … в частині Бучанського району діють екстрені відключення»).
const RESTORED = /знову\s+зі\s+світлом/iu;
const ENDED = [
  /екстрен\S*\s+відключен\S*\s+скасован/iu,
  /скасован\S*\s+екстрен\S*\s+відключен/iu,
  // The oblenergo channels that say «графіки аварійних відключень (ГАВ)» end them in the same words (none seen yet).
  // «Аварійні відключення на Житомирщині скасовано»: a few words may stand between.
  /аварійн\S*\s+відключен\S*(?:\s+\S+){0,4}?\s+(?:скасован|припинен)/iu,
  /(?:скасован|припинен)\S*\s+(?:графік\S*\s+)?аварійн/iu,
  /(?<![\p{L}])ГАВ\s+(?:скасован|припинен)/iu,
  // ЦЕК's own channel ends an order with a noun, not a participle, and may put a word before «графік»: «Повідомляємо про
  // скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️ Повертаємося до вашого ГРАФІКА ПОГОДИННИХ ВІДКЛЮЧЕНЬ» (13 November 2026, 16:54 UTC).
  // Read as no end at all, it left the whole region under the warning for the night.
  /скасуванн\S*\s+екстрен\S*\s+відключен/iu,
  /повертаєм\S*\s+до\s+(?:\S+\s+)?графік/iu,
  /повертаютьс\S*\s+(?:до\s+)?графік/iu
];

/** Where a post says it is about: the words before the first colon of its first line. */
function headOf(text) {
  const line = text.split('\n')[0] ?? '';
  const colon = line.indexOf(':');
  return colon > 0 ? line.slice(0, colon) : line;
}

// «Київщина», «Київська область», and the list the channel wrote on 3 November 2026 for an order over three regions at once:
// «Київ, Київська та Дніпропетровська область» — a word or two between «Київська» and «область».
const OBLAST = /київщин|київськ\S*(?:\s+\S+){0,3}?\s+област/iu;
// «Київ», and the city as the channel declines it: «Правий берег Києва».
const CITY = /(?<![\p{L}])(?:київ|києв\p{L}*)(?![\p{L}])/iu;
const DNIPRO = /дніпр/iu;
// «Черкасиобленерго» writes «по Черкаській області застосовані графіки аварійних відключень (ГАВ)» to its own subscribers:
// nothing in the post needs to name a place a channel of its own is not about.
const EVERY_POST = /^/u;
// Every channel of an operator also carries the long «У мене пропало світло поза графіком» explainer and the ministry's
// briefings, which talk of «аварійні відключення» from their 1200th character on. An announcement says it at the top.
const OWN_HEAD_CHARS = 400;

/** The districts a post lists, as it writes them: «у Білоцерківському, Бучанському … районах». */
function districtsOf(text) {
  const line = text.split('\n')[0] ?? '';
  const after = line.match(/(?:відключен\S*|не\s+діють)\s+((?:у|в)\s+.+?\s+район\S*)/iu);
  if (after) return after[1].trim().replace(/[.\s]+$/, '');
  // Said before the announcement: «через атаку ворога у Святошинському районі фіксуються аварійні відключення».
  const body = line.slice(line.indexOf(':') + 1);
  const before = body.match(/(?:^|\s)((?:у|в)\s+(?:частині\s+)?[^.:]*?\s+район\S*)/iu);
  return before ? before[1].trim().replace(/[.\s]+$/, '') : null;
}

/**
 * Who an operator's own post is addressed to, when it names one city: «Шановні споживачі м. ДНІПРО ‼️ … застосовуються ЕКСТРЕНІ
 * ВІДКЛЮЧЕННЯ» → «для споживачів м. Дніпро». The banner then says where, for a region that is more than that city.
 */
function addresseeOf(text) {
  const match = text.slice(0, ADDRESS_HEAD_CHARS).match(/споживач\S*\s+м\.\s*(\p{Lu}[\p{L}'’ʼ-]*(?:\s+\p{Lu}[\p{L}'’ʼ-]*)?)/u);
  if (!match) return null;
  const city = match[1].split(/\s+/).map((word) => word[0] + word.slice(1).toLowerCase()).join(' ');
  return `для споживачів м. ${city}`;
}
// Where a post says whom it is for: its opening words.
const ADDRESS_HEAD_CHARS = 120;

/**
 * Posts → whether ДТЕК's emergency outages are on for the area right now.
 *
 * @param {Array<{id:number, postedAt:string, text:string}>} posts
 * @param {{ now?: Date, area?: 'oblast'|'city'|'dnipro'|'own', maxAgeMs?: number, skip?: RegExp }} options `oblast` for Київщина,
 *   `city` for Київ, `dnipro` for Дніпро and its oblast, `own` for an operator's own channel, where every post is about its oblast.
 *   `skip`: posts whose opening words match it are for people the region's table is not about, and neither start nor end anything —
 *   on ЦЕК's channel, Павлоград's consumers «які відключаються за окремим графіком», a grid of two queues the app does not carry.
 * @returns {{ active: boolean, since: string|null, note: string|null }}
 */
export function readEmergency(posts, { now = new Date(), area = 'oblast', maxAgeMs = MAX_AGE_MS, skip = null } = {}) {
  const wanted = area === 'own' ? EVERY_POST : area === 'city' ? CITY : area === 'dnipro' ? DNIPRO : OBLAST;
  const since = now.getTime() - Math.max(LOOKBACK_MS, maxAgeMs);
  const ordered = posts
    .filter((post) => Date.parse(post.postedAt) >= since && Date.parse(post.postedAt) <= now.getTime() + 5 * 60 * 1000)
    .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt) || a.id - b.id);

  let state = null;
  for (const post of ordered) {
    const text = area === 'own' ? (post.text ?? '').slice(0, OWN_HEAD_CHARS) : (post.text ?? '');
    if (!wanted.test(headOf(text))) continue;
    if (skip && skip.test(text.slice(0, ADDRESS_HEAD_CHARS))) continue;
    const ended = ENDED.some((pattern) => pattern.test(text));
    const blackout = area === 'own' ? BLACKOUT.exec(text) : null;
    if (APPLIED.test(text) || GAV_APPLIED.test(text) || ACCIDENT.some((pattern) => pattern.test(text)) || blackout) {
      // Edited in place with «UPD: … скасовані»: the same post that announced it ends it.
      const said = blackout ? blackout[1].trim().replace(/\s+/g, ' ') : null;
      state = ended ? null : { at: post.postedAt, note: districtsOf(text) ?? said ?? (area === 'own' ? addresseeOf(text) : null) };
    } else if (ended || RESTORED.test(text)) {
      state = null;
    }
  }
  const fresh = state && now.getTime() - Date.parse(state.at) <= maxAgeMs;
  return fresh ? { active: true, since: state.at, note: state.note } : { active: false, since: null, note: null };
}

// Київ and Київщина both read the one page: a cycle asks for it once, not per region.
const PAGE_TTL_MS = 60 * 1000;
const pages = new Map();
export function pageOf(channel) {
  const held = pages.get(channel);
  if (held && Date.now() - held.at < PAGE_TTL_MS) return held.posts;
  const posts = fetchChannel(channel);
  pages.set(channel, { at: Date.now(), posts });
  posts.catch(() => { if (pages.get(channel)?.posts === posts) pages.delete(channel); });
  return posts;
}

/** A reader over posts an adapter already has, for `withChannelEmergency`: the channel is not asked twice. */
export const readerOf = (posts) => async ({ area = 'own', now = new Date(), maxAgeMs, skip } = {}) =>
  readEmergency(posts, { area, now, maxAgeMs, skip });

/** The channel's last page, read for `area`. Throws when it cannot be fetched. */
export async function readEmergencyFromChannel({ channel = CHANNEL, area = 'oblast', now = new Date(), maxAgeMs, skip } = {}) {
  return readEmergency(await pageOf(channel), { now, area, maxAgeMs, skip });
}
