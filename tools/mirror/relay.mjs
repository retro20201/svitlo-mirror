#!/usr/bin/env node
/**
 * GitHub's half of lib/relay.mjs: while standing down, read the regions the Kyiv server has been
 * failing for longer than a blip, and write what reads to `<out>/<region>.json` for the `relay`
 * branch. Never deploys. Writes `relayed=` (read here, failing there — the server is being
 * refused) and `unreachable=` (failing here too — the source is down for everyone) to
 * GITHUB_OUTPUT.
 *
 * Usage: node tools/mirror/relay.mjs <out-dir>
 */

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REGIONS } from './regions.mjs';
import { ADAPTERS } from './adapters.mjs';
import { validate } from './lib/canonical.mjs';
import { regionsToRelay } from './lib/relay.mjs';

const SERVED = 'https://koly-svitlo.web.app/v1';
const DEADLINE_MS = 120_000;
const out = process.argv[2] ?? 'relay-out';

async function served(name) {
  const response = await fetch(`${SERVED}/${name}.json`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${name}.json: HTTP ${response.status}`);
  return response.json();
}

let index;
try {
  index = await served('index');
} catch (error) {
  // Not the Kyiv server's problem, and not one to mail anyone about: try again next run.
  console.log(`[relay] the served index did not load (${error.message}); nothing relayed this run`);
  process.exit(0);
}
const wanted = regionsToRelay(index.regions);
const relayed = [];
const unreachable = [];
await mkdir(out, { recursive: true });

for (const id of wanted) {
  const region = REGIONS.find((candidate) => candidate.id === id && candidate.source);
  if (!region) continue;
  try {
    const previous = await served(id).catch(() => null);
    const { fetchRegion } = await ADAPTERS[region.source]();
    let timer;
    const snapshot = await Promise.race([
      fetchRegion({ ...region, previous }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in 120 s')), DEADLINE_MS); })
    ]).finally(() => clearTimeout(timer));
    const problems = validate(snapshot);
    if (problems.length) throw new Error(problems.join('; '));
    await writeFile(join(out, `${id}.json`), JSON.stringify({ ...snapshot, relayedAt: new Date().toISOString() }));
    relayed.push(id);
    console.log(`[relay] ${id}: read here — the Kyiv server is being refused`);
  } catch (error) {
    unreachable.push(id);
    console.log(`[relay] ${id}: fails here too (${error.message}) — down for everyone`);
  }
}
if (!wanted.length) console.log('[relay] the Kyiv server reads every region');

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `relayed=${relayed.join(',')}\nunreachable=${unreachable.join(',')}\n`);
}
// An adapter that lost the race may still hold sockets open.
process.exit(0);
