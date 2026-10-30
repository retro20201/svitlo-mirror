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
/** An accident ends with a post less often than an order does («знову зі світлом» is said for a city, seldom for an
 *  oblast's districts), and its warning would stay up after the repair: shorter, and the next post renews it. */
export const ACCIDENT_MAX_AGE_MS = 8 * 3600 * 1000;
/** The preview page holds ~16 posts, two or three days; anything older is not looked at. */
const LOOKBACK_MS = 36 * 3600 * 1000;

// «застосовані / застосовуються / запроваджено екстрені відключення» (an order of Укренерго), «діють екстрені відключення»
// (after an attack, in the districts a post names: «Через пошкодження на магістральних мережах … діють екстрені відключення»).
const APPLIED = /(?:(?:застосов|запроваджен)\S*\s+|діють\s+)екстрен\S*\s+відключен/iu;
// The operator's own word that the schedule does not hold, after an attack on its equipment: «через атаку … фіксуються
// аварійні відключення», «аварія на пошкодженому обстрілами обладнанні, графіки тимчасово не діють в … районах».
// «тимчасово» or «наразі» is what tells it from the reminder under every order — «під час екстрених відключень графіки
// не діють» — which is no announcement. A plain «через аварію … відсутнє електропостачання» is a fault on a line, not here.
const ACCIDENT = [
  /аварійн\S*\s+відключен/iu,
  /графіки\s+(?:відключень\s+)?(?:\S+\s+){0,4}?(?:тимчасово|наразі)\s+не\s+діють/iu
];
// «… родин знову зі світлом після обстрілів»: the area is back. Only for a post that announces nothing itself — one
// can say both («170 000 родин знову зі світлом … в частині Бучанського району діють екстрені відключення»).
const RESTORED = /знову\s+зі\s+світлом/iu;
const ENDED = [
  /екстрен\S*\s+відключен\S*\s+скасован/iu,
  /скасован\S*\s+екстрен\S*\s+відключен/iu,
  /повертаєм\S*\s+до\s+графік/iu,
  /повертаютьс\S*\s+(?:до\s+)?графік/iu
];

/** Where a post says it is about: the words before the first colon of its first line. */
function headOf(text) {
  const line = text.split('\n')[0] ?? '';
  const colon = line.indexOf(':');
  return colon > 0 ? line.slice(0, colon) : line;
}

const OBLAST = /київщин|київськ\S*\s+област/iu;
// «Київ», and the city as the channel declines it: «Правий берег Києва».
const CITY = /(?<![\p{L}])(?:київ|києв\p{L}*)(?![\p{L}])/iu;
const DNIPRO = /дніпр/iu;

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
 * Posts → whether ДТЕК's emergency outages are on for the area right now.
 *
 * @param {Array<{id:number, postedAt:string, text:string}>} posts
 * @param {{ now?: Date, area?: 'oblast'|'city'|'dnipro' }} options `oblast` for Київщина, `city` for Київ, `dnipro`
 *   for Дніпро and its oblast
 * @returns {{ active: boolean, since: string|null, note: string|null }}
 */
export function readEmergency(posts, { now = new Date(), area = 'oblast' } = {}) {
  const wanted = area === 'city' ? CITY : area === 'dnipro' ? DNIPRO : OBLAST;
  const since = now.getTime() - LOOKBACK_MS;
  const ordered = posts
    .filter((post) => Date.parse(post.postedAt) >= since && Date.parse(post.postedAt) <= now.getTime() + 5 * 60 * 1000)
    .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt) || a.id - b.id);

  let state = null;
  for (const post of ordered) {
    const text = post.text ?? '';
    if (!wanted.test(headOf(text))) continue;
    const ended = ENDED.some((pattern) => pattern.test(text));
    const order = APPLIED.test(text);
    if (order || ACCIDENT.some((pattern) => pattern.test(text))) {
      // Edited in place with «UPD: … скасовані»: the same post that announced it ends it.
      state = ended ? null : { at: post.postedAt, note: districtsOf(text), accident: !order };
    } else if (ended || RESTORED.test(text)) {
      state = null;
    }
  }
  const fresh = state && now.getTime() - Date.parse(state.at) <= (state.accident ? ACCIDENT_MAX_AGE_MS : MAX_AGE_MS);
  return fresh ? { active: true, since: state.at, note: state.note } : { active: false, since: null, note: null };
}

// Київ and Київщина both read the one page: a cycle asks for it once, not per region.
const PAGE_TTL_MS = 60 * 1000;
const pages = new Map();
function pageOf(channel) {
  const held = pages.get(channel);
  if (held && Date.now() - held.at < PAGE_TTL_MS) return held.posts;
  const posts = fetchChannel(channel);
  pages.set(channel, { at: Date.now(), posts });
  posts.catch(() => { if (pages.get(channel)?.posts === posts) pages.delete(channel); });
  return posts;
}

/** The channel's last page, read for `area`. Throws when it cannot be fetched. */
export async function readEmergencyFromChannel({ channel = CHANNEL, area = 'oblast', now = new Date() } = {}) {
  return readEmergency(await pageOf(channel), { now, area });
}
