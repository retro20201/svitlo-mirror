/**
 * «За інформацією споживачів»: what the people who share their «Світло зникло / з’явилося» marks say about a queue, counted.
 *
 * A report is one document in Firestore (`firebase/firestore.rules` says who may write it): `d` a code of the device that changes
 * every day, `r` region, `q` queue, `s` on or off, `t` the server's time. Phones can only write; this reads them with the mirror's
 * service account and publishes `v1/crowd.json` — no device code leaves this file.
 *
 * A queue is said to have its light back (or lost) only when several DIFFERENT devices say so within a short while. Devices are
 * cheap to fake, so this is a soft signal for a line of text under the schedule, never a change to the schedule itself.
 */

/** How long a report speaks: «the light is back» is news for twenty minutes. */
export const WINDOW_MS = 20 * 60 * 1000;
/** Devices that must agree before anything is said. */
export const THRESHOLD = 3;
/** The hour of the rule «one report an hour from a device for a place and a state» (firestore.rules). */
export const BUCKET_MS = 60 * 60 * 1000;

const DEVICE = /^[0-9a-f]{16}$/;
const REGION = /^[a-z0-9-]{2,24}$/;
const QUEUE = /^[A-Za-z0-9._-]{1,16}$/;

export const hourBucket = (ms) => Math.floor(ms / BUCKET_MS);

/** The document name the rules demand: this device, this place, this state, this hour. */
export const reportId = ({ d, r, q, s }, serverMs) => `${d}_${r}_${q}_${s}_${hourBucket(serverMs)}`;

/** Whether a report has the shape the rules allow. */
export function wellFormed(report) {
  return Boolean(report)
    && DEVICE.test(report.d ?? '') && REGION.test(report.r ?? '') && QUEUE.test(report.q ?? '')
    && (report.s === 'on' || report.s === 'off');
}

/**
 * The rules, as a function: what Firestore would let be created. Kept beside the rules so a change to one is a change to both,
 * and tested; the live rules are checked after deploying by `crowd-smoke.mjs`.
 */
export function acceptedByRules(name, data, serverMs, existing = new Set()) {
  if (existing.has(name)) return false; // update is not allowed
  const keys = Object.keys(data ?? {}).sort().join(',');
  return keys === 'd,q,r,s,t' && wellFormed(data) && name === reportId(data, serverMs);
}

/**
 * `reports`: `{ d, r, q, s, t }` with `t` in milliseconds. `known`: region ids to accept, when it is given.
 * @returns {{ queues: Record<string, Record<string, { state: 'on'|'off', count: number, at: string }>> }}
 */
export function aggregate(reports, nowMs, { known } = {}) {
  // The latest word of each device about each queue: someone who said «off» and then «on» says «on».
  const latest = new Map();
  for (const report of reports) {
    if (!wellFormed(report)) continue;
    if (known && !known.has(report.r)) continue;
    if (!(report.t <= nowMs + 60_000) || nowMs - report.t > WINDOW_MS) continue;
    const key = `${report.r}\n${report.q}\n${report.d}`;
    const held = latest.get(key);
    if (!held || report.t > held.t) latest.set(key, report);
  }

  const places = new Map();
  for (const report of latest.values()) {
    const key = `${report.r}\n${report.q}`;
    const place = places.get(key) ?? { r: report.r, q: report.q, on: [], off: [] };
    place[report.s].push(report.t);
    places.set(key, place);
  }

  const queues = {};
  for (const { r, q, on, off } of places.values()) {
    // Said when one side has enough devices and is at least twice the other: a contested queue says nothing.
    const state = on.length >= THRESHOLD && on.length >= 2 * off.length ? 'on'
      : off.length >= THRESHOLD && off.length >= 2 * on.length ? 'off' : null;
    if (!state) continue;
    const times = state === 'on' ? on : off;
    (queues[r] ??= {})[q] = { state, count: times.length, at: new Date(Math.max(...times)).toISOString() };
  }
  return { queues };
}
