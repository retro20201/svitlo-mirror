import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { parseRows, publishCrowd, ASK_EVERY_MS, KEEP_MS } from './lib/crowd-fetch.mjs';

const NOW = Date.parse('2026-11-05T14:00:00Z');

// The token exchange (lib/google-auth.mjs) uses the global fetch: it is answered here, never by Google.
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = async (url, init) => String(url).includes('oauth2.googleapis.com')
    ? new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }) : realFetch(url, init);
});
afterEach(() => { globalThis.fetch = realFetch; });
const dev = (n) => String(n).padStart(16, 'a');
const row = (n, state, agoMin, over = {}) => ({
  document: {
    name: `projects/koly-svitlo/databases/(default)/documents/reports/r${n}${state}${agoMin}`,
    fields: {
      d: { stringValue: dev(n) }, r: { stringValue: 'odesa' }, q: { stringValue: 'GPV2.1' }, s: { stringValue: state },
      t: { timestampValue: new Date(NOW - agoMin * 60_000).toISOString() }, ...over
    }
  }
});

/** A service-account key file that signs a real assertion, and a fetch that plays the token endpoint and Firestore. */
async function sandbox(rows, { sweepRows = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crowd-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials = join(dir, 'key.json');
  await writeFile(credentials, JSON.stringify({
    client_email: 'x@y.iam.gserviceaccount.com', project_id: 'koly-svitlo', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith(':runQuery')) {
      const old = body.structuredQuery.where.fieldFilter.op === 'LESS_THAN';
      return new Response(JSON.stringify(old ? sweepRows : rows), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return { dir, credentials, fetchImpl, calls, stateFile: join(dir, 'state.json') };
}

test('rows without a document or a time are dropped', () => {
  const rows = [row(1, 'on', 3), {}, { readTime: 'x' }, row(2, 'on', 3, { t: { stringValue: 'not a time' } })];
  assert.equal(parseRows(rows).length, 1);
  assert.equal(parseRows(null).length, 0);
});

test('three devices make crowd.json, with no device code in it', async () => {
  const box = await sandbox([row(1, 'on', 9), row(2, 'on', 5), row(3, 'on', 2)]);
  const result = await publishCrowd({
    outDir: box.dir, credentialsPath: box.credentials, known: new Set(['odesa']), nowMs: NOW, fetchImpl: box.fetchImpl, stateFile: box.stateFile
  });
  assert.equal(result.written, true);
  const text = await readFile(join(box.dir, 'crowd.json'), 'utf8');
  const file = JSON.parse(text);
  assert.equal(file.queues.odesa['GPV2.1'].state, 'on');
  assert.equal(file.queues.odesa['GPV2.1'].count, 3);
  assert.ok(!text.includes(dev(1)));
});

test('it asks once in five minutes, and writes nothing when nothing changed', async () => {
  const box = await sandbox([row(1, 'on', 9), row(2, 'on', 5), row(3, 'on', 2)]);
  const run = (nowMs) => publishCrowd({ outDir: box.dir, credentialsPath: box.credentials, nowMs, fetchImpl: box.fetchImpl, stateFile: box.stateFile });
  assert.equal((await run(NOW)).asked, true);
  assert.equal((await run(NOW + 60_000)).asked, false, 'a minute later: not asked');
  const again = await run(NOW + ASK_EVERY_MS + 1000);
  assert.equal(again.asked, true);
  assert.equal(again.written, false, 'the same answer is not written again');
});

test('a Firestore that fails leaves the file alone and is not asked again at once', async () => {
  const box = await sandbox([]);
  await writeFile(join(box.dir, 'crowd.json'), JSON.stringify({ generatedAt: 'x', queues: { odesa: { 'GPV2.1': { state: 'on', count: 3, at: 'y' } } } }));
  const failing = async (url) => String(url).includes('oauth2')
    ? new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }) : new Response('quota', { status: 429 });
  await assert.rejects(publishCrowd({ outDir: box.dir, credentialsPath: box.credentials, nowMs: NOW, fetchImpl: failing, stateFile: box.stateFile }));
  assert.ok((await readFile(join(box.dir, 'crowd.json'), 'utf8')).includes('GPV2.1'));
  const next = await publishCrowd({ outDir: box.dir, credentialsPath: box.credentials, nowMs: NOW + 1000, fetchImpl: failing, stateFile: box.stateFile });
  assert.equal(next.asked, false);
});

test('old reports are swept, a few hundred at a time, once in half an hour', async () => {
  const stale = [row(9, 'on', 400)];
  const box = await sandbox([], { sweepRows: stale });
  const result = await publishCrowd({ outDir: box.dir, credentialsPath: box.credentials, nowMs: NOW, fetchImpl: box.fetchImpl, stateFile: box.stateFile });
  assert.equal(result.swept, 1);
  const batch = box.calls.find((call) => call.url.endsWith(':batchWrite'));
  assert.deepEqual(batch.body.writes, [{ delete: stale[0].document.name }]);
  const sweepQuery = box.calls.filter((call) => call.url.endsWith(':runQuery')).at(-1);
  assert.equal(sweepQuery.body.structuredQuery.where.fieldFilter.value.timestampValue, new Date(NOW - KEEP_MS).toISOString());
  const second = await publishCrowd({ outDir: box.dir, credentialsPath: box.credentials, nowMs: NOW + ASK_EVERY_MS + 1000, fetchImpl: box.fetchImpl, stateFile: box.stateFile });
  assert.equal(second.swept, undefined, 'swept less than half an hour ago');
});
