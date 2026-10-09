import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, parseArgs, sendNews, sendTest, assertNewsTopic, TopicRefused } from './send-news.mjs';
import { buildSnapshot } from './lib/canonical.mjs';

// The sender, offline: `fetch` is a stand-in for Google, the key is made here, and signals come from
// a plain emitter. Nothing in this file reaches the network.

const SCRIPT = fileURLToPath(new URL('./send-news.mjs', import.meta.url));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

const at = (local) => Date.parse(`${local.replace(' ', 'T')}:00+03:00`);
const MIN = 60_000;
const TOMORROW = 1791493200;   // пт, 9 жовтня 2026

const DARK_7_TO_10 = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), i >= 7 && i < 10 ? 'no' : 'yes']));
const LIGHT = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), 'yes']));

const folders = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A folder standing in for the server: served files, a ledger path and a key file of its own. */
function server() {
  const root = mkdtempSync(join(tmpdir(), 'send-news-'));
  folders.push(root);
  const served = join(root, 'v1');
  mkdirSync(served);
  const credentialsPath = join(root, 'service-account.json');
  writeFileSync(credentialsPath, JSON.stringify({
    client_email: 'mirror@koly-svitlo.iam.gserviceaccount.com', private_key: KEY, project_id: 'koly-svitlo'
  }));
  return {
    root, served, credentialsPath, ledgerPath: join(root, 'news-ledger.json'),
    serve(region, queues, fact = {}) {
      writeFileSync(join(served, `${region}.json`), JSON.stringify(buildSnapshot({ regionId: region, title: 'x', queues, fact, source: 'test' })));
    },
    ledger() {
      return JSON.parse(readFileSync(join(root, 'news-ledger.json'), 'utf8'));
    }
  };
}

/** Google, played by a function: `fcm(message)` answers each send. Every request is recorded. */
function google(fcm) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3599 }), { status: 200 });
    }
    if (url === 'https://fcm.googleapis.com/v1/projects/koly-svitlo/messages:send') return fcm(JSON.parse(init.body));
    throw new Error(`no network in tests: ${url}`);
  };
  return {
    calls,
    tokens: () => calls.filter((url) => url.includes('oauth2')).length,
    sends: () => calls.filter((url) => url.includes('fcm.googleapis.com')).length,
    restore: () => { globalThis.fetch = real; }
  };
}

const ok = () => new Response('{"name":"projects/koly-svitlo/messages/1"}', { status: 200 });

/** Three cycles of Полтава: nothing out (bootstrap), tomorrow out, tomorrow out again — due. */
async function evening(box, options, queues = { 'GPV3.1': 'Черга 3.1' }, day = { 'GPV3.1': DARK_7_TO_10 }) {
  const t = at('2026-10-08 20:45');
  const lines = [];
  const base = { fresh: ['poltava'], ledgerPath: box.ledgerPath, served: box.served, fingerprint: 'fp', credentialsPath: box.credentialsPath,
    signals: new EventEmitter(), sleep: async () => {}, print: (line) => lines.push(line), ...options };
  box.serve('poltava', queues);
  await run({ ...base, now: new Date(t) });
  box.serve('poltava', queues, { [TOMORROW]: day });
  await run({ ...base, now: new Date(t + 2 * MIN) });
  const counts = await run({ ...base, now: new Date(t + 4 * MIN) });
  return { counts, lines, base, next: t + 6 * MIN };
}

test('shadow decides and records everything, and sends nothing', async () => {
  const box = server();
  const fake = google(() => ok());
  try {
    const { counts, lines } = await evening(box, { mode: 'shadow' });
    assert.equal(fake.calls.length, 0);
    assert.equal(counts.shadow, 1);
    const entry = box.ledger().entries[`poltava|GPV3.1|${TOMORROW}`];
    assert.equal(entry.told, true);
    assert.equal(entry.sends, 1);
    assert.equal(entry.pending, null);
    assert.ok(lines.some((line) => line.startsWith(`[news] shadow poltava GPV3.1 ${TOMORROW} published shadow — active: Зʼявився графік на завтра`)));
  } finally {
    fake.restore();
  }
});

