#!/usr/bin/env node
/**
 * Sends schedule news — after the deploy, from the files being served. lib/news.mjs decides what.
 *
 *   node tools/mirror/send-news.mjs --fresh poltava,kyiv --ledger /var/lib/svitlo-mirror/news-ledger.json \
 *     --mode on|shadow --fingerprint <hex>
 *   node tools/mirror/send-news.mjs --test q_test_GPV1-1     (one canned alert; no ledger)
 *
 * It reads what is served instead of hooking into mirror.mjs, so a bug here can never fail a region
 * or the cycle publishing it; the mirror only lists the regions it read whole (`fresh=`). Running
 * after the deploy, it can only ever announce what a phone opening the alert will find.
 *
 * `shadow`, the default — any mode but exactly `on` — decides everything and records it as sent
 * without sending: switching to `on` then sends no backlog, and the rate limits are already in
 * step. In `on`, every send is marked in flight in the ledger before the POST, and a send whose
 * answer was never seen — a killed run, our own timeout, a connection reset mid-request — counts
 * as made: FCM has no idempotency key, a lost banner is better than one repeated every two minutes,
 * and the silent push still re-arms the phone's own reminders. Only a send known not to have
 * arrived — refused with a 429 or 5xx, or never connected — is tried again.
 *
 * Always exits 0. News is the least of what a cycle does, and run.sh must still reach its heartbeat.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { regionById } from './regions.mjs';
import { kyivTomorrowStart } from './lib/canonical.mjs';
import { accessToken } from './lib/google-auth.mjs';
import { sendFcm, FCM_SCOPE } from './lib/notify.mjs';
import { observeRegion } from './lib/news-observe.mjs';
import {
  decide, render, buildMessage, emptyLedger, parseKey,
  recordSent, recordAdopted, recordFailed, assumeInflightSent, MAX_ATTEMPTS
} from './lib/news.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVED = join(HERE, '..', '..', 'firebase', 'public', 'v1');

const CONCURRENCY = 4;
const REQUEST_MS = 10_000;
/**
 * No new send starts after this, counted from the token exchange (itself bounded in
 * lib/google-auth.mjs); run.sh's `timeout` is only the backstop behind it.
 */
const BUDGET_MS = 60_000;
const RETRY_FLOOR_MS = 2_000;
const RETRY_MIN_LEFT_MS = 15_000;

export function parseArgs(argv) {
  const args = { fresh: [], ledger: null, mode: 'shadow', fingerprint: '', test: null, served: SERVED };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1] ?? '';
    switch (argv[i]) {
      case '--fresh': args.fresh = value.split(',').map((id) => id.trim()).filter(Boolean); i++; break;
      case '--ledger': args.ledger = value; i++; break;
      // Exactly `on`: a typo, a stray space or an empty file keeps it quiet.
      case '--mode': args.mode = value === 'on' ? 'on' : 'shadow'; i++; break;
      case '--fingerprint': args.fingerprint = value; i++; break;
      case '--test': args.test = value; i++; break;
      case '--served': args.served = value; i++; break;
    }
  }
  return args;
}

export class TopicRefused extends Error {}

/**
 * Visible alerts go to the opt-in topics and nowhere else — above all never to `region-*`, which
 * every build since 1.0 holds and which must stay silent. Checked before every POST.
 */
export function assertNewsTopic(topic, { test = false } = {}) {
  const allowed = test ? /^q_test_/ : /^(q|s|e)_/;
  if (typeof topic !== 'string' || !allowed.test(topic)) throw new TopicRefused(`refusing a visible alert to "${topic}"`);
}

/** The only way a visible alert leaves this file. */
export async function sendNews(message, { credentialsPath, signal, test = false }) {
  assertNewsTopic(message?.message?.topic, { test });
  return sendFcm(message, { credentialsPath, signal });
}

// --- The ledger: one JSON file in the server's state folder, replaced whole, never edited in place.

const isLedger = (value) => value && typeof value === 'object' && value.v === 1 &&
  value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries) &&
  value.regions && typeof value.regions === 'object' && !Array.isArray(value.regions);

/**
 * Missing → empty, and every region rebaselines silently. Unreadable → set aside, not deleted, so
 * what went wrong can still be looked at, and empty again.
 */
export async function loadLedger(path, now = new Date()) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ledger: emptyLedger(), note: 'missing — starting empty' };
    throw error;
  }
  try {
    const ledger = JSON.parse(text);
    if (!isLedger(ledger)) throw new Error('not a ledger');
    return { ledger };
  } catch {
    const aside = join(dirname(path), `${basename(path, '.json')}.bad-${Math.floor(now.getTime() / 1000)}.json`);
    await rename(path, aside);
    return { ledger: emptyLedger(), note: `unreadable — moved to ${aside}, starting empty` };
  }
}

export async function saveLedger(path, ledger, now = new Date()) {
  ledger.savedAt = now.toISOString();
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger));
  await rename(temporary, path);
}

