import { gpvSnapshot } from '../lib/telegram.mjs';

/**
 * АТ «Харківобленерго» — the ГПВ tables as broadcast to the operator's own 74.6K subscribers.
 *
 * Their website is unreachable to any automated client (the region is recorded as `blocked` for
 * exactly that reason), but the same tables go out on @kharkivenergy verbatim, and that channel
 * is the operator's declared public channel. So the schedule is read there instead of pushing at
 * a door the operator deliberately shut.
 *
 * Харків's own wrinkles, all handled in `lib/telegram.mjs`:
 *  - ranges separated by ';', ends written as "24:00";
 *  - queues merged onto one row when idle — "2.1, 2.2 не вимикаються";
 *  - the occasional dash typed as a colon ("1.2 07:00:14:00").
 */
export async function fetchRegion(region) {
  return gpvSnapshot({ region, channel: 'kharkivenergy', source: 'kharkiv' });
}