test('anything but exactly "on" is shadow', () => {
  assert.equal(parseArgs(['--mode', 'on']).mode, 'on');
  for (const mode of ['ON', ' on', 'on\n', 'off', '', 'shadow']) assert.equal(parseArgs(['--mode', mode]).mode, 'shadow');
  assert.equal(parseArgs([]).mode, 'shadow');
  assert.deepEqual(parseArgs(['--fresh', '']).fresh, []);
  assert.deepEqual(parseArgs(['--fresh', 'poltava,kyiv']).fresh, ['poltava', 'kyiv']);
});

test('on: in flight on disk before the first POST, one token for the wave, one POST per alert', async () => {
  const box = server();
  const posted = [];
  const fake = google((message) => {
    // What a SIGKILL here would leave: every send of the wave already marked in flight.
    if (!posted.length) {
      const marked = Object.entries(box.ledger().entries).filter(([key]) => key.endsWith(`|${TOMORROW}`));
      assert.equal(marked.length, 2);
      assert.ok(marked.every(([, entry]) => entry.inflight?.kind === 'published'));
    }
    posted.push(message);
    return ok();
  });
  try {
    const { counts } = await evening(box, { mode: 'on' }, { 'GPV3.1': 'Черга 3.1', 'GPV1.1': 'Черга 1.1' }, { 'GPV3.1': DARK_7_TO_10, 'GPV1.1': LIGHT });
    assert.equal(counts.sent, 2);
    assert.equal(fake.tokens(), 1);
    assert.equal(fake.sends(), 2);
    assert.deepEqual(posted.map((message) => message.message.topic).sort(), ['q_poltava_GPV1-1', 'q_poltava_GPV3-1']);
    const entry = box.ledger().entries[`poltava|GPV3.1|${TOMORROW}`];
    assert.equal(entry.inflight, null);
    assert.equal(entry.sends, 1);
  } finally {
    fake.restore();
  }
});

test('a 429 is retried once after Retry-After, then left settled, and sent the next cycle', async () => {
  const box = server();
  const waits = [];
  let refuse = true;
  const fake = google(() => (refuse
    ? new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429, headers: { 'retry-after': '1' } })
    : ok()));
  try {
    const { counts, base, next, lines } = await evening(box, { mode: 'on', sleep: async (ms) => { waits.push(ms); } });
    assert.equal(counts.failed, 1);
    assert.equal(fake.sends(), 2);
    assert.deepEqual(waits, [2000]);
    assert.ok(lines.some((line) => line.endsWith('published failed(429)')));
    const entry = box.ledger().entries[`poltava|GPV3.1|${TOMORROW}`];
    assert.equal(entry.inflight, null);
    assert.equal(entry.attempts, 1);
    assert.equal(entry.base, null);
    assert.ok(entry.pending);

    refuse = false;
    const again = await run({ ...base, now: new Date(next) });
    assert.equal(again.sent, 1);
    assert.equal(fake.sends(), 3);
    assert.equal(box.ledger().entries[`poltava|GPV3.1|${TOMORROW}`].told, true);
  } finally {
    fake.restore();
  }
});

test('killed mid-send: the signal writes the ledger, and the next run counts the send as made', async () => {
  const box = server();
  const signals = new EventEmitter();
  const exits = [];
  let onDisk = null;
  const fake = google(() => {
    // `timeout` sends SIGTERM while the POST is out.
    signals.emit('SIGTERM');
    onDisk = box.ledger();
    return ok();
  });
  try {
    const { base, next } = await evening(box, { mode: 'on', signals, exit: (code) => exits.push(code) });
    assert.deepEqual(exits, [0]);
    const marked = onDisk.entries[`poltava|GPV3.1|${TOMORROW}`];
    assert.equal(marked.inflight.kind, 'published');
    assert.equal(marked.inflight.mask, marked.pending.mask);

    // The run as the kill left it: the ledger with the send in flight, nothing after.
    writeFileSync(box.ledgerPath, JSON.stringify(onDisk));
    const lines = [];
    await run({ ...base, now: new Date(next), print: (line) => lines.push(line) });
    assert.equal(fake.sends(), 1);
    assert.ok(lines.some((line) => line === `[news] on poltava GPV3.1 ${TOMORROW} - assumed-sent`));
    const entry = box.ledger().entries[`poltava|GPV3.1|${TOMORROW}`];
    assert.equal(entry.told, true);
    assert.equal(entry.sends, 1);
    assert.equal(entry.inflight, null);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  } finally {
    fake.restore();
  }
});

