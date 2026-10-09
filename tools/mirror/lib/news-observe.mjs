/**
 * What a served region file says for schedule news: per queue and day, the half-hours definitely
 * without light; per picture day, the picture's identity; the emergency days.
 *
 * Apart from lib/news.mjs because run.sh's fingerprint covers this file and not that one. These are
 * the values the ledger keeps as bases, so a change here changes what an old base means: each
 * region's next read must be adopted silently, not compared with bases the old code wrote — 120
 * «змінено» for Київ alone. Settle, gaps, caps and texts (news.mjs) mean nothing stored, and tuning
 * them must not rebaseline every region, which would swallow a real change landing on that read.
 */

import { kyivDayStart, kyivTomorrowStart } from './canonical.mjs';
import { hasEmergencySignal } from '../regions.mjs';

// A day as 48 half-hour bits, bit i = slot i (00:00–00:30 is slot 0), as 12 hex chars.
const OFF_HALVES = new Map([['no', [0, 1]], ['first', [0]], ['second', [1]]]);

const hex = (mask) => mask.toString(16).padStart(12, '0');

/**
 * The half-hours a queue is definitely without light, as 12 hex chars; null for no queue at all.
 * `yes`, the `maybe` family, an unknown state and a missing hour all count as light, as in the
 * app's ScheduleEngine. Not `halvesFromHours`: its default for a missing hour is dark.
 */
export function offMask(hours) {
  if (!hours || typeof hours !== 'object') return null;
  let mask = 0n;
  for (let hour = 1; hour <= 24; hour++) {
    for (const half of OFF_HALVES.get(hours[String(hour)]) ?? []) mask |= 1n << BigInt((hour - 1) * 2 + half);
  }
  return hex(mask);
}

/**
 * A picture's identity. Telegram rotates a photo's CDN url on every page load, so its post link is
 * the identity there; Волинь's and Хмельницький's page links never change, so the picture's own
 * path (a dated file name) is.
 */
export function sheetKey(sheet) {
  return /^https:\/\/t\.me\//.test(sheet.sourceUrl ?? '') ? sheet.sourceUrl : sheet.imageUrl;
}

/**
 * What a served region file says about today and tomorrow, and nothing else. A queue missing from
 * a published day is absent — no mask, never "clear": Івано-Франківськ and Вінниця publish partial
 * days. A day comes from the table if there is one, else from Полтава's `quiet`, else from the
 * picture.
 */
export function observeRegion(meta, snapshot, now = new Date()) {
  const today = kyivDayStart(now);
  const tomorrow = kyivTomorrowStart(now);
  const fact = snapshot?.fact ?? {};
  const data = fact.data && !Array.isArray(fact.data) ? fact.data : {};
  const names = snapshot?.preset?.sch_names ?? {};
  const quiet = Array.isArray(fact.quiet) ? fact.quiet.map(Number) : [];
  const days = {};
  const sheets = {};
  for (const day of [today, tomorrow]) {
    const queues = data[day];
    if (queues && typeof queues === 'object' && Object.keys(queues).length) {
      const masks = {};
      for (const queue of Object.keys(names)) {
        const mask = offMask(queues[queue]);
        if (mask !== null) masks[queue] = mask;
      }
      days[day] = { state: 'fact', masks };
    } else if (quiet.includes(day)) {
      days[day] = { state: 'quiet', masks: Object.fromEntries(Object.keys(names).map((queue) => [queue, hex(0n)])) };
    } else {
      const sheet = (snapshot?.sheets ?? []).filter((candidate) => candidate.dayStart === day).at(-1);
      if (sheet) sheets[day] = { key: sheetKey(sheet), isRevision: sheet.isRevision === true };
    }
  }
  const emergency = hasEmergencySignal(meta)
    ? [...new Set((fact.emergency ?? []).map(Number))].filter((day) => day === today || day === tomorrow)
    : [];
  return { region: meta.id, title: meta.title, names, days, sheets, emergency };
}
