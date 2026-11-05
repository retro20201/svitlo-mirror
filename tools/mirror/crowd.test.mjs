import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, acceptedByRules, reportId, wellFormed, WINDOW_MS, THRESHOLD, hourBucket } from './lib/crowd.mjs';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const min = (n) => NOW - n * 60_000;
const dev = (n) => String(n).padStart(16, '0').replace(/[^0-9a-f]/g, 'a');
const rep = (device, state, ago, over = {}) => ({ d: dev(device), r: 'odesa', q: 'GPV2.1', s: state, t: min(ago), ...over });

test('three devices saying the light is back make a signal, with the latest time of them', () => {
  const { queues } = aggregate([rep(1, 'on', 12), rep(2, 'on', 6), rep(3, 'on', 3)], NOW);
  assert.deepEqual(queues, { odesa: { 'GPV2.1': { state: 'on', count: 3, at: new Date(min(3)).toISOString() } } });
});

test('two devices are not enough', () => {
  assert.equal(THRESHOLD, 3);
  assert.deepEqual(aggregate([rep(1, 'on', 5), rep(2, 'on', 4)], NOW).queues, {});
});

test('one device saying it many times is one device', () => {
  const same = [rep(1, 'on', 15), rep(1, 'on', 10), rep(1, 'on', 5), rep(1, 'on', 2), rep(2, 'on', 3)];
  assert.deepEqual(aggregate(same, NOW).queues, {});
});

test('a report older than the window is silent', () => {
  const old = [rep(1, 'on', 21), rep(2, 'on', 25), rep(3, 'on', 4)];
  assert.equal(WINDOW_MS, 20 * 60_000);
  assert.deepEqual(aggregate(old, NOW).queues, {});
});

test("a device's latest word counts: off, then on, is on", () => {
  const flips = [rep(1, 'off', 15), rep(1, 'on', 5), rep(2, 'on', 6), rep(3, 'on', 4)];
  assert.equal(aggregate(flips, NOW).queues.odesa['GPV2.1'].state, 'on');
  const back = [rep(1, 'on', 15), rep(1, 'off', 5), rep(2, 'on', 6), rep(3, 'on', 4)];
  assert.deepEqual(aggregate(back, NOW).queues, {}, 'two on and one off: no longer three');
});

test('a queue the devices disagree about says nothing', () => {
  const split = [1, 2, 3].map((n) => rep(n, 'on', 5)).concat([4, 5, 6].map((n) => rep(n, 'off', 5)));
  assert.deepEqual(aggregate(split, NOW).queues, {});
});

test('one side wins when it is twice the other', () => {
  const lead = [1, 2, 3, 4].map((n) => rep(n, 'off', 5)).concat([rep(5, 'on', 4)]);
  assert.equal(aggregate(lead, NOW).queues.odesa['GPV2.1'].state, 'off');
});

test('queues and regions are counted apart', () => {
  const mixed = [rep(1, 'on', 5), rep(2, 'on', 5), rep(3, 'on', 5, { q: 'GPV1.1' }), rep(4, 'on', 5, { r: 'kyiv' })];
  assert.deepEqual(aggregate(mixed, NOW).queues, {});
});

test('malformed reports, unknown regions and times from the future are ignored', () => {
  const bad = [
    rep(1, 'on', 5, { d: 'not-a-device' }), rep(2, 'maybe', 5), rep(3, 'on', 5, { q: '' }), rep(4, 'on', -30),
    rep(5, 'on', 5), rep(6, 'on', 5), rep(7, 'on', 5, { r: 'atlantis' })
  ];
  assert.deepEqual(aggregate(bad, NOW).queues, {});
  const known = new Set(['odesa']);
  const three = [1, 2, 3].map((n) => rep(n, 'on', 5, { r: 'atlantis' }));
  assert.deepEqual(aggregate(three, NOW, { known }).queues, {});
  assert.ok(Object.keys(aggregate(three, NOW).queues).length === 1, 'without a list every well-formed region counts');
});

test('the output carries no device code', () => {
  const out = JSON.stringify(aggregate([1, 2, 3].map((n) => rep(n, 'on', 5)), NOW));
  for (const n of [1, 2, 3]) assert.ok(!out.includes(dev(n)));
});

// The rules, as the function that stands for them.
const SERVER = Date.parse('2026-11-05T14:30:00Z');
const doc = (over = {}) => ({ d: dev(1), r: 'odesa', q: 'GPV2.1', s: 'on', t: SERVER, ...over });

test('the rules take a report named for its device, place, state and hour — once', () => {
  const data = doc();
  const name = reportId(data, SERVER);
  assert.equal(name, `${dev(1)}_odesa_GPV2.1_on_${hourBucket(SERVER)}`);
  assert.equal(acceptedByRules(name, data, SERVER), true);
  assert.equal(acceptedByRules(name, data, SERVER, new Set([name])), false, 'a second report in the same hour');
  // Another hour, another state, another queue: new names.
  const later = SERVER + 61 * 60_000;
  assert.equal(acceptedByRules(reportId(data, later), data, later, new Set([name])), true);
  assert.equal(acceptedByRules(reportId(doc({ s: 'off' }), SERVER), doc({ s: 'off' }), SERVER, new Set([name])), true);
  assert.equal(acceptedByRules(reportId(doc({ q: 'GPV1.1' }), SERVER), doc({ q: 'GPV1.1' }), SERVER, new Set([name])), true);
});

test('the rules refuse a name that is not the report, extra fields and bad values', () => {
  const data = doc();
  assert.equal(acceptedByRules('anything', data, SERVER), false);
  assert.equal(acceptedByRules(reportId(data, SERVER), { ...data, extra: 1 }, SERVER), false);
  const { t, ...noTime } = data;
  assert.equal(acceptedByRules(reportId(data, SERVER), noTime, SERVER), false);
  for (const bad of [{ d: 'XYZ' }, { s: 'off ' }, { r: 'A' }, { q: 'a'.repeat(17) }]) {
    assert.equal(wellFormed({ ...data, ...bad }), false);
  }
});
