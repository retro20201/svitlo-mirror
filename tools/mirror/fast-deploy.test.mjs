import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { prepare, release, discard, gzipped, regionFiles, LiveMoved } from './fast-deploy.mjs';
import { readsThisCycle } from './lib/lanes.mjs';

const LIVE = 'sites/koly-svitlo/versions/live1';
const CLONE = 'sites/koly-svitlo/versions/clone1';

/** A Hosting API that records every call and answers like the real one. */
function fakeHosting({ live = LIVE, cloneSteps = 2, known = [] } = {}) {
  const calls = [];
  let polls = 0;
  const call = async (path, init = {}) => {
    calls.push([init.method ?? 'GET', path, init.body ? JSON.parse(init.body) : undefined]);
    if (path === '/sites/koly-svitlo/channels/live') return { release: { version: { name: live } } };
    if (path === '/sites/koly-svitlo/versions:clone') return { name: 'operations/op1', done: false };
    if (path === '/operations/op1') {
      polls++;
      return polls >= cloneSteps ? { name: 'operations/op1', done: true, response: { name: CLONE } } : { name: 'operations/op1', done: false };
    }
    if (path === `/${CLONE}:populateFiles`) {
      const files = JSON.parse(init.body).files;
      return { uploadRequiredHashes: Object.values(files).filter((hash) => !known.includes(hash)), uploadUrl: 'https://upload.example/x' };
    }
    return {};
  };
  return { call, calls };
}

test('prepare clones the live version, unfinalized, and waits for the clone', async () => {
  const { call, calls } = fakeHosting({ cloneSteps: 3 });
  const prepared = await prepare(call, { pollMs: 0, sleep: async () => {} });
  assert.deepEqual(prepared, { source: LIVE, version: CLONE });
  const clone = calls.find(([, path]) => path.endsWith('versions:clone'));
  assert.deepEqual(clone[2], { sourceVersion: LIVE, finalize: false });
  assert.equal(calls.filter(([, path]) => path === '/operations/op1').length, 3);
});

test('release uploads only what Firebase lacks, then finalizes and releases the clone', async () => {
  const kyiv = Buffer.from('{"regionId":"kyiv"}');
  const sumy = Buffer.from('{"regionId":"sumy"}');
  const { call, calls } = fakeHosting({ known: [gzipped(sumy).hash] });
  const uploads = [];
  const result = await release(call, async (url, bytes) => uploads.push([url, gunzipSync(bytes).toString()]),
    { source: LIVE, version: CLONE }, [['/v1/kyiv.json', kyiv], ['/v1/sumy.json', sumy]], 'kyiv abc');
  assert.deepEqual(result, { uploaded: 1, files: 2 });
  assert.deepEqual(uploads, [[`https://upload.example/x/${gzipped(kyiv).hash}`, '{"regionId":"kyiv"}']]);
  const steps = calls.map(([method, path]) => `${method} ${path.split('?')[0]}`);
  assert.deepEqual(steps, [
    'GET /sites/koly-svitlo/channels/live',
    `POST /${CLONE}:populateFiles`,
    `PATCH /${CLONE}`,
    'POST /sites/koly-svitlo/releases'
  ]);
  assert.deepEqual(calls[2][2], { status: 'FINALIZED' });
  assert.match(calls[3][1], /versionName=sites%2Fkoly-svitlo%2Fversions%2Fclone1/);
});

test('a release over a live version that moved since the clone is refused, not forced', async () => {
  const { call, calls } = fakeHosting({ live: 'sites/koly-svitlo/versions/github-deployed' });
  await assert.rejects(
    release(call, async () => assert.fail('nothing may be uploaded'), { source: LIVE, version: CLONE }, [['/v1/kyiv.json', Buffer.from('{}')]], 'm'),
    (error) => error instanceof LiveMoved && /moved since the clone/.test(error.message)
  );
  assert.equal(calls.length, 1, 'only the check');
});

test('discard deletes the clone', async () => {
  const { call, calls } = fakeHosting();
  await discard(call, { source: LIVE, version: CLONE });
  assert.deepEqual(calls, [['DELETE', `/${CLONE}`, undefined]]);
});

test('only the region files are released, never the address dictionaries', async () => {
  const files = await regionFiles();
  assert.ok(files.length > 0);
  assert.ok(files.every(([path]) => /^\/v1\/[a-z0-9-]+\.json$/.test(path)), files.map(([p]) => p).join(', '));
});

test('on the Kyiv server, only a region with nothing out waits for the slow turn', () => {
  const region = { id: 'lviv' };
  const quiet = { status: 'seasonal', hasSchedule: false };
  assert.equal(readsThisCycle(region, quiet, { slowLane: true, slowTurn: false }), false);
  assert.equal(readsThisCycle(region, quiet, { slowLane: true, slowTurn: true }), true);

  // A schedule out, an operator's picture out (Хмельницький), failing, kept live, or new: always.
  for (const [row, reg] of [
    [{ status: 'live', hasSchedule: true }, region],
    [{ status: 'image', hasSchedule: true }, { id: 'khmelnytskyi' }],
    [{ status: 'seasonal', stale: true }, region],
    [quiet, { id: 'kyiv', staysLive: true }],
    [undefined, region]
  ]) {
    assert.equal(readsThisCycle(reg, row, { slowLane: true, slowTurn: false }), true, JSON.stringify(row));
  }
  // Off the Kyiv server, every region every time.
  assert.equal(readsThisCycle(region, quiet, { slowTurn: false }), true);
});
