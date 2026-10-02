/**
 * Regions the Kyiv server cannot read, fetched by GitHub instead — without a second writer.
 *
 * The Kyiv server publishes alone (lib/heartbeat.mjs). But "the server is alive" is not "the
 * server can read every source": an operator, or Telegram, may one day refuse that one address
 * while answering GitHub's. Then the region would sit on its last copy for as long as the block
 * lasted, and GitHub — standing down — would never notice.
 *
 * So the served index says since when each region has failed (`staleSince`). GitHub, on its own
 * runs, reads those regions itself; what it can read it pushes to the `relay` branch of the
 * repository — not to Hosting. The Kyiv server fetches that branch every cycle, and for a region
 * whose own adapter failed it publishes GitHub's copy if it is recent. One writer throughout.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validate } from './canonical.mjs';

/** A one-cycle blip is not a block: GitHub steps in only after this long. */
export const STALE_BEFORE_RELAY_MS = 20 * 60_000;

/**
 * GitHub's cron runs a handful of times a day, so a relayed copy is kept this long. Older than
 * that it describes a schedule the operator may well have revised since.
 */
export const RELAY_MAX_AGE_MS = 3 * 3600_000;

/** When a failing region first failed: carried from the served index while it keeps failing. */
export function staleSince(previousRow, now = new Date()) {
  return previousRow?.stale && previousRow.staleSince ? previousRow.staleSince : now.toISOString();
}

/**
 * The regions GitHub should try: failing on the Kyiv server for longer than a blip — and failing
 * to read, not merely skipped because the cycle ran out of time.
 */
export function regionsToRelay(indexRows, now = Date.now()) {
  return (indexRows ?? [])
    .filter((row) => row.stale && !row.notStarted && Date.parse(row.staleSince ?? '') <= now - STALE_BEFORE_RELAY_MS)
    .map((row) => row.id);
}

/**
 * GitHub's copy of a region, or null when there is none, it does not hold up, or it is not of
 * this failure. The branch keeps its last copy after a block ends; read on the next one-cycle
 * blip, that copy would replace a schedule revised since and wake phones onto the older one. So a
 * copy counts only while the region was already failing when GitHub read it (`previousRow`), and
 * only if nothing newer has been published since (`served`).
 */
export async function readRelay(dir, regionId, { now = Date.now(), previousRow, served } = {}) {
  let relayed;
  try {
    relayed = JSON.parse(await readFile(join(dir, `${regionId}.json`), 'utf8'));
  } catch {
    return null;
  }
  const at = Date.parse(relayed?.relayedAt ?? '');
  if (!Number.isFinite(at) || now - at > RELAY_MAX_AGE_MS || at > now + 5 * 60_000) return null;
  if (relayed.regionId !== regionId || validate(relayed).length) return null;
  if (!previousRow?.stale || !(Date.parse(previousRow.staleSince ?? '') <= at)) return null;
  const servedAt = Date.parse(served?.mirroredAt ?? '');
  if (Number.isFinite(servedAt) && servedAt > at) return null;
  const { relayedAt, ...snapshot } = relayed;
  return { snapshot, relayedAt };
}
