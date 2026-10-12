import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backoffMs, createClient, curlFetch, decodeBody, FetchError, insideGitCheckout, openRawFolder, parseArgs,
  parseCurlHeaders, REPO_ROOT, retryAfterMs, safeRelative, sha256, UA_POLITE
} from './http.mjs';

/** A local server answering from a script of [status, body, headers] steps, then repeating the last. */
async function serve(steps) {
  const seen = [];
  const server = createServer((req, res) => {
    const [status, body = '', headers = {}] = steps[Math.min(seen.length, steps.length - 1)];
    seen.push({ url: req.url, ua: req.headers['user-agent'], method: req.method });
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const quiet = { log: () => {}, minDelayMs: 0, jitterMs: 0, transport: 'fetch' };
/** A client whose sleeps are recorded instead of waited for. */
const fast = (extra = {}) => {
  const sleeps = [];
  return { sleeps, client: createClient({ ...quiet, sleepImpl: async (ms) => { sleeps.push(ms); }, ...extra }) };
};

test('a 502 is retried with back-off and the next 200 is returned', async (t) => {
  const s = await serve([[502], [200, 'hello']]);
  t.after(s.close);
  const { client, sleeps } = fast({ random: () => 0.5 });
  const res = await client.get(`${s.url}/a`);
  assert.equal(res.body.toString(), 'hello');
  assert.equal(res.attempts, 2);
  assert.equal(s.seen.length, 2);
  assert.deepEqual(sleeps, [5000]);
});

test('a 404 is final: no retry, and the error carries the status', async (t) => {
  const s = await serve([[404, 'nope']]);
  t.after(s.close);
  const { client } = fast();
  await assert.rejects(client.get(`${s.url}/missing`), (err) => err instanceof FetchError && err.status === 404 && err.attempts === 1);
  assert.equal(s.seen.length, 1);
});

test('a 200 that fails validation counts as a failed attempt, not a download', async (t) => {
  // The sites we read answer a challenge page with a success status.
  const s = await serve([[200, 'challenge'], [200, 'challenge'], [200, 'the real document']]);
  t.after(s.close);
  const { client } = fast();
  const res = await client.get(s.url, { validate: (buf) => (buf.toString().includes('real') ? null : 'a challenge page') });
  assert.equal(res.body.toString(), 'the real document');
  assert.equal(res.attempts, 3);

  const s2 = await serve([[200, 'challenge']]);
  t.after(s2.close);
  await assert.rejects(
    fast({ maxAttempts: 3 }).client.get(s2.url, { validate: () => 'a challenge page' }),
    (err) => err.attempts === 3 && /a challenge page/.test(err.reason)
  );
});

test('Retry-After wins over the computed back-off, capped', async (t) => {
  const s = await serve([[429, '', { 'retry-after': '7' }], [429, '', { 'retry-after': '99999' }], [200, 'ok']]);
  t.after(s.close);
  const { client, sleeps } = fast({ maxRetryAfterMs: 60000 });
  await client.get(s.url);
  assert.deepEqual(sleeps, [7000, 60000]);
});

test('requests are paced: the gap before the second request is the configured delay', async (t) => {
  const s = await serve([[200, 'x']]);
  t.after(s.close);
  const { client, sleeps } = fast({ minDelayMs: 1500, jitterMs: 0 });
  await client.get(s.url);
  await client.get(s.url);
  assert.equal(sleeps.length, 1, 'no wait before the first request');
  assert.ok(sleeps[0] > 1400 && sleeps[0] <= 1500, `waited ${sleeps[0]}`);
});

test('the descriptive User-Agent is sent unless a request overrides it', async (t) => {
  const s = await serve([[200, 'x']]);
  t.after(s.close);
  const { client } = fast();
  await client.get(s.url);
  await client.get(s.url, { userAgent: 'Other/1' });
  assert.deepEqual(s.seen.map((r) => r.ua), [UA_POLITE, 'Other/1']);
  assert.match(UA_POLITE, /Svitlo-aliases\/1\.0/);
});

test('a transport that throws is retried like a 5xx and gives up with the reason', async () => {
  let calls = 0;
  const { client } = fast({ transport: async () => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }, maxAttempts: 3 });
  await assert.rejects(client.get('http://example.invalid/'), (err) => err.attempts === 3 && /ECONNRESET/.test(err.reason));
  assert.equal(calls, 3);
});

test('curl can stand in for fetch, with status, final URL and headers', async (t) => {
  const s = await serve([[200, 'from curl', { 'content-type': 'text/plain; charset=utf-8', 'x-test': 'yes' }]]);
  t.after(s.close);
  const res = await curlFetch(`${s.url}/p`, { headers: { 'user-agent': 'curl-test' } });
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'from curl');
  assert.equal(res.headers.get('x-test'), 'yes');
  assert.equal(s.seen[0].ua, 'curl-test');
  // And through the client, as the Rada fetcher uses it:
  const via = await createClient({ ...quiet, transport: 'curl' }).get(`${s.url}/q`);
  assert.equal(via.body.toString(), 'from curl');
});

test('curl header output keeps only the last response of a redirect chain', () => {
  const h = parseCurlHeaders('HTTP/1.1 302 Found\r\nLocation: /x\r\n\r\nHTTP/2 200\r\ncontent-type: text/html\r\nretry-after: 3\r\n\r\n');
  assert.equal(h.get('content-type'), 'text/html');
  assert.equal(h.get('retry-after'), '3');
  assert.equal(h.get('location'), null);
});

test('Retry-After parses seconds and dates; back-off doubles and is capped', () => {
  assert.equal(retryAfterMs('12'), 12000);
  assert.equal(retryAfterMs('Mon, 12 Oct 2026 15:00:10 GMT', Date.parse('Mon, 12 Oct 2026 15:00:00 GMT')), 10000);
  assert.equal(retryAfterMs('soon'), null);
  const o = { baseMs: 1000, maxMs: 5000, random: () => 0.5 };
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffMs(n, o)), [1000, 2000, 4000, 5000, 5000]);
});

