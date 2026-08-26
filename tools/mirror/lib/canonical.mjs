/**
 * The one shape the app decodes.
 *
 * It is ДТЕК's `DisconSchedule` layout, deliberately: that source is the richest (weekly preset
 * plus half-hour states) and the app already speaks it. Every other operator's format is
 * normalised *into* this rather than the app learning a second dialect — one decoder, one engine,
 * one set of tests, no per-region branches in Swift.
 */

/** Укренерго's national queue scheme. Most operators outside ДТЕК use exactly these. */
export const NATIONAL_QUEUES = [
  '1.1', '1.2', '2.1', '2.2', '3.1', '3.2',
  '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'
];

/** ДТЕК's own wording, reused so the app shows operators' language rather than ours. */
export const STATE_LABELS = {
  yes: 'Світло є',
  maybe: 'Можливо відключення',
  no: 'Світла немає',
  first: 'Світла не буде перші 30 хв.',
  second: 'Світла не буде другі 30 хв',
  mfirst: 'Світла можливо не буде перші 30 хв.',
  msecond: 'Світла можливо не буде другі 30 хв'
};

/** The 24 hour rows, `{ "1": ["00-01", "00:00", "01:00"], ... }`. */
export function hourWindows() {
  const windows = {};
  for (let hour = 1; hour <= 24; hour++) {
    const pad = (n) => String(n).padStart(2, '0');
    windows[String(hour)] = [
      `${pad(hour - 1)}-${pad(hour)}`,
      `${pad(hour - 1)}:00`,
      `${pad(hour)}:00`
    ];
  }
  return windows;
}

/** `{ "GPV1.1": "Черга 1.1", ... }` for a plain list of queue labels. */
export function queueNames(labels) {
  return Object.fromEntries(labels.map((label) => [`GPV${label}`, `Черга ${label}`]));
}

/**
 * Collapses two half-hour states into the single cell ДТЕК would have written.
 *
 * Operators that publish native half-hours (Миколаїв) go through here. The two mixed cases ДТЕК
 * has no code for — one half definitely dark, the other only *maybe* — resolve to `no`. Erring
 * toward "there will be no light" costs the user a charged power bank; erring the other way costs
 * them a dead fridge, so the asymmetry is intentional.
 */
export function hourStateFromHalves(first, second) {
  const key = `${first}|${second}`;
  return {
    'on|on': 'yes',
    'off|off': 'no',
    'possible|possible': 'maybe',
    'off|on': 'first',
    'on|off': 'second',
    'possible|on': 'mfirst',
    'on|possible': 'msecond',
    'off|possible': 'no',
    'possible|off': 'no'
  }[key] ?? 'yes';
}

/**
 * @param {object} input
 * @param {string} input.regionId
 * @param {string} input.title          human label, e.g. "Миколаївська область"
 * @param {Record<string,string>} input.queues   queue key → display name
 * @param {Record<string, Record<string, Record<string,string>>>} [input.preset]
 *        queue → weekday 1–7 → hour 1–24 → state. Omit when the operator publishes no weekly plan.
 * @param {Record<string, Record<string, Record<string,string>>>} [input.fact]
 *        day-start epoch (seconds, Europe/Kyiv midnight) → queue → hour → state.
 * @param {number|null} [input.todayEpoch]
 * @param {string|null} [input.update]  the operator's own timestamp, shown verbatim
 */
export function buildSnapshot({
  regionId, title, queues, preset = {}, fact = {}, todayEpoch = null, update = null, source
}) {
  return {
    regionId,
    regionAffiliation: title,
    lastUpdated: new Date().toISOString(),
    fact: {
      // An empty object here would be equally valid, but upstream ДТЕК emits `[]` and the app's
      // decoder is tested against that shape — so keep producing it.
      data: Object.keys(fact).length ? fact : [],
      update,
      today: todayEpoch
    },
    preset: {
      sch_names: queues,
      time_zone: hourWindows(),
      time_type: STATE_LABELS,
      data: preset,
      updateFact: update
    },
    meta: { schemaVersion: '1.0.0', source }
  };
}

/** Midnight in Europe/Kyiv for a date, in epoch seconds — the key `fact.data` is indexed by. */
export function kyivDayStart(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  const iso = `${get('year')}-${get('month')}-${get('day')}`;
  // Kyiv is UTC+2 or +3; resolve by asking the formatter what that wall time maps back to.
  for (const offset of ['+03:00', '+02:00']) {
    const candidate = new Date(`${iso}T00:00:00${offset}`);
    const check = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false
    }).format(candidate);
    if (check.startsWith('00')) return Math.floor(candidate.getTime() / 1000);
  }
  return Math.floor(new Date(`${iso}T00:00:00+02:00`).getTime() / 1000);
}

/**
 * True when the snapshot actually carries a schedule (a weekly plan or at least one published
 * day). Its absence is NOT a fault: outside the outage season operators publish nothing, and
 * "вимкнень не заплановано" is the correct thing for the app to say. Kept separate from
 * `validate` so a healthy quiet source is never mistaken for a broken one.
 */
export function hasSchedule(snapshot) {
  const preset = snapshot.preset ?? {};
  if (Object.keys(preset.data ?? {}).length > 0) return true;
  const factData = snapshot.fact?.data;
  return Boolean(factData) && !Array.isArray(factData) && Object.keys(factData).length > 0;
}

/** Problems that must stop a snapshot from being published, as a list of strings. */
export function validate(snapshot) {
  const problems = [];
  if (!snapshot.regionId) problems.push('regionId missing');

  const preset = snapshot.preset;
  if (!preset) {
    problems.push('preset missing');
    return problems;
  }
  if (Object.keys(preset.sch_names ?? {}).length === 0) problems.push('no queues');
  if (Object.keys(preset.time_zone ?? {}).length !== 24) problems.push('time_zone is not 24 rows');

  for (const [queue, byDay] of Object.entries(preset.data ?? {})) {
    const days = Object.keys(byDay);
    if (days.length !== 7) { problems.push(`preset ${queue}: ${days.length} weekdays`); break; }
    const hours = Object.keys(byDay[days[0]] ?? {});
    if (hours.length !== 24) { problems.push(`preset ${queue}: ${hours.length} hours`); break; }
  }

  const factData = snapshot.fact?.data;
  if (factData && !Array.isArray(factData)) {
    for (const [day, queues] of Object.entries(factData)) {
      if (!/^\d{9,11}$/.test(day)) { problems.push(`fact key "${day}" is not an epoch`); break; }
      const first = Object.values(queues)[0] ?? {};
      if (Object.keys(first).length !== 24) { problems.push(`fact ${day}: ${Object.keys(first).length} hours`); break; }
    }
  }

  return problems;
}
