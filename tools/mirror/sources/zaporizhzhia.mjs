import { gpvSnapshot } from '../lib/telegram.mjs';

/**
 * АТ «Запоріжжяобленерго» — ГПВ tables from @Zaporizhzhyaoblenergo_news (87.5K subscribers).
 *
 * This is the channel that makes the "latest post per *date*" rule non-negotiable: Запоріжжя
 * revises a day up to five times, and routinely posts tomorrow's table an hour before amending
 * today's, so reading the newest post as "today" gets it wrong on most days of the season.
 *
 * Since April 2026 they list only the subqueues switched off ("Решта черг/ підчерг у ГПВ не
 * задіяна"), sometimes stacked one window per line under "⚡ Черга 1.1", and edit posts in place
 * ("ОНОВЛЕНО о 20:20"). Late-evening and overnight revisions go to their website only — which
 * answers only Ukrainian IPs — so this channel can trail the site after about 23:00.
 *
 * They publish on a half-hour grid ("00:00 – 00:30, 04:30 – 09:30"), which is finer than the
 * canonical hour cell — the pairs fold back through `hourStateFromHalves`, so the first/second
 * half-hour codes ДТЕК already carries survive intact rather than being rounded away.
 */
export async function fetchRegion(region) {
  return gpvSnapshot({ region, channel: 'Zaporizhzhyaoblenergo_news', source: 'zaporizhzhia' });
}
