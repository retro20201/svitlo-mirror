import { getJSON } from '../lib/http.mjs';
import { buildSnapshot, hourStateFromHalves, kyivDayStart, queueNames } from '../lib/canonical.mjs';

/**
 * АТ «Тернопільобленерго» — via `poweron.toe.com.ua`, the operator's separate outage service.
 *
 * Their marketing site (`www.toe.com.ua`) sits behind Cloudflare, but the outage service is a
 * plain unauthenticated Symfony API Platform install that their own React front end talks to, and
 * `poweron.toe.com.ua/robots.txt` is an explicit allow-all (`User-agent: * / Disallow:`). The API
 * host serves a robots.txt carrying only content-signal commentary and no rules at all. So this is
 * the operator's own public interface used the way they publish it — two requests per run.
 *
 * `/api/actual_gpv_graphs` is the authenticated resource and answers `401 JWT Token not found`;
 * it is deliberately not touched. `/api/a_gpv_g` is the open projection of the same data and is
 * the only graph endpoint used here.
 *
 * Тернопіль uses Укренерго's national 1.1–6.2 scheme, and publishes only the currently active
 * graph — there is no weekly template, so `preset.data` stays empty and the app shows the
 * published days without a week forecast.
 */
const API = 'https://api-poweron.toe.com.ua/api';

/**
 * Half-hour codes, read off the operator's own renderer rather than guessed: it paints `"1"` dark
 * navy, `"10"` grey, everything else white, and substitutes `"0"` for any half-hour key the
 * payload omits.
 *
 * The two unknowns are split deliberately. An *absent* key means the operator never scheduled
 * anything for that half-hour, which is genuinely "light" — that is their documented default. A
 * *present* code we do not recognise means something is scheduled that we cannot name, and
 * calling that "світло є" would promise power we have no basis for; "можливо" is what we actually
 * know.
 */
function halfHourState(code) {
  if (code === undefined || code === null || code === '') return 'on';
  const value = String(code).trim();
  if (value === '1') return 'off';
  if (value === '10') return 'possible';
  if (value === '0') return 'on';
  return 'possible';
}

/** Ranked so the darker of two overlapping graphs wins the half-hour. */
const DARKNESS = { on: 0, possible: 1, off: 2 };

/**
 * ── THE UNCONFIRMED PART ──────────────────────────────────────────────────────────────────────
 * `dataJson` cannot be observed out of season: `/api/a_gpv_g` only ever serves the currently
 * active graph, so between restriction periods it returns `hydra:totalItems: 0` no matter what
 * `after`/`before` are set to, and nothing archived a live payload. The shape below is taken from
 * the operator's own published front-end bundle, which reads it as:
 *
 *   dataJson = { "<черга>": { times: { "HH:00": code, "HH:30": code, … } } }
 *
 * with 48 half-hour keys and the queue key optionally carrying a "#suffix" (their page strips it
 * with `key.split("#")[0]` before display — two graphs can cover the same черга in different
 * localities). That is a first-party reading of the field, but it is not a captured payload, so
 * everything here is written to return nothing rather than to guess when the shape does not
 * match. A day the parser cannot read is a day the app says nothing about, which is recoverable;
 * a day it reads wrongly is not.
 */
function halvesFromTimes(times) {
  if (!times || typeof times !== 'object' || Array.isArray(times)) return null;
  const halves = [];
  for (let hour = 0; hour < 24; hour++) {
    const hh = String(hour).padStart(2, '0');
    halves.push(halfHourState(times[`${hh}:00`]), halfHourState(times[`${hh}:30`]));
  }
  return halves;
}

/**
 * The operator's page formats `dateGraph` in UTC, so the calendar day is the UTC one. Noon lands
 * safely inside it whichever way Kyiv's offset falls, and `kyivDayStart` turns that into the
 * midnight the canonical format keys days by.
 */