test('bodies are decoded with the charset the server or the page declares', () => {
  const win = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет» in windows-1251
  assert.equal(decodeBody(win, 'text/html; charset=Windows-1251'), 'Привет');
  assert.equal(decodeBody(Buffer.concat([Buffer.from('<meta charset="windows-1251">'), win])).endsWith('Привет'), true);
  assert.equal(decodeBody(Buffer.from('Привіт')), 'Привіт');
});

test('a raw folder must be new or empty, and never inside a git checkout', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'raw-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const ok = await openRawFolder(join(base, 'one'), { source: 'one' });
  await ok.save('a.txt', Buffer.from('x'));
  await assert.rejects(openRawFolder(join(base, 'one'), { source: 'one' }), /not empty/);

  await mkdir(join(base, 'full'));
  await writeFile(join(base, 'full', 'stray.txt'), 'x');
  await assert.rejects(openRawFolder(join(base, 'full'), { source: 'full' }), /not empty/);

  await assert.rejects(openRawFolder(join(REPO_ROOT, 'firebase', 'public', 'v1', 'addr', 'raw-test'), { source: 'x' }), /inside a git checkout/);
  assert.equal(await insideGitCheckout(base), false);
  assert.equal(await insideGitCheckout(REPO_ROOT), true);
});

test('resume keeps intact files, notices a changed one, and refuses another source\'s folder', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'raw-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, 'src');

  const first = await openRawFolder(dir, { source: 'src' });
  const entry = await first.save('doc.html', Buffer.from('<html>one</html>'), { url: 'https://example.test/doc' });
  await first.fail('bad.html', 'https://example.test/bad', 'HTTP 403');
  await first.finish();
  assert.equal(entry.sha256, sha256(Buffer.from('<html>one</html>')));
  assert.equal(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).failures.length, 1);

  const again = await openRawFolder(dir, { source: 'src', resume: true });
  assert.equal(await again.has('doc.html'), true);
  assert.equal(await again.has('bad.html'), false);
  await writeFile(join(dir, 'doc.html'), 'tampered');
  assert.equal(await again.has('doc.html'), false);
  // Saving the failed file clears its failure.
  await again.save('bad.html', Buffer.from('<html>fixed</html>'));
  assert.equal(again.manifest.failures.length, 0);

  await assert.rejects(openRawFolder(dir, { source: 'other', resume: true }), /no manifest for source "other"/);
});

test('a download cannot be written outside its folder', () => {
  assert.equal(safeRelative('a/b.json'), 'a/b.json');
  for (const bad of ['../x', '/etc/x', '..', 'a/../../x']) assert.throws(() => safeRelative(bad), /unsafe path/);
});

test('flags and positionals are separated', () => {
  assert.deepEqual(parseArgs(['out', '--resume', '--only=a,b', 'x']), { flags: { resume: true, only: 'a,b' }, positional: ['out', 'x'] });
});
