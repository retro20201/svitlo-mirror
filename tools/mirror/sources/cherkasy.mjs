import { gpvSnapshot } from '../lib/telegram.mjs';

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
 * Черкаси's own wrinkle: they close the last window of a day with "20:30 – 00:00" rather than
 * "24:00", which `lib/telegram.mjs` reads as midnight along with "23:59".
 */
export async function fetchRegion(region) {
  return gpvSnapshot({ region, channel: 'pat_cherkasyoblenergo', source: 'cherkasy' });
}
