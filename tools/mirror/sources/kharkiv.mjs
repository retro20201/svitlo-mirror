import { fetchChannel, gpvSnapshot } from '../lib/telegram.mjs';
import { readerOf } from '../lib/dtek-emergency.mjs';
import { withChannelEmergency } from './dtek.mjs';

const CHANNEL = 'kharkivenergy';

/**
 * АТ «Харківобленерго» — the ГПВ tables as broadcast to the operator's own 74.6K subscribers.
 *
 * Their website (now oblenergo.kharkiv.ua) answers only Ukrainian IPs, and re-posts the same text
 * as news with a date-only stamp, so revisions there cannot be ordered. The tables go out on
 * @kharkivenergy verbatim, the operator's declared public channel, so the schedule is read there.
 *
 * Харків's own wrinkles, all handled in `lib/telegram.mjs`:
 *  - ranges separated by ';', ends written as "24:00";
 *  - queues merged onto one row when idle — "2.1, 2.2 не вимикаються";
 *  - the occasional dash typed as a colon ("1.2 07:00:14:00");
 *  - since spring 2026, only the subqueues switched off ("2.1 20:30-22:00" and three more rows);
 *  - "Графіки погодинних відключень … скасовано до 14:00", which takes hours back.
 *
 * The same channel announces «графіки аварійних відключень» (2 and 3 November 2026: «В Харківській області
 * застосовуються аварійні відключення», «У Харківській області введено графіки аварійних відключень …»). The table
 * does not change then, so the posts already fetched for it are read for the announcement too
 * (lib/dtek-emergency.mjs, area 'own').
 */
export async function fetchRegion(region) {
  const posts = await fetchChannel(CHANNEL);
  const snapshot = await gpvSnapshot({ region, channel: CHANNEL, source: 'kharkiv', posts });
  return withChannelEmergency(snapshot, region, {
    read: readerOf(posts),
    log: (line) => console.log(`[emergency] ${line}`)
  });
}
