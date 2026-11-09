#!/usr/bin/env node
/**
 * Sends «Новий пост оператора» — after the deploy, from the feeds being served. lib/posts-push.mjs decides what.
 *
 *   node tools/mirror/send-posts.mjs --ledger /var/lib/svitlo-mirror/posts-ledger.json --mode on|shadow
 *
 * It reads `v1/news-<region>.json` as a phone would read it, instead of hooking into mirror.mjs, so a bug here can never fail a
 * region or the cycle that publishes it, and it can only announce what a phone opening the banner will find on its news screen.
 *
 * `shadow`, the default — any mode but exactly `on` — decides everything and records it as sent without sending: switching to
 * `on` then sends no backlog, and the three-hour gap is already in step. In `on` a send whose answer was never seen (a killed
 * run, our own timeout) counts as made: FCM has no idempotency key, and a lost banner is better than one repeated every two
 * minutes. Only a send known not to have arrived — refused with a 429 or 5xx, or never connected — is tried again next cycle.
 *
 * Always exits 0: this is the least of what a cycle does, and run.sh must still reach its heartbeat.
 */

import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendFcm, FCM_SCOPE } from './lib/notify.mjs';
import { accessToken } from './lib/google-auth.mjs';
import { decide, buildMessage, emptyPostsLedger, isPostsLedger, isPostsTopic } from './lib/posts-push.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVED = join(HERE, '..', '..', 'firebase', 'public', 'v1');

const REQUEST_MS = 10_000;
/** No new send starts after this, counted from the start of the run; run.sh's `timeout` is only the backstop behind it. */
const BUDGET_MS = 45_000;
/** The country's headlines are `news-ua.json`: not an operator's post, and not something to wake anyone for. */
const NOT_AN_OPERATOR = new Set(['ua']);

export class TopicRefused extends Error {}

export function parseArgs(argv) {
  const args = { ledger: null, mode: 'shadow', served: SERVED };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1] ?? '';
    switch (argv[i]) {
      case '--ledger': args.ledger = value; i++; break;
      // Exactly `on`: a typo, a stray space or an empty file keeps it quiet.
      case '--mode': args.mode = value === 'on' ? 'on' : 'shadow'; i++; break;
      case '--served': args.served = value; i++; break;
    }
  }
  return args;
}

/** The only way a visible alert leaves this file: to an `n_` topic, checked before every POST. */
export async function sendPost(message, { credentialsPath, signal } = {}) {
  const topic = message?.message?.topic;
  if (!isPostsTopic(topic)) throw new TopicRefused(`refusing a visible alert to "${topic}"`);
  return sendFcm(message, { credentialsPath, signal });
}

export async function loadLedger(path, now = new Date()) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ledger: emptyPostsLedger(), note: 'missing — starting empty' };
    throw error;
  }
  try {
    const ledger = JSON.parse(text);
    if (!isPostsLedger(ledger)) throw new Error('not a ledger');
    return { ledger };
  } catch {
    const aside = join(dirname(path), `${basename(path, '.json')}.bad-${Math.floor(now.getTime() / 1000)}.json`);
    await rename(path, aside);
    return { ledger: emptyPostsLedger(), note: `unreadable — moved to ${aside}, starting empty` };
  }
}

export async function saveLedger(path, ledger, now = new Date()) {
  ledger.savedAt = now.toISOString();
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger));
  await rename(temporary, path);
}

/** The posts of a served feed, or null when the file is missing or is not a feed: the region is left alone then. */
async function readFeed(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.items)) return null;
  return parsed.items.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string'
    && Number.isFinite(Date.parse(item.at)));
}

export async function run({
  served = SERVED, ledgerPath, mode = 'shadow', now = new Date(), print = console.log,
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS, send = sendPost, clock = () => Date.now()
} = {}) {
  const started = clock();
  const { ledger, note } = await loadLedger(ledgerPath, now);
  if (note) print(`[posts] ledger ${note}`);

  const names = (await readdir(served)).filter((name) => /^news-.+\.json$/.test(name)).sort();
  const counts = { adopted: 0, none: 0, skipped: 0, sent: 0, failed: 0 };

  for (const name of names) {
    const region = name.slice('news-'.length, -'.json'.length);
    if (NOT_AN_OPERATOR.has(region)) continue;
    const items = await readFeed(join(served, name));
    if (!items) continue;

    const decision = decide({ region, items, ledger, now });
    if (decision.action === 'adopt') {
      ledger.regions[region] = decision.entry;
      counts.adopted++;
      print(`[posts] ${mode} ${region} adopted ${items.length} post(s) silently`);
    } else if (decision.action === 'none') {
      ledger.regions[region] = decision.entry;
      counts.none++;
    } else if (decision.action === 'skip') {
      ledger.regions[region] = decision.entry;
      counts.skipped++;
      print(`[posts] ${mode} ${region} skipped (${decision.reason}): ${decision.post.title}`);
    } else if (mode !== 'on') {
      ledger.regions[region] = decision.entry;
      counts.sent++;
      print(`[posts] shadow ${region} would send${decision.night ? ' (night, no sound)' : ''}: ${decision.post.title}`);
    } else if (clock() - started > BUDGET_MS) {
      // Not recorded: the post is still new at the next cycle.
      print(`[posts] on ${region} out of time, left for the next cycle`);
    } else {
      const message = buildMessage({ region, post: decision.post, night: decision.night }, now);
      const result = await send(message, { credentialsPath, signal: AbortSignal.timeout(REQUEST_MS) });
      if (result.ok || result.unknown || !result.retryable) {
        // Made, or its answer never seen, or refused for good: not tried again, the banner is not worth a storm.
        ledger.regions[region] = decision.entry;
      }
      if (result.ok) {
        counts.sent++;
        print(`[posts] on ${region} sent${decision.night ? ' (night, no sound)' : ''}: ${decision.post.title}`);
      } else {
        counts.failed++;
        print(`[posts] on ${region} not sent (${result.status}${result.retryable ? ', will retry' : ''}): ${String(result.body).slice(0, 160)}`);
      }
    }
  }
  await saveLedger(ledgerPath, ledger, now);
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ledger) {
    console.log('[posts] usage: send-posts.mjs --ledger <path> --mode <on|shadow> [--served <dir>]');
    return;
  }
  try {
    // A token that cannot be had says so once, instead of once per region.
    if (args.mode === 'on') await accessToken(process.env.GOOGLE_APPLICATION_CREDENTIALS, FCM_SCOPE);
    await run({ served: args.served, ledgerPath: args.ledger, mode: args.mode });
  } catch (error) {
    console.log(`[posts] failed: ${error.message}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
