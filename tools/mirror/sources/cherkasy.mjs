import { fetchChannel, gpvSnapshot } from '../lib/telegram.mjs';
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
export async function fetchRegion(region) {
  const posts = await fetchChannel(CHANNEL);
  const snapshot = await gpvSnapshot({ region, channel: CHANNEL, source: 'cherkasy', posts });
  return withChannelEmergency(snapshot, region, {
    read: readerOf(posts),
    log: (line) => console.log(`[emergency] ${line}`)
  });
}
