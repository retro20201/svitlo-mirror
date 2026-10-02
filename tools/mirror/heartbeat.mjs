#!/usr/bin/env node
/**
 * `beat`  — the Kyiv runner, after a finished cycle: "I am publishing."
 * `check` — GitHub Actions, before its own cycle: is the Kyiv runner publishing? Writes
 *           `fresh=true|false` to GITHUB_OUTPUT. Never fails the job: when the answer cannot be
 *           read, GitHub publishes itself, because a mirror nobody runs is the worse outcome.
 *
 * See lib/heartbeat.mjs for why there is only one writer at a time.
 */

import { appendFile } from 'node:fs/promises';
import { beatAge, isFresh, readLabels, writeBeat, MAX_AGE_SECONDS } from './lib/heartbeat.mjs';

const SITE = 'koly-svitlo';
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

const command = process.argv[2];
if (command === 'beat') {
  try {
    await writeBeat({ credentialsPath, site: SITE });
    console.log('[beat] stamped');
  } catch (error) {
    console.error(`[beat] ${error.message}`);
    process.exitCode = 1;
  }
} else if (command === 'check') {
  let fresh = false;
  try {
    const { labels, nowSeconds } = await readLabels({ credentialsPath, site: SITE });
    const age = beatAge(labels, nowSeconds);
    fresh = isFresh(labels, nowSeconds);
    console.log(age === null
      ? '[kyiv] no beat on record — publishing from here'
      : `[kyiv] last cycle ${Math.round(age / 60)} min ago (limit ${MAX_AGE_SECONDS / 60}) — ` +
        (fresh ? 'standing down' : 'publishing from here'));
  } catch (error) {
    console.error(`[kyiv] could not read the beat (${error.message}) — publishing from here`);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `fresh=${fresh}\n`);
} else {
  console.error('usage: heartbeat.mjs beat|check');
  process.exitCode = 2;
}
