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
    { id: 'rivne', stale: true }
  ];
  assert.deepEqual(regionsToRelay(rows, now), ['sumy']);
});

test('a relayed copy is used only while recent, for its own region, and only if it holds up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-'));
  const put = (name, value) => writeFile(join(dir, `${name}.json`), JSON.stringify(value));

  await put('sumy', { ...snapshot, relayedAt: new Date(now - 3600_000).toISOString() });
  const fresh = await readRelay(dir, 'sumy', now);
  assert.equal(fresh.snapshot.regionId, 'sumy');
  assert.equal('relayedAt' in fresh.snapshot, false);

  await put('sumy', { ...snapshot, relayedAt: new Date(now - RELAY_MAX_AGE_MS - 1).toISOString() });
  assert.equal(await readRelay(dir, 'sumy', now), null);

  await put('lviv', { ...snapshot, relayedAt: new Date(now).toISOString() });
  assert.equal(await readRelay(dir, 'lviv', now), null, 'another region\'s file');

  await put('kyiv', { regionId: 'kyiv', relayedAt: new Date(now).toISOString() });
  assert.equal(await readRelay(dir, 'kyiv', now), null, 'fails validation');

  assert.equal(await readRelay(dir, 'odesa', now), null, 'no file');
});