function dayEpoch(dateGraph) {
  const ymd = String(dateGraph ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return kyivDayStart(new Date(`${ymd}T12:00:00Z`));
}

/**
 * `hydra:member` → canonical `fact`, plus the queue labels and publication timestamp seen in it.
 * Exported so the hour mapping can be tested against a fixture without touching the network.
 */
export function factFromGraphs(members) {
  const labels = new Set();
  const published = [];
  /** day epoch → queue key → 48 half-hour states */
  const halves = {};

  for (const graph of Array.isArray(members) ? members : []) {
    const epoch = dayEpoch(graph?.dateGraph);
    const data = graph?.dataJson;
    if (epoch === null || !data || typeof data !== 'object' || Array.isArray(data)) continue;
    if (typeof graph.dateCreate === 'string') published.push(graph.dateCreate);

    for (const [rawKey, entry] of Object.entries(data)) {
      const label = String(rawKey).split('#')[0].trim();
      const slots = halvesFromTimes(entry?.times);
      if (!label || !slots) continue;

      labels.add(label);
      halves[epoch] ??= {};
      const merged = (halves[epoch][`GPV${label}`] ??= Array(48).fill('on'));
      // Two graphs can carry the same черга for the same day when localities are split, and
      // nothing in the payload says which address each covers. The darker half-hour wins: a user
      // who prepared for an outage that never came has charged a power bank for nothing, one who
      // was promised light that never came has lost what was in their fridge.
      for (let slot = 0; slot < 48; slot++) {
        if (DARKNESS[slots[slot]] > DARKNESS[merged[slot]]) merged[slot] = slots[slot];
      }
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

  return { fact, labels: [...labels], update: published.sort().at(-1) ?? null };
}

/**
 * The window their own page asks for, widened by half a day at the far end: their `before` sits
 * exactly on tomorrow's boundary, and a graph dated tomorrow is the one the app most wants.
 */
function graphWindow(now = new Date()) {
  const day = 86_400_000;
  const utcDay = (offset) => new Date(now.getTime() + offset * day).toISOString().slice(0, 10);
  return { after: `${utcDay(-1)}T00:00:00+00:00`, before: `${utcDay(2)}T00:00:00+00:00` };
}

/** Numeric order, so 1.1 … 6.2 read as a person would list them rather than as strings. */
function byQueueNumber(a, b) {
  return (Number.parseFloat(a) - Number.parseFloat(b)) || a.localeCompare(b);
}

export async function fetchRegion(region) {
  const window = graphWindow();
  const query = new URLSearchParams({ after: window.after, before: window.before });

  const [groups, graphs] = await Promise.all([
    getJSON(`${API}/pw-accounts/building-groups`),
    // An unreadable graph must not take the queue list down with it. Out of season this
    // collection is legitimately empty, and the region is then published as seasonal rather than
    // broken — so a failure here degrades to "queues, no schedule" instead of losing the region.
    getJSON(`${API}/a_gpv_g?${query}`).catch(() => null)
  ]);

  let parsed = { fact: {}, labels: [], update: null };
  try {
    parsed = factFromGraphs(graphs?.['hydra:member']);
  } catch {
    parsed = { fact: {}, labels: [], update: null };
  }

  // Buildings assigned to no підчерга come back as an empty `chergGpv`; that is a row in their
  // address data, not a queue.
  const listed = (groups?.buildingGroups ?? [])
    .map((group) => String(group?.chergGpv ?? '').trim())
    .filter(Boolean);

  const labels = [...new Set([...listed, ...parsed.labels])].sort(byQueueNumber);
  // No substitute list here on purpose. This endpoint is the one thing that works out of season,
  // so its going empty means the service changed — and a region shown with a plausible-looking
  // queue list nobody verified is worse than one the mirror reports as stale.
  if (labels.length === 0) throw new Error('building-groups returned no черги');

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: queueNames(labels),
    fact: parsed.fact,
    todayEpoch: kyivDayStart(),
    update: parsed.update,
    source: 'ternopil'
  });
}
