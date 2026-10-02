import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beatAge, isFresh, LABEL, MAX_AGE_SECONDS } from './lib/heartbeat.mjs';

// Decides whether GitHub stands down. Wrong one way: two writers overwrite each other's copies.
// Wrong the other way: nobody publishes.

const now = 1_790_900_000;

test('a recent beat stands GitHub down', () => {
  assert.equal(isFresh({ [LABEL]: String(now - 300) }, now), true);
});

test('a beat older than the limit does not', () => {
  assert.equal(isFresh({ [LABEL]: String(now - MAX_AGE_SECONDS - 1) }, now), false);
  assert.equal(isFresh({ [LABEL]: String(now - MAX_AGE_SECONDS) }, now), true);
});

test('no beat, a garbled beat or no labels at all mean GitHub publishes', () => {
  assert.equal(isFresh({}, now), false);
  assert.equal(isFresh(undefined, now), false);
  assert.equal(isFresh({ [LABEL]: 'soon' }, now), false);
  assert.equal(isFresh({ [LABEL]: '0' }, now), false);
  assert.equal(beatAge({ other: '1' }, now), null);
});

test('a beat from the future is a broken clock, not a healthy runner', () => {
  assert.equal(isFresh({ [LABEL]: String(now + 30) }, now), true);
  assert.equal(isFresh({ [LABEL]: String(now + 3600) }, now), false);
});
