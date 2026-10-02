import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unchanged, STAMP_REFRESH_MS } from './lib/change.mjs';

// Decides whether a cycle deploys. Too eager fills Hosting's storage; too lax leaves phones on an
// old schedule.

const now = Date.parse('2026-10-02T09:00:00Z');
const snapshot = (fields = {}) => ({
  regionId: 'rivne',
  lastUpdated: '2026-10-02T08:55:00Z',
  fact: { data: { 1790888400: { 'GPV1.1': { 20: 'no' } } }, update: '02.10.2026 11:30', today: 1790888400 },
  preset: { sch_names: { 'GPV1.1': 'Черга 1.1' }, updateFact: '02.10.2026 11:30' },
  mirroredAt: '2026-10-02T08:30:00Z',
  ...fields
});

test('the mirror\'s own timestamps never count', () => {
  assert.equal(unchanged(snapshot(), snapshot({ lastUpdated: 'x', mirroredAt: 'y' }), now), true);
});

test('a schedule that moved always counts', () => {
  const next = snapshot();
  next.fact = { ...next.fact, data: { 1790888400: { 'GPV1.1': { 20: 'yes' } } } };
  assert.equal(unchanged(snapshot(), next, now), false);
});

test('a restamp alone waits until the served stamp is six hours old', () => {
  const restamped = snapshot();
  restamped.fact = { ...restamped.fact, update: '02.10.2026 12:00' };
  restamped.preset = { ...restamped.preset, updateFact: '02.10.2026 12:00' };
  assert.equal(unchanged(snapshot(), restamped, now), true);
  const old = snapshot({ mirroredAt: new Date(now - STAMP_REFRESH_MS).toISOString() });
  assert.equal(unchanged(old, restamped, now), false);
});

test('no served copy, or one without a mirror time, is always written', () => {
  assert.equal(unchanged(null, snapshot(), now), false);
  const restamped = snapshot();
  restamped.fact = { ...restamped.fact, update: '02.10.2026 12:00' };
  assert.equal(unchanged(snapshot({ mirroredAt: undefined }), restamped, now), false);
});

test('sheets and queues are content, not stamps', () => {
  assert.equal(unchanged(snapshot(), snapshot({ sheets: [{ dayStart: 1 }] }), now), false);
  const next = snapshot();
  next.preset = { ...next.preset, sch_names: {} };
  assert.equal(unchanged(snapshot(), next, now), false);
});