/** For a signal: nothing asynchronous runs once the handler returns. Its own temporary file, so a
 *  save already under way cannot be interleaved with it. */
export function saveLedgerSync(path, ledger, now = new Date()) {
  ledger.savedAt = now.toISOString();
  const temporary = `${path}.signal.tmp`;
  writeFileSync(temporary, JSON.stringify(ledger));
  renameSync(temporary, path);
}

// --- Logging: one line per decision, appended to news.log by run.sh.

function line(mode, key, kind, outcome, text = null) {
  const { region, queue, day } = parseKey(key);
  const said = text ? ` — ${text.level}: ${text.title} · ${text.subtitle} · ${text.body}` : '';
  return `[news] ${mode} ${region} ${queue} ${day} ${kind} ${outcome}${said}`;
}

const spoken = (message) => {
  const aps = message.message.apns.payload.aps;
  return { level: aps['interruption-level'], ...aps.alert };
};

/**
 * One cycle. Every dependency on the world outside is a parameter, so the tests drive it with a
 * stub `fetch` and a fake clock and signal source.
 */
export async function run({
  fresh = [], ledgerPath, mode = 'shadow', fingerprint = '', served = SERVED, now = new Date(),
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS, signals = process,
  exit = (code) => process.exit(code), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => Date.now(), print = console.log
}) {
  const started = clock();
  const counts = { sent: 0, held: 0, adopted: 0, failed: 0, shadow: 0 };
  const session = { ledger: null };
  // `timeout` in run.sh, or a stop of the unit: write down what is known — sends marked in flight
  // included, which the next run then counts as made — and leave quietly.
  const onSignal = () => {
    try {
      if (session.ledger) saveLedgerSync(ledgerPath, session.ledger, now);
      print('[news] stopped by a signal — ledger written');
    } catch (error) {
      print(`[news] stopped by a signal — ledger not written: ${error.message}`);
    }
    exit(0);
  };
  signals.on('SIGTERM', onSignal);
  signals.on('SIGINT', onSignal);

  try {
    const loaded = await loadLedger(ledgerPath, now);
    if (loaded.note) print(`[news] ledger ${loaded.note}`);
    session.ledger = loaded.ledger;
    for (const key of assumeInflightSent(loaded.ledger)) print(line(mode, key, '-', 'assumed-sent'));

    const observations = {};
    const ids = [];
    for (const id of fresh) {
      const region = regionById(id);
      if (!region) {
        print(`[news] ${id}: no such region`);
        continue;
      }
      try {
        observations[id] = observeRegion(region, JSON.parse(await readFile(join(served, `${id}.json`), 'utf8')), now);
        ids.push(id);
      } catch (error) {
        print(`[news] ${id}: not read (${error.message})`);
      }
    }

    const { ledger, due, log, breaker } = decide({ ledger: loaded.ledger, observations, now, fingerprint, freshIds: ids });
    session.ledger = ledger;
    for (const { key, kind, outcome } of log) {
      print(line(mode, key, kind, outcome));
      if (outcome.startsWith('held')) counts.held++;
      else counts.adopted++;
    }
    if (breaker) {
      await writeFile(join(dirname(ledgerPath), 'news-breaker.json'), JSON.stringify(breaker));
      print(`[news] BREAKER ${breaker.count} due in one cycle — none sent, all adopted; see news-breaker.json`);
    }

    const at = now.getTime();
    const ready = [];
    for (const event of due) {
      const text = render(event, now);
      if (!text) {
        recordAdopted(ledger, event);
        print(line(mode, event.key, event.kind, 'adopted(gave-up)'));
        counts.adopted++;
        continue;
      }
      ready.push({ event, message: buildMessage(event, text, now) });
    }

    if (mode !== 'on') {
      for (const { event, message } of ready) {
        recordSent(ledger, event, at);
        print(line(mode, event.key, event.kind, 'shadow', spoken(message)));
        counts.shadow++;
      }
    } else if (ready.length) {
      // The budget runs from here, the token exchange included. The exchange comes before anything
      // is marked in flight: until it answers nothing can have been posted, and a run killed while
      // it stalls must leave every send settled for the next cycle, not counted as made.
      const deadline = clock() + BUDGET_MS;
      const context = { ledger, print, mode, counts };
      if (await token(credentialsPath, ready, context)) {
        for (const { event } of ready) ledger.entries[event.key].inflight = { mask: event.mask, kind: event.kind, at };
        await saveLedger(ledgerPath, ledger, now);
        await deliver(ready, { ...context, at, deadline, credentialsPath, sleep, clock });
      }
    }
    await saveLedger(ledgerPath, ledger, now);
  } finally {
    signals.off('SIGTERM', onSignal);
    signals.off('SIGINT', onSignal);
  }
  print(`[news] summary sent=${counts.sent} held=${counts.held} adopted=${counts.adopted} ` +
    `failed=${counts.failed} shadow=${counts.shadow} ms=${clock() - started}`);
  return counts;
}

