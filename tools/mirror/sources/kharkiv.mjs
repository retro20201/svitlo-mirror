import { gpvSnapshot } from '../lib/telegram.mjs';

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
 */
export async function fetchRegion(region) {
  return gpvSnapshot({ region, channel: 'kharkivenergy', source: 'kharkiv' });
}
