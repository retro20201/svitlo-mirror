import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kyivDayStart } from './canonical.mjs';

/**
 * «Архів»: the table of every day that is over, put away per region — `v1/archive/<region>/<YYYY-MM-DD>.json`, and
 * `v1/archive/<region>/index.json` naming the days there are.
 *
 * The mirror holds today and tomorrow only, so a phone knows a past day only if it happened to be opened on it: a new
 * address starts «Статистика» from nothing, and a week away leaves a week's hole (a letter of 4 November 2026). A day's
 * file is the region's own file narrowed to that day, in the last form it was published in before midnight — the shape
 * the app already reads, so it counts the hours of a past day with the same code as today's.
 *
 * How a day gets there. Every cycle the day's table, as the region file in the tree has it, is noted in `<state>/open/`
 * — nothing is published while the day runs, the region file itself is the day's live copy. The first cycle after Kyiv
 * midnight finds the note a day old and puts it away as that day's file. A day with no table published makes no file:
 * «no file» is «nothing known», never «no outages».
 *
 * Where it lives. The checkout is cleaned every cycle and the site is rebuilt from it on a full deploy, so the files
 * are kept outside the tree, in `<state>/v1/`, for good. The tree gets the last few days and every index each cycle —
 * the fast deploy carries what is in the tree and leaves the rest of the live site as it is, and a day offered again
 * costs nothing (Firebase stores a file by its hash). Before a full deploy vps/run.sh copies the whole of `<state>/v1/`
 * into the tree.
 *
 * Two things the table alone does not say are kept beside it, under `archive`: `emergency` — the operator declared
 * emergency outages for that day at some point of it, so the table was not being kept — and `withdrawn` — the day had a
 * table and the operator took it down before the day ended.
 */

/** A year and a month: «цього місяця торік» can be answered. */
export const KEEP_DAYS = 400;
/** Days offered to the fast deploy again each cycle, so one that missed its deploy still gets out. */
export const OFFERED_DAYS = 3;

const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The Kyiv calendar date of a day's start, «2026-11-14». */
export const dateOf = (dayStart) => DATE.format(new Date(dayStart * 1000));
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/u;

const readJSON = async (file) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
};

/** The table a region file holds for `day`, or null: no such day, an empty one, or the empty list ДТЕК's shape has for «none». */
export function dayTable(snapshot, day) {
  const data = snapshot?.fact?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const table = data[String(day)];
  return table && typeof table === 'object' && !Array.isArray(table) && Object.keys(table).length ? table : null;
}

/** The region file with that one day in it and nothing about the days around it. */
export function narrowed(snapshot, day, table) {
  const { pendingChange: _pending, emergency: _days, emergencyNote, ...fact } = snapshot.fact ?? {};
  const declared = emergencyOn(snapshot, day);
  return {
    ...snapshot,
    fact: { ...fact, ...(declared ? { emergency: [day], ...(emergencyNote ? { emergencyNote } : {}) } : {}), data: { [String(day)]: table }, today: day }
  };
}

/** The operator has declared emergency outages for `day` (`fact.emergency` lists the days it has). */
function emergencyOn(snapshot, day) {
  const days = snapshot?.fact?.emergency;
  return Array.isArray(days) && days.map(Number).includes(day);
}

/**
 * One region's note for the running day, brought up to this cycle.
 *
 * @param {object|null} open the note as it stands: `{ day, snapshot, emergency, withdrawn }`
 * @param {object|null} snapshot the region file of this cycle
 * @returns {object|null} the note to keep, or null when there is nothing to note
 */
export function noted(open, snapshot, today) {
  const table = dayTable(snapshot, today);
  const held = open && open.day === today ? open : null;
  const emergency = Boolean(held?.emergency) || emergencyOn(snapshot, today);
  if (table) return { day: today, snapshot: narrowed(snapshot, today, table), emergency, withdrawn: false };
  // The day had a table and now has none: the last one stands, marked as taken down. A region file that could not be read
  // at all says nothing about the table.
  if (held && snapshot) return { ...held, emergency, withdrawn: true };
  return held;
}

/** A finished day as its file: the narrowed region file and what the table alone does not say. */
export const dayFile = (open) => ({ ...open.snapshot, archive: { date: dateOf(open.day), emergency: Boolean(open.emergency), withdrawn: Boolean(open.withdrawn) } });

async function daysOf(dir) {
  try { return (await readdir(dir)).filter((name) => DAY_FILE.test(name)).map((name) => name.slice(0, 10)).sort(); } catch { return []; }
}

/**
 * Notes the running day of every region, puts away the days that are over, and lays the last few days and the indexes
 * into the tree.
 *
 * @param {{ outDir: string, stateDir: string, regions: string[], now?: Date }} options `outDir`: the tree's `v1`
 * @returns {Promise<{ closed: number, offered: number }>} `closed`: days put away this cycle
 */
export async function publishArchive({ outDir, stateDir, regions, now = new Date() }) {
  const today = kyivDayStart(now);
  const oldest = dateOf(today - KEEP_DAYS * 86400);
  const offeredFrom = dateOf(today - OFFERED_DAYS * 86400);
  await mkdir(join(stateDir, 'open'), { recursive: true });
  let closed = 0;
  let offered = 0;
  for (const id of regions) {
    const openFile = join(stateDir, 'open', `${id}.json`);
    const kept = join(stateDir, 'v1', id);
    let open = await readJSON(openFile);
    if (open && Number.isFinite(open.day) && open.day < today && open.snapshot) {
      await mkdir(kept, { recursive: true });
      await writeFile(join(kept, `${dateOf(open.day)}.json`), JSON.stringify(dayFile(open)), 'utf8');
      closed++;
    }
    const next = noted(open, await readJSON(join(outDir, `${id}.json`)), today);
    if (!next) {
      if (open) await rm(openFile, { force: true });
    } else if (JSON.stringify(next) !== JSON.stringify(open)) {
      await writeFile(openFile, JSON.stringify(next), 'utf8');
    }

    let days = await daysOf(kept);
    for (const date of days.filter((date) => date < oldest)) await rm(join(kept, `${date}.json`), { force: true });
    days = days.filter((date) => date >= oldest);
    if (!days.length) continue;
    const index = JSON.stringify({ days });
    if ((await readFile(join(kept, 'index.json'), 'utf8').catch(() => null)) !== index) await writeFile(join(kept, 'index.json'), index, 'utf8');
    const tree = join(outDir, 'archive', id);
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'index.json'), index, 'utf8');
    for (const date of days.filter((date) => date >= offeredFrom)) {
      await copyFile(join(kept, `${date}.json`), join(tree, `${date}.json`));
      offered++;
    }
  }
  return { closed, offered };
}
