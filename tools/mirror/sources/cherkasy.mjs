import { fetchChannel, gpvSnapshot, parseGpvPost, scheduleFromPosts } from '../lib/telegram.mjs';
import { readerOf } from '../lib/dtek-emergency.mjs';
import { withChannelEmergency } from './dtek.mjs';

const CHANNEL = 'pat_cherkasyoblenergo';

/**
 * АТ «Черкасиобленерго» — ГПВ tables from @pat_cherkasyoblenergo (139K subscribers).
 *
 * Черкаси also runs a first-party address→черга API at
 * `cabinet.cherkasyoblenergo.com/api_new/disconn.php`, and it answers today, out of season. It is
 * deliberately not used here. Reaching a queue label through it means walking
 * department→city→street→house→**особовий рахунок**: dozens of requests per run against a small
 * operator's server, and the last hop hands back strangers' account numbers and addresses. The
 * mirror has no business collecting either, and the labels it would recover are the national
 * 1.1–6.2 the channel already prints. That API belongs to a per-user address lookup in the app,
 * where the user supplies their own address, not to a background poller.
 *
 * Черкаси's own wrinkles: they close the last window of a day with "20:30 – 00:00" rather than
 * "24:00", which `lib/telegram.mjs` reads as midnight along with "23:59"; their tables list only
 * the subqueues switched off; and an "Оновлений графік" lists only what is ongoing or still ahead,
 * so it overrides the day from the moment it is posted, not the hours already gone.
 *
 * The same channel tells its subscribers when Укренерго's command brings «графіки аварійних відключень (ГАВ)»
 * on top of the ГПВ — «3 листопада з 03:16 по Черкаській області застосовані графіки аварійних відключень …
 * Також продовжують діяти графіки погодинних відключень». The table does not change then and the lights go
 * off outside it (a person in Черкаси wrote at 08:20 that they were off, the table said on — 3 November 2026),
 * so the post is read from the posts already fetched for the schedule (lib/dtek-emergency.mjs, area 'own').
 */
/**
 * Two tables in one post. After the attacks of 17 November 2026 part of Уманський район runs on «тимчасові індивідуальні графіки»,
 * and the day's post carries them under the region's own table, with the same queue labels:
 *
 *   🔹 Години відсутності електропостачання по області (крім ВСП «Уманські енергетичні мережі», Жашківської, … філій):
 *   2.2 11:00 - 13:00, 17:00 - 19:00, 23:00 - 24:00
 *   🔹 Тимчасові індивідуальні графіки відключень електроенергії для споживачів ВСП «Уманські енергетичні мережі», …
 *   2.2 00:00 - 03:00, 06:00 - 09:00, 12:00 - 15:00, 18:00 - 21:00
 *
 * Read as one table the two rows of 2.2 add up, and the whole region's 2.2 was shown sixteen dark hours where the operator gave it
 * five (18 and 19 November 2026). So a post is taken apart first: the region's table goes to the region's queues, the branches'
 * table to queues of their own — «Уманщина 2.2» — beside them, for the people it is for.
 */
const ROW = /^\s*[1-6]\.[12]\s+\d{1,2}:\d{2}\s*-/;
const BRANCH_TABLE = /індивідуальн\S*\s+графік/iu;
/** Once there are two tables the region's own says whose it is: «… по області (крім ВСП «Уманські енергетичні мережі», …)». */
const REGION_TABLE = /Години\s+відсутності[^\n]*по\s+області/iu;
/** Fewer rows than this under the branches' wording and no «по області» is the branches' table posted alone, not the region's. */
const REGION_ROWS = 8;

/** A post as the two it may be: `{ region, branches }`, either of them null. */
export function tablesOf(post) {
  const lines = post.text.split('\n');
  const firstRow = lines.findIndex((line) => ROW.test(line));
  if (firstRow < 0) return { region: post, branches: null };

  const second = lines.findIndex((line, index) => index > firstRow && BRANCH_TABLE.test(line));
  if (second >= 0) {
    return {
      region: { ...post, text: lines.slice(0, second).join('\n') },
      // The day is named once, at the top of the post: the branches' table keeps those lines.
      branches: { ...post, text: [...lines.slice(0, firstRow), ...lines.slice(second)].join('\n') }
    };
  }
  // The branches' table on its own («… в частині Уманського району … застосовуються тимчасові індивідуальні графіки», 17 November):
  // taken for the region's it would switch every other queue of the region on from the minute it went out.
  const above = lines.slice(0, firstRow);
  const alone = above.some((line) => BRANCH_TABLE.test(line)) && !above.some((line) => REGION_TABLE.test(line))
    && lines.filter((line) => ROW.test(line)).length < REGION_ROWS;
  return alone ? { region: null, branches: post } : { region: post, branches: null };
}

/** «2.2» of the branches' table → its key and name beside the region's `GPV2.2` «Черга 2.2». Numbered as ДТЕК numbers ЦЕК's queues under Дніпро. */
export const branchKey = (label) => `GPV100${label}`;
export const branchName = (label) => `Уманщина ${label}`;

/**
 * The branches' queues added to the region's snapshot. They are listed for as long as a day the snapshot holds had a table of
 * theirs; on a day whose post has none they follow the region's own row, which is what the end of «тимчасові» means. Nothing is
 * added when no post in reach carries such a table: the names leave the list with the schedules.
 */
export function withBranchQueues(snapshot, branchPosts, options = {}) {
  const days = snapshot?.fact?.data;
  if (!days || Array.isArray(days) || !branchPosts.length) return snapshot;

  const { fact } = scheduleFromPosts(branchPosts, options);
  const labels = new Set();
  for (const post of branchPosts) {
    const parsed = parseGpvPost(post);
    if (!parsed?.halves || !(parsed.epoch in days)) continue;
    for (const line of post.text.split('\n')) if (ROW.test(line)) labels.add(line.trim().slice(0, 3));
  }
  if (!labels.size) return snapshot;

  const names = {};
  for (const label of [...labels].sort()) {
    names[branchKey(label)] = branchName(label);
    for (const [epoch, queues] of Object.entries(days)) {
      const own = fact[epoch]?.[`GPV${label}`] ?? queues[`GPV${label}`];
      if (own) queues[branchKey(label)] = own;
    }
  }
  return { ...snapshot, preset: { ...snapshot.preset, sch_names: { ...snapshot.preset.sch_names, ...names } } };
}

export async function fetchRegion(region) {
  const posts = await fetchChannel(CHANNEL);
  const tables = posts.map(tablesOf);
  const snapshot = withBranchQueues(
    await gpvSnapshot({ region, channel: CHANNEL, source: 'cherkasy', posts: tables.map((t) => t.region).filter(Boolean) }),
    tables.map((t) => t.branches).filter(Boolean)
  );
  // The emergency posts are read from the channel as it is: they carry no table to take apart.
  return withChannelEmergency(snapshot, region, {
    read: readerOf(posts),
    log: (line) => console.log(`[emergency] ${line}`)
  });
}
