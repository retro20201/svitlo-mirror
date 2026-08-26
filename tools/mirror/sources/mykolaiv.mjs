import { getJSON } from '../lib/http.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart } from '../lib/canonical.mjs';

/**
 * АТ «Миколаївобленерго» — a first-party JSON API on the operator's own site.
 *
 * Their model differs from ДТЕК's in two ways that matter:
 *  - queues are ГАВ 1–10 / ГАВ(Р) / СГАВ 1–3, not the national 1.1–6.2, so queue keys are passed
 *    through with their own labels instead of being forced into the national scheme;
 *  - the grid is natively 48 half-hour slots, which is *more* precise than the canonical hour
 *    cell — pairs of slots are folded back with `hourStateFromHalves`, which is exactly the
 *    information ДТЕК's `first`/`second` codes carry.
 *
 * There is no weekly plan here, only published days, so `preset.data` stays empty and the app
 * shows today/tomorrow without a week forecast.
 */
const BASE = 'https://off.energy.mk.ua';

/** Queue groups the site itself offers: 1 = ГАВ, 2 = ГАВ(Р), 3 = СГАВ. */
const QUEUE_TYPES = [
  { id: 1, prefix: 'ГАВ' },
  { id: 2, prefix: 'ГАВ', suffix: '(Р)' },
  { id: 3, prefix: 'СГАВ' }
];

/**
 * `SURE_OFF` and `ENABLE` are the only codes observable outside the outage season. Anything else
 * the operator introduces is treated as "possible" rather than guessed at: promising light that
 * does not arrive is the failure that makes people delete the app, and announcing darkness that
 * never comes is the failure that makes them ignore it. "Можливе" is honest about not knowing.
 */
function powerState(type) {
  if (!type || type === 'ENABLE') return 'on';
  if (type === 'SURE_OFF') return 'off';
  return 'possible';
}

export async function fetchRegion(region) {
  const [timeSeries, active, ...queueGroups] = await Promise.all([
    getJSON(`${BASE}/api/schedule/time-series`),
    getJSON(`${BASE}/api/v2/schedule/active`),
    ...QUEUE_TYPES.map((type) => getJSON(`${BASE}/api/outage-queue/by-type/${type.id}`))
  ]);

  // time_series_id → index 0..47, ordered by start time.
  const slotOrder = new Map(
    [...timeSeries].sort((a, b) => a.start.localeCompare(b.start)).map((slot, index) => [slot.id, index])
  );

  const queues = {};
  const queueKeyById = new Map();
  QUEUE_TYPES.forEach((type, groupIndex) => {
    for (const queue of queueGroups[groupIndex] ?? []) {
      const label = `${type.prefix} ${queue.name}${type.suffix ?? ''}`;
      const key = `MK${type.id}-${queue.id}`;
      queues[key] = label;
      queueKeyById.set(`${type.id}:${queue.id}`, key);
      // The API returns queue ids that are only unique within a type, so the composite key stands.
      queueKeyById.set(String(queue.id), key);
    }
  });

  // day epoch → queue key → 48 half-hour states
  const halves = {};
  for (const day of Array.isArray(active) ? active : []) {
    const epoch = kyivDayStart(new Date(day.from));
    for (const entry of day.series ?? []) {
      const key = queueKeyById.get(String(entry.outage_queue_id));
      const slot = slotOrder.get(entry.time_series_id);
      if (!key || slot === undefined) continue;

      halves[epoch] ??= {};
      halves[epoch][key] ??= Array(48).fill('on');
      const next = powerState(entry.type);
      // `SURE_OFF` wins over anything already written for the slot, mirroring the operator's own
      // precedence rule.
      if (halves[epoch][key][slot] !== 'off') halves[epoch][key][slot] = next;
    }
  }

  const fact = {};
  for (const [epoch, byQueue] of Object.entries(halves)) {
    fact[epoch] = {};
    for (const [key, slots] of Object.entries(byQueue)) {
      const hours = {};
      for (let hour = 1; hour <= 24; hour++) {
        hours[String(hour)] = hourStateFromHalves(slots[(hour - 1) * 2], slots[(hour - 1) * 2 + 1]);
      }
      fact[epoch][key] = hours;
    }
  }

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues,
    fact,
    todayEpoch: kyivDayStart(),
    update: null,
    source: 'mykolaiv'
  });
}