/** A known failure: the send stays settled, and the next cycle decides it again — until it gives up. */
function failed(event, why, { ledger, print, mode, counts }) {
  counts.failed++;
  if (recordFailed(ledger, event) >= MAX_ATTEMPTS) {
    recordAdopted(ledger, event);
    print(line(mode, event.key, event.kind, `failed(${why}) adopted(gave-up)`));
  } else {
    print(line(mode, event.key, event.kind, `failed(${why})`));
  }
}

/**
 * One exchange for the whole wave, before any send: when it fails, every send would fail the same
 * way, so none is tried and each stays settled for the next cycle.
 */
async function token(credentialsPath, ready, context) {
  try {
    if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
    await accessToken(credentialsPath, FCM_SCOPE);
    return true;
  } catch (error) {
    context.print(`[news] no token: ${error.message}`);
    for (const { event } of ready) failed(event, 'token', context);
    return false;
  }
}

/** Four at a time, ten seconds each, nothing new after the deadline; one retry where FCM asks for it. */
async function deliver(ready, { ledger, at, deadline, credentialsPath, sleep, clock, print, mode, counts }) {
  const context = { ledger, print, mode, counts };
  const sendOne = async ({ event, message }) => {
    const attempt = () => sendNews(message, { credentialsPath, signal: AbortSignal.timeout(REQUEST_MS) });
    let result;
    try {
      result = await attempt();
      // Only a send known not to have arrived; one whose outcome is unknown is never posted twice.
      if (!result.ok && result.retryable) {
        const wait = Math.max(result.retryAfterMs ?? 0, RETRY_FLOOR_MS);
        if (deadline - clock() - wait >= RETRY_MIN_LEFT_MS) {
          await sleep(wait);
          result = await attempt();
        }
      }
    } catch (error) {
      if (error instanceof TopicRefused) {
        recordAdopted(ledger, event);
        counts.failed++;
        print(line(mode, event.key, event.kind, `failed(guard) adopted — ${error.message}`));
        return;
      }
      // Thrown before the POST — by the token, already in hand — so nothing went out.
      result = { ok: false, status: 0, retryable: true, body: error.message };
    }
    if (result.ok) {
      recordSent(ledger, event, at);
      counts.sent++;
      print(line(mode, event.key, event.kind, 'sent', spoken(message)));
    } else if (result.unknown) {
      // It may have reached FCM with only the answer lost: counted as made, like a send a killed run
      // left in flight. Posted again, it would ring a second time.
      recordSent(ledger, event, at);
      counts.failed++;
      print(line(mode, event.key, event.kind, `assumed-sent(${result.body})`));
    } else if (result.retryable) {
      failed(event, result.status, context);
    } else {
      // FCM refused the message itself; sending it again would be refused again.
      recordAdopted(ledger, event);
      counts.failed++;
      print(line(mode, event.key, event.kind, `failed(${result.status}) adopted — ${String(result.body).slice(0, 300)}`));
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < ready.length && clock() < deadline) await sendOne(ready[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ready.length) }, worker));

  // Never posted, so never in flight: still settled, and the next cycle decides it again.
  for (const { event } of ready.slice(next)) {
    ledger.entries[event.key].inflight = null;
    counts.held++;
    print(line(mode, event.key, event.kind, 'held(budget)'));
  }
}

/** A canned «Зʼявився графік на завтра» to a `q_test_` topic: proves FCM → APNs → device. */
export async function sendTest(topic, {
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS, now = new Date(), print = console.log
} = {}) {
  if (!/^q_test_/.test(topic ?? '')) {
    print(`[news] test: "${topic}" is not a q_test_ topic — nothing sent`);
    return false;
  }
  const event = { type: 'queue', kind: 'published', region: 'test', queue: 'GPV1.1', day: kyivTomorrowStart(now), sends: 0, topic };
  const text = { title: 'Зʼявився графік на завтра', subtitle: 'Тест · Черга 1.1', body: 'Перевірка доставки — це тестове сповіщення.' };
  try {
    const result = await sendNews(buildMessage(event, text, now), {
      credentialsPath, signal: AbortSignal.timeout(REQUEST_MS), test: true
    });
    print(result.ok ? `[news] test sent to ${topic}` : `[news] test to ${topic} failed: HTTP ${result.status} ${result.body}`);
    return result.ok;
  } catch (error) {
    print(`[news] test to ${topic} failed: ${error.message}`);
    return false;
  }
}

async function main() {
  const quit = (error) => {
    console.log(`[news] crashed: ${error?.stack ?? error}`);
    process.exit(0);
  };
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.test !== null) {
      await sendTest(args.test);
    } else if (!args.ledger) {
      console.log('[news] usage: send-news.mjs --fresh <ids> --ledger <path> --mode <on|shadow> --fingerprint <hex> | --test <q_test_…>');
    } else {
      await run({ ...args, ledgerPath: args.ledger });
    }
  } catch (error) {
    console.log(`[news] failed: ${error?.stack ?? error}`);
  }
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