test('a visible alert to anything but q_/s_/e_ is refused before any request', async () => {
  const box = server();
  const fake = google(() => ok());
  try {
    for (const topic of ['region-kyiv', 'general', 'kyiv', '', undefined]) {
      await assert.rejects(sendNews({ message: { topic } }, { credentialsPath: box.credentialsPath }), TopicRefused);
    }
    assert.doesNotThrow(() => assertNewsTopic('q_poltava_GPV3-1'));
    assert.doesNotThrow(() => assertNewsTopic('s_sumy'));
    assert.doesNotThrow(() => assertNewsTopic('e_kyiv'));
    // --test reaches only the test topics.
    assert.throws(() => assertNewsTopic('q_poltava_GPV3-1', { test: true }), TopicRefused);
    assert.equal(await sendTest('region-kyiv', { credentialsPath: box.credentialsPath, print: () => {} }), false);
    assert.equal(await sendTest('q_poltava_GPV3-1', { credentialsPath: box.credentialsPath, print: () => {} }), false);
    assert.equal(fake.calls.length, 0);

    assert.equal(await sendTest('q_test_GPV1-1', { credentialsPath: box.credentialsPath, print: () => {}, now: new Date(at('2026-10-08 12:00')) }), true);
    assert.equal(fake.sends(), 1);
  } finally {
    fake.restore();
  }
});

test('more than the breaker\'s worth sends nothing and leaves a note beside the ledger', async () => {
  const box = server();
  const fake = google(() => ok());
  try {
    const queues = Object.fromEntries(Array.from({ length: 181 }, (_, i) => [`GPV${i + 1}.1`, `Група ${i + 1}.1`]));
    const day = Object.fromEntries(Object.keys(queues).map((queue) => [queue, DARK_7_TO_10]));
    const { lines } = await evening(box, { mode: 'on' }, queues, day);
    assert.equal(fake.calls.length, 0);
    const note = JSON.parse(readFileSync(join(box.root, 'news-breaker.json'), 'utf8'));
    assert.equal(note.count, 181);
    assert.equal(note.sample.length, 10);
    assert.ok(lines.some((line) => line.startsWith('[news] BREAKER 181')));
    assert.ok(Object.values(box.ledger().entries).every((entry) => entry.base !== null && !entry.told));
  } finally {
    fake.restore();
  }
});

test('a corrupt ledger is set aside, and the run starts over silently', async () => {
  const box = server();
  writeFileSync(box.ledgerPath, '{"v":1,"entries":');
  const fake = google(() => ok());
  try {
    const lines = [];
    box.serve('poltava', { 'GPV3.1': 'Черга 3.1' }, { [TOMORROW]: { 'GPV3.1': DARK_7_TO_10 } });
    await run({ fresh: ['poltava'], ledgerPath: box.ledgerPath, served: box.served, fingerprint: 'fp', mode: 'on',
      credentialsPath: box.credentialsPath, signals: new EventEmitter(), print: (line) => lines.push(line), now: new Date(at('2026-10-08 20:45')) });
    assert.ok(readdirSync(box.root).some((name) => /^news-ledger\.bad-\d+\.json$/.test(name)));
    assert.ok(lines.some((line) => line.includes('adopted(rebaseline)')));
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test('the command always exits 0', () => {
  const box = server();
  box.serve('poltava', { 'GPV3.1': 'Черга 3.1' });
  writeFileSync(box.ledgerPath, 'not json');
  const env = { ...process.env };
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  const runs = [
    [],
    ['--test', 'region-kyiv'],
    ['--fresh', 'poltava,atlantis', '--ledger', box.ledgerPath, '--mode', 'on', '--fingerprint', 'fp', '--served', box.served],
    // Nowhere to write the ledger.
    ['--fresh', 'poltava', '--ledger', join(box.root, 'missing', 'news-ledger.json'), '--mode', 'on', '--served', box.served]
  ];
  for (const args of runs) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  }
  assert.ok(existsSync(box.ledgerPath));
});
