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
import { affectsSchedule } from './lib/notify.mjs';
import { unchanged } from './lib/change.mjs';
import { readRelay, staleSince } from './lib/relay.mjs';
import { ADAPTERS } from './adapters.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONS } from './regions.mjs';
import { validate, hasSchedule, statusFor, kyivDayStart } from './lib/canonical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'firebase', 'public', 'v1');


async function readExisting(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * One region may take this long; the whole fetch, this long. Adapters run one after another, so
 * without a bound a few operators answering slowly during a wide blackout — the moment the app is
 * for — added up past the Kyiv server's 12-minute limit, and the kill threw away every region's
 * update, Київ's included. A region that runs out of time fails the usual way: its last good copy
 * stays, marked stale. Regions not started once the budget is spent fail the same way.
 */
const REGION_DEADLINE_MS = 120_000;
const CYCLE_BUDGET_MS = 7 * 60_000;

class Deadline extends Error {}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Deadline(`${label}: no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const only = process.argv[2];
  const targets = REGIONS.filter(
    (region) => region.source && (!only || region.id === only)
  );

  const startedAt = Date.now();
  // Read up front: a failing region carries forward the time it first failed.
  const indexFile = join(OUT_DIR, 'index.json');
  const previousIndex = await readExisting(indexFile);
  const previousRows = new Map((previousIndex?.regions ?? []).map((row) => [row.id, row]));
  let overran = false;
  let changed = 0;
  let failed = 0;
  /** Regions whose published schedule moved — pushed after the deploy, never before. */
  const notify = [];
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
      if (Date.now() - startedAt > CYCLE_BUDGET_MS) throw new Deadline('cycle budget spent; not started');
      const { fetchRegion } = await (ADAPTERS[region.source]());
      // What phones have now, for an adapter that must not drop a day just because one of its
      // requests failed this time (Чернівці's tomorrow, Запоріжжя's site).
      const served = await readExisting(file);
      let snapshot;
      let relayed = null;
      try {
        snapshot = await withDeadline(fetchRegion({ ...region, previous: served }), REGION_DEADLINE_MS, region.id);
      } catch (error) {
        // The Kyiv server's own read failed; a recent copy GitHub read for it stands in
        // (lib/relay.mjs). Without one, the region fails as before and keeps its last copy.
        relayed = process.env.RELAY_DIR ? await readRelay(process.env.RELAY_DIR, region.id) : null;
        if (!relayed) throw error;
        if (error instanceof Deadline) overran = true;
        console.warn(`[relay] ${region.id}: ${error.message}; publishing GitHub's copy of ${relayed.relayedAt}`);
        snapshot = relayed.snapshot;
      }

      const problems = validate(snapshot);
      if (problems.length) throw new Error(problems.join('; '));

      const previous = await readExisting(file);
      const queues = Object.keys(snapshot.preset?.sch_names ?? {}).length;
      entry.queues = queues;
      entry.hasWeeklyPreset = Object.keys(snapshot.preset?.data ?? {}).length > 0;
      entry.hasSchedule = hasSchedule(snapshot);

      entry.status = statusFor(region, snapshot, entry.hasSchedule);
      if (relayed) {
        // Still failing here: kept on the list GitHub reads, so it keeps relaying.
        entry.stale = true;
        entry.staleSince = staleSince(previousRows.get(region.id));
      }

      if (unchanged(previous, snapshot)) {
        console.log(`[same]  ${region.id}`);
        index.push(entry);
        continue;
      }

      // Decided before the write, while `previous` still holds what phones currently have.
      const worthWaking = affectsSchedule(previous, snapshot);

      snapshot.mirroredAt = new Date().toISOString();
      await writeFile(file, JSON.stringify(snapshot), 'utf8');

      // Only recorded here. The push must not go out until the new file is actually being
      // served — a phone woken before the deploy refetches the old schedule and goes back to
      // sleep believing it is current.
      if (worthWaking) notify.push(region.id);
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
      if (error instanceof Deadline) overran = true;
      failed++;
      const previous = await readExisting(file);
      if (previous) {
        entry.queues = Object.keys(previous.preset?.sch_names ?? {}).length;
        entry.hasWeeklyPreset = Object.keys(previous.preset?.data ?? {}).length > 0;
        entry.stale = true;
        entry.staleSince = staleSince(previousRows.get(region.id));
        // Phones are still served that last good copy. While it covers today or a later day, the
        // region keeps the status the copy earned: otherwise a region that went live from published
        // days (Миколаїв in season) drops back to its declared 'seasonal' for one failed run, and the
        // app takes it out of the picker. A copy whose days have all passed earns nothing.
        const today = kyivDayStart();
        const days = Array.isArray(previous.fact?.data) ? [] : Object.keys(previous.fact?.data ?? {}).map(Number);
        if (days.some((day) => day >= today)) entry.status = statusFor(region, previous);
      } else {
        entry.status = 'planned';
      }
      index.push(entry);
    }
  }

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
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `changed=${changed > 0}\nnotify=${notify.join(',')}\n`,
      { flag: 'a' }
    );
  }
  // An adapter that lost the race is still waiting on its sockets and timers; they would hold the
  // process open long after the cycle's work is written.
  if (overran) process.exit(0);
}

main();
