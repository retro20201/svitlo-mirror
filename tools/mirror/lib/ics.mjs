/**
 * The schedule of one queue as a calendar people can subscribe to (`webcal://`): the hours without power
 * as events, so the cut shows in Calendar, on the watch and in any other calendar app, and moves by itself
 * when the operator revises the day.
 *
 * Only what the operator PUBLISHED: days of `fact.data`, never the weekly template, which is a forecast.
 * The app's own reading of the same file, hour for hour: an hour the operator left out is light, `first` and
 * `second` are half an hour, and 24:00 is the next midnight. `maybe` is an event too, marked tentative and
 * without an alarm — a maybe is not worth waking anyone for.
 *
 * Deterministic: the same file gives the same bytes (UIDs and stamps come from the day and the hour), so a
 * cycle that changed another queue uploads nothing for this one.
 */
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { kyivDayStart, kyivTomorrowStart } from './canonical.mjs';

const HALVES_OF = {
  yes: ['on', 'on'], no: ['off', 'off'], maybe: ['possible', 'possible'],
  first: ['off', 'on'], second: ['on', 'off'], mfirst: ['possible', 'on'], msecond: ['on', 'possible']
};

const WALL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function wall(epochSeconds) {
  const parts = Object.fromEntries(WALL.formatToParts(new Date(epochSeconds * 1000)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * The instant Kyiv's wall clock reads `minutes` past midnight on the day that starts at `dayEpoch`.
 * The first one where a clock goes back (03:00–04:00 on the last Sunday of October happens twice, as the app
 * has it); where one goes forward and the time does not exist, the offset of the day's start.
 */
export function wallToEpoch(dayEpoch, minutes) {
  if (minutes >= 24 * 60) return kyivTomorrowStart(new Date(dayEpoch * 1000)) + (minutes - 24 * 60) * 60;
  const day = wall(dayEpoch).day;
  const base = dayEpoch + minutes * 60;
  for (const candidate of [base, base - 3600, base + 3600].sort((a, b) => a - b)) {
    const seen = wall(candidate);
    if (seen.day === day && seen.minutes === minutes) return candidate;
  }
  return base;
}

/** The blocks of a day's hours: `[{ state: 'off' | 'possible', from, to }]`, minutes from midnight. */
export function blocks(hours) {
  const slots = [];
  for (let hour = 1; hour <= 24; hour++) slots.push(...(HALVES_OF[hours?.[String(hour)] ?? 'yes'] ?? HALVES_OF.yes));
  const result = [];
  slots.forEach((state, index) => {
    if (state === 'on') return;
    const last = result[result.length - 1];
    if (last && last.state === state && last.to === index * 30) last.to = (index + 1) * 30;
    else result.push({ state, from: index * 30, to: (index + 1) * 30 });
  });
  return result;
}

const stamp = (epoch) => new Date(epoch * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** TEXT values: backslash, semicolon, comma and newline are escaped (RFC 5545 §3.3.11). */
const text = (value) => String(value).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Content lines are folded at 75 octets, never inside a UTF-8 character (RFC 5545 §3.1). */
export function fold(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const width = encoder.encode(char).length;
    const limit = out.length === 0 ? 75 : 74; // a continuation starts with a space
    if (size + width > limit) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += width;
  }
  out.push(current);
  return out.map((piece, i) => (i === 0 ? piece : ` ${piece}`)).join('\r\n');
}

/**
 * `snapshot`: the region's published file. `queueId`: «GPV3.1». Returns the calendar as text (CRLF lines).
 */
export function queueCalendar({ snapshot, regionId, regionTitle, queueId }) {
  const queueName = snapshot.preset?.sch_names?.[queueId] ?? queueId;
  const days = Array.isArray(snapshot.fact?.data) ? [] : Object.entries(snapshot.fact?.data ?? {});
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Коли Світло//koly-svitlo.web.app//UK',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(`Світло · ${regionTitle} · ${queueName}`)}`,
    `X-WR-CALDESC:${text('Години без світла за графіком, який опублікував оператор. Аварійні вимкнення сюди не входять.')}`,
    'X-WR-TIMEZONE:Europe/Kyiv',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M'
  ];
  for (const [dayKey, queues] of days.sort(([a], [b]) => Number(a) - Number(b))) {
    const dayEpoch = Number(dayKey);
    const hours = queues?.[queueId];
    if (!hours || !Number.isFinite(dayEpoch)) continue;
    for (const block of blocks(hours)) {
      const start = wallToEpoch(dayEpoch, block.from);
      const end = wallToEpoch(dayEpoch, block.to);
      if (!(end > start)) continue;
      const off = block.state === 'off';
      lines.push(
        'BEGIN:VEVENT',
        `UID:svitlo-${regionId}-${queueId}-${dayEpoch}-${block.from}@koly-svitlo.web.app`,
        `DTSTAMP:${stamp(dayEpoch)}`,
        `DTSTART:${stamp(start)}`,
        `DTEND:${stamp(end)}`,
        `SUMMARY:${text(off ? 'Світла немає' : 'Можливе вимкнення')}`,
        `DESCRIPTION:${text(`${queueName} · ${regionTitle}. ${off ? 'За графіком оператора.' : 'Оператор лише попереджає, що світла може не бути.'}`)}`,
        'TRANSP:TRANSPARENT',
        `STATUS:${off ? 'CONFIRMED' : 'TENTATIVE'}`
      );
      if (off) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', `DESCRIPTION:${text('Світло вимкнуть за 15 хвилин')}`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** The queues of a region that have anything to say: a weekly template for them, or a published day. */
export function calendarQueues(snapshot) {
  const names = new Set();
  for (const queueId of Object.keys(snapshot.preset?.data ?? {})) names.add(queueId);
  if (!Array.isArray(snapshot.fact?.data)) {
    for (const queues of Object.values(snapshot.fact?.data ?? {})) for (const queueId of Object.keys(queues ?? {})) names.add(queueId);
  }
  return [...names].filter((id) => /^[A-Za-z0-9._-]{1,40}$/.test(id)).sort();
}

/**
 * Writes `v1/ics/<region>/<queue>.ics` for every region file on disk, every cycle: a full deploy
 * starts from the working tree, and files absent from it would be gone from the site until their region
 * next changed. A region that fails costs only its own calendars — the schedule JSON is not touched.
 * Files of queues that no longer exist are removed. Returns the number of files written.
 */
export async function writeCalendars(outDir, regions, log = console) {
  let written = 0;
  for (const region of regions) {
    try {
      let snapshot;
      try {
        snapshot = JSON.parse(await readFile(join(outDir, `${region.id}.json`), 'utf8'));
      } catch {
        continue; // never published here
      }
      const dir = join(outDir, 'ics', region.id);
      const queues = calendarQueues(snapshot);
      if (!queues.length) continue;
      await mkdir(dir, { recursive: true });
      for (const queueId of queues) {
        const body = queueCalendar({ snapshot, regionId: region.id, regionTitle: region.title, queueId });
        let previous = null;
        try { previous = await readFile(join(dir, `${queueId}.ics`), 'utf8'); } catch { /* new */ }
        if (previous !== body) {
          await writeFile(join(dir, `${queueId}.ics`), body, 'utf8');
          written++;
        }
      }
      for (const name of await readdir(dir)) {
        if (name.endsWith('.ics') && !queues.includes(name.slice(0, -4))) await rm(join(dir, name));
      }
    } catch (error) {
      log.warn(`[ics] ${region.id}: ${error.message}`);
    }
  }
  return written;
}
