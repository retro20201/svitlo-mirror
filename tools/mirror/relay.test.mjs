import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleSince, regionsToRelay, readRelay, RELAY_MAX_AGE_MS } from './lib/relay.mjs';
import { buildSnapshot, queueNames, NATIONAL_QUEUES } from './lib/canonical.mjs';

const now = Date.parse('2026-10-02T12:00:00Z');
const snapshot = buildSnapshot({ regionId: 'sumy', title: 'Сумська область', queues: queueNames(NATIONAL_QUEUES), source: 'sumy' });

test('a region keeps the time it first failed for as long as it keeps failing', () => {
  assert.equal(staleSince({ stale: true, staleSince: '2026-10-02T08:00:00.000Z' }, new Date(now)), '2026-10-02T08:00:00.000Z');
  assert.equal(staleSince({ stale: false }, new Date(now)), new Date(now).toISOString());
  assert.equal(staleSince(undefined, new Date(now)), new Date(now).toISOString());
});

test('GitHub steps in only for regions failing longer than a blip', () => {
  const rows = [
    { id: 'sumy', stale: true, staleSince: '2026-10-02T11:00:00Z' },
    { id: 'lviv', stale: true, staleSince: '2026-10-02T11:55:00Z' },
    { id: 'kyiv' },
    { id: 'rivne', stale: true },
    { id: 'poltava', stale: true, staleSince: '2026-10-02T10:00:00Z', notStarted: true }
  ];
  assert.deepEqual(regionsToRelay(rows, now), ['sumy']);
});

const failing = { stale: true, staleSince: new Date(now - 2 * 3600_000).toISOString() };

test('a relayed copy is used only while recent, for its own region, and only if it holds up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-'));
  const put = (name, value) => writeFile(join(dir, `${name}.json`), JSON.stringify(value));
  const read = (id) => readRelay(dir, id, { now, previousRow: failing });

  await put('sumy', { ...snapshot, relayedAt: new Date(now - 3600_000).toISOString() });
  const fresh = await read('sumy');
  assert.equal(fresh.snapshot.regionId, 'sumy');
  assert.equal('relayedAt' in fresh.snapshot, false);

  await put('sumy', { ...snapshot, relayedAt: new Date(now - RELAY_MAX_AGE_MS - 1).toISOString() });
  assert.equal(await read('sumy'), null);

  await put('lviv', { ...snapshot, relayedAt: new Date(now).toISOString() });
  assert.equal(await read('lviv'), null, 'another region\'s file');

  await put('kyiv', { regionId: 'kyiv', relayedAt: new Date(now).toISOString() });
  assert.equal(await read('kyiv'), null, 'fails validation');

  assert.equal(await read('odesa'), null, 'no file');
});

test('a copy left over from an earlier failure is not used on a one-cycle blip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-'));
  await writeFile(join(dir, 'sumy.json'), JSON.stringify({ ...snapshot, relayedAt: new Date(now - 3600_000).toISOString() }));
  // Recovered since: the previous cycle read the region fine.
  assert.equal(await readRelay(dir, 'sumy', { now, previousRow: { stale: false } }), null);
  // Failing now, but this streak began after GitHub's read: the copy is from the last one.
  assert.equal(await readRelay(dir, 'sumy', { now, previousRow: { stale: true, staleSince: new Date(now - 600_000).toISOString() } }), null);
  // Something newer than the copy is already on phones.
  assert.equal(await readRelay(dir, 'sumy', { now, previousRow: failing, served: { mirroredAt: new Date(now - 1800_000).toISOString() } }), null);
  // The same copy during the failure it was read for is used.
  assert.ok(await readRelay(dir, 'sumy', { now, previousRow: failing, served: { mirroredAt: new Date(now - 3 * 3600_000).toISOString() } }));
});
