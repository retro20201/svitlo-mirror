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

export async function fetchRegion(region) {
  const file = REGION_FILES[region.id];
  if (!file) throw new Error(`dtek adapter has no file for "${region.id}"`);

  const payload = await getJSON(`${UPSTREAM}/${file}.json`);
  const snapshot = {
    ...payload,
    regionId: region.id,
    regionAffiliation: payload.regionAffiliation || region.title,
    meta: { ...(payload.meta ?? {}), source: 'dtek' }
  };

  const problems = validate(snapshot);
  if (problems.length) throw new Error(problems.join('; '));
  return snapshot;
}
