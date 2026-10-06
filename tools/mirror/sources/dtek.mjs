import { getJSON } from '../lib/http.mjs';
import { validate } from '../lib/canonical.mjs';

/**
 * ДТЕК regions, taken from the open `outage-data-ua` mirror (MIT) rather than scraped directly.
 *
 * ДТЕК's own pages sit behind a WAF that only a real browser gets through, so the upstream project
 * runs Playwright and publishes the extracted `DisconSchedule` verbatim. Consuming that is both
 * politer (one browser session for everyone instead of one per app) and less fragile than
 * maintaining our own headless fleet. If it ever stops, `UPSTREAM` is the only line to change.
 *
 * The payload is already in canonical shape — it *is* the shape the canonical format was modelled
 * on — so this adapter validates and passes it through rather than transforming it.
 */
const UPSTREAM = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data';

const REGION_FILES = {
  kyiv: 'kyiv',
  'kyiv-region': 'kyiv-region',
  dnipro: 'dnipro',
  odesa: 'odesa'
};

/**
 * The upstream payload as the app should get it.
 *
 * `region.queuePattern` keeps only the queues the operator actually runs: ДТЕК Київ still names
 * 120 queues and carries six template rows (1.2–6.2) from the old twelve-queue scheme, while every
 * day table it publishes uses its 60 groups «N.1».
 *
 * A template that marks nothing anywhere says nothing, and is dropped. The app draws a template day
 * as «вимкнень не заплановано», so in October 2026, with ДТЕК Київ's template clear for all 60
 * groups all week while its day tables cut them, every Kyiv user saw tomorrow and the whole week
 * green before ДТЕК had published anything. Without the template, tomorrow appears when ДТЕК
 * publishes it. The moment the operator marks anything in the template again, it is kept as before.
 */
export function shape(payload, region) {
  const keep = region.queuePattern ? (key) => region.queuePattern.test(key) : () => true;
  const preset = { ...(payload.preset ?? {}) };
  if (preset.sch_names) {
    preset.sch_names = Object.fromEntries(Object.entries(preset.sch_names).filter(([key]) => keep(key)));
  }
  const rows = Object.entries(preset.data ?? {}).filter(([key]) => keep(key));
  const saysSomething = rows.some(([, week]) =>
    Object.values(week).some((day) => Object.values(day).some((state) => state !== 'yes')));
  preset.data = saysSomething ? Object.fromEntries(rows) : {};

  return {
    ...payload,
    preset,
    regionId: region.id,
    regionAffiliation: payload.regionAffiliation || region.title,
    meta: { ...(payload.meta ?? {}), source: 'dtek' }
  };
}

export async function fetchRegion(region) {
  const file = REGION_FILES[region.id];
  if (!file) throw new Error(`dtek adapter has no file for "${region.id}"`);

  const snapshot = shape(await getJSON(`${UPSTREAM}/${file}.json`), region);

  const problems = validate(snapshot);
  if (problems.length) throw new Error(problems.join('; '));
  return snapshot;
}
