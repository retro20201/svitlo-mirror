#!/usr/bin/env node
/**
 * Publishes every region's schedule into `firebase/public/v1/`, which is what the app fetches.
 *
 * Why a mirror at all, when the operators' pages are public:
 *  - **Cache headers.** jsDelivr serves upstream with `max-age=604800`; a phone would happily hold
 *    a week-old outage schedule. Firebase Hosting lets us pin 300 s.
 *  - **One format.** Every operator publishes something different — ДТЕК's `DisconSchedule`,
 *    Миколаїв's half-hour REST API, others' HTML tables. Adapters normalise all of it into the one
 *    shape the app decodes, so Swift never grows a per-region branch.
 *  - **A validation gate.** Publishing a structurally broken file is worse than publishing a stale
 *    one, so anything failing `validate()` leaves the previous copy untouched.
 *
 * `index.json` carries the region list and each region's coverage status, so switching a region on
 * (or off, when its source breaks) needs no App Store release.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONS } from './regions.mjs';
import { validate, hasSchedule } from './lib/canonical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'firebase', 'public', 'v1');

const ADAPTERS = {
  dtek: () => import('./sources/dtek.mjs'),
  mykolaiv: () => import('./sources/mykolaiv.mjs')
};

async function readExisting(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Compare on content only — the mirror's own timestamps must not trigger a deploy every run. */
function fingerprint(snapshot) {
  if (!snapshot) return null;
  const { lastUpdated, lastUpdateStatus, mirroredAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const only = process.argv[2];
  const targets = REGIONS.filter(
    (region) => region.source && (!only || region.id === only)
  );

  let changed = 0;
  let failed = 0;
  const index = [];

  for (const region of REGIONS) {
    const entry = {
      id: region.id,
      title: region.title,
      subtitle: region.subtitle,
      operator: region.operator,
      status: region.status
    };
    if (region.note) entry.note = region.note;

    if (!targets.includes(region)) {
      index.push(entry);
      continue;
    }

    const file = join(OUT_DIR, `${region.id}.json`);
    try {
      const { fetchRegion } = await (ADAPTERS[region.source]());
      const snapshot = await fetchRegion(region);

      const problems = validate(snapshot);
      if (problems.length) throw new Error(problems.join('; '));

      const previous = await readExisting(file);
      const queues = Object.keys(snapshot.preset?.sch_names ?? {}).length;
      entry.queues = queues;
      entry.hasWeeklyPreset = Object.keys(snapshot.preset?.data ?? {}).length > 0;
      entry.hasSchedule = hasSchedule(snapshot);

      if (previous && fingerprint(previous) === fingerprint(snapshot)) {
        console.log(`[same]  ${region.id}`);
        index.push(entry);
        continue;
      }

      snapshot.mirroredAt = new Date().toISOString();
      await writeFile(file, JSON.stringify(snapshot), 'utf8');
      const days = Array.isArray(snapshot.fact?.data) ? 0 : Object.keys(snapshot.fact.data).length;
      console.log(
        `[write] ${region.id}: ${queues} queues, ` +
        `${entry.hasWeeklyPreset ? 'weekly preset' : 'no preset'}, ${days} published day(s)`
      );
      changed++;
      index.push(entry);
    } catch (error) {
      // A failing adapter keeps the last good copy on disk and reports the region as degraded,
      // rather than removing a schedule people may be relying on right now.
      console.error(`[fail]  ${region.id}: ${error.message}`);
      failed++;
      const previous = await readExisting(file);
      if (previous) {
        entry.queues = Object.keys(previous.preset?.sch_names ?? {}).length;
        entry.hasWeeklyPreset = Object.keys(previous.preset?.data ?? {}).length > 0;
        entry.stale = true;
      } else {
        entry.status = 'planned';
      }
      index.push(entry);
    }
  }

  const indexFile = join(OUT_DIR, 'index.json');
  const previousIndex = await readExisting(indexFile);

  // A single-region run only learns about that region. Rebuilding the whole index from it would
  // strip `queues`/`hasWeeklyPreset` from every other row, so carry the previous values forward.
  let merged = index;
  if (only && previousIndex?.regions) {
    const before = new Map(previousIndex.regions.map((row) => [row.id, row]));
    merged = index.map((row) => (row.id === only ? row : before.get(row.id) ?? row));
  }

  const payload = { generatedAt: new Date().toISOString(), regions: merged };
  const sameIndex = previousIndex &&
    JSON.stringify(previousIndex.regions) === JSON.stringify(merged);
  if (!sameIndex) {
    await writeFile(indexFile, JSON.stringify(payload), 'utf8');
    changed++;
  }

  const live = index.filter((r) => r.status === 'live').length;
  console.log(`\nregions: ${live} live of ${index.length} · changed=${changed} failed=${failed}`);

  if (failed === targets.length && targets.length > 0) process.exit(1);
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `changed=${changed > 0}\n`, { flag: 'a' });
  }
}

main();
