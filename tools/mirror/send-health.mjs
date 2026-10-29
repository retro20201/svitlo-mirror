#!/usr/bin/env node
/**
 * After a cycle: tells the developer's phone about a region that has stopped being read (lib/health-alert.mjs).
 * Never fails the cycle — a message that does not go out costs a letter's worth of time, nothing more.
 *
 * Usage: node tools/mirror/send-health.mjs <state.json> <index.json> [--test]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { decide } from './lib/health-alert.mjs';
import { notifyDeveloper } from './lib/notify.mjs';

const args = process.argv.slice(2);
const test = args.includes('--test');
const [stateFile, indexFile] = args.filter((arg) => !arg.startsWith('--'));
const options = { credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS, dryRun: process.env.PUSH_DRY_RUN === '1' };

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

try {
  if (test) {
    await notifyDeveloper({ title: '🧪 Перевірка зв’язку', body: 'Оповіщення про збої читання підключено.' }, options);
    process.exit(0);
  }
  const index = await readJson(indexFile, null);
  if (!index?.regions) {
    console.log('[health] no index to read');
    process.exit(0);
  }
  const { messages, state } = decide(index.regions, await readJson(stateFile, {}));
  // The state is written first: a message that failed to go is not sent again every two minutes.
  await writeFile(stateFile, JSON.stringify(state), 'utf8');
  for (const message of messages) {
    try {
      await notifyDeveloper(message, options);
    } catch (error) {
      console.error(`[health] not sent: ${error.message}`);
    }
  }
} catch (error) {
  console.error(`[health] ${error.message}`);
}
process.exit(0);
