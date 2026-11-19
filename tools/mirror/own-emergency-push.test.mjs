import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, render, buildMessage, recordSent, ownEmergencyCondition } from './lib/news.mjs';
import { observeRegion } from './lib/news-observe.mjs';
import { buildSnapshot } from './lib/canonical.mjs';
import { assertNewsTarget, sendNews, TopicRefused } from './send-news.mjs';
import { regionById } from './regions.mjs';

// ДТЕК's «Дніпро» lists twelve queues of another operator, ЦЕК, whose emergency orders are its own (lib/cek-in-dnipro.mjs:
// `fact.queueEmergency`). Since 1.16 the app draws the warning for those queues from that field — and nobody was told: the
// region's alert, `e_dnipro`, is ДТЕК's. Here the order goes to the phones that asked for emergency alerts in the region and
// follow one of those queues, and to no one else.

const DNIPRO = regionById('dnipro');
const MIN = 60_000;
const NOON = Date.parse('2026-11-14T12:19:00+02:00');
const TODAY = Math.floor(Date.parse('2026-11-14T00:00:00+02:00') / 1000);
const TOMORROW = TODAY + 86_400;

const QUEUES = { 'GPV5.1': 'Черга 5.1', 'GPV5.2': 'Черга 5.2', 'GPV1005.1': 'ЦЕК 5.1', 'GPV1005.2': 'ЦЕК 5.2' };
const light = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [String(index + 1), 'yes']));

/** A served Дніпро file: a table for today, and the order as lib/cek-in-dnipro.mjs writes it. */
function dnipro({ own = [], region = [] } = {}) {
  const snapshot = buildSnapshot({
    regionId: 'dnipro', title: DNIPRO.title, queues: QUEUES, source: 'dtek',
    fact: { [TODAY]: Object.fromEntries(Object.keys(QUEUES).map((queue) => [queue, light])) }
  });
  snapshot.fact.queueEmergency = { queues: ['GPV1005.1', 'GPV1005.2'], days: own, ...(own.length ? { note: 'для споживачів м. Дніпро' } : {}) };
  if (region.length) snapshot.fact.emergency = region;
  return snapshot;
}

function reader({ fingerprint = 'fp1' } = {}) {
  let ledger = null;
  return {
    read(minute, snapshot, { carried = {}, fp = fingerprint } = {}) {
      const now = new Date(NOON + minute * MIN);
      const result = decide({
        ledger, observations: { dnipro: observeRegion(DNIPRO, snapshot, now) }, now, fingerprint: fp, freshIds: ['dnipro'], carried
      });
      ledger = result.ledger;
      const sent = result.due.map((event) => {
        const text = render(event, now);
        recordSent(ledger, event, now.getTime());
        return { ...event, text, message: buildMessage(event, text, now).message };
      });
      return { sent, log: result.log };
    }
  };
}

test('with no order on, the region is observed exactly as before', () => {
  const now = new Date(NOON);
  assert.equal('own' in observeRegion(DNIPRO, dnipro(), now), false);
  const plain = dnipro();
  delete plain.fact.queueEmergency;
  assert.deepEqual(observeRegion(DNIPRO, dnipro(), now), observeRegion(DNIPRO, plain, now));
});

test('the order is observed for the queues it names, today and tomorrow only', () => {
  const now = new Date(NOON);
  assert.deepEqual(observeRegion(DNIPRO, dnipro({ own: [TODAY] }), now).own, { queues: ['GPV1005.1', 'GPV1005.2'], days: [TODAY] });
  assert.equal('own' in observeRegion(DNIPRO, dnipro({ own: [TODAY - 86_400] }), now), false, 'yesterday\'s is over');
  // A queue the region does not name has no topic anyone could hold; a field of another shape is no order.
  const stray = dnipro({ own: [TODAY] });
  stray.fact.queueEmergency.queues = ['GPV1005.2', 'GPV9999.9', 7];
  assert.deepEqual(observeRegion(DNIPRO, stray, now).own.queues, ['GPV1005.2']);
  const broken = dnipro({ own: [TODAY] });
  broken.fact.queueEmergency = { queues: 'GPV1005.2', days: [TODAY] };
  assert.equal('own' in observeRegion(DNIPRO, broken, now), false);
});

test('ЦЕК\'s order is told to the followers of its queues who asked for emergency alerts, once, after two reads', () => {
  const server = reader();
  server.read(-2, dnipro());
  assert.equal(server.read(0, dnipro({ own: [TODAY] })).sent.length, 0, 'read once: it settles first');
  const { sent } = server.read(2, dnipro({ own: [TODAY] }));
  assert.deepEqual(sent.map((event) => event.key), [`dnipro|#emergency:GPV1005.1|${TODAY}`, `dnipro|#emergency:GPV1005.2|${TODAY}`]);

  const [, second] = sent;
  assert.equal(second.message.topic, undefined, 'never the region\'s topic: that order is ДТЕК\'s to give');
  assert.equal(second.message.condition, "'e_dnipro' in topics && 'q_dnipro_GPV1005-2' in topics");
  assert.deepEqual(second.text, {
    title: 'Аварійні відключення', subtitle: 'Дніпро · ЦЕК 5.2',
    body: 'Оператор вимикає світло понад графік. Сьогодні графік може не виконуватися.'
  });
  assert.equal(second.message.data.kind, 'emergency');
  assert.equal(second.message.data.region, 'dnipro');
  assert.equal(second.message.data.queue, undefined, 'with it the app keeps the banner off a screen that shows this queue');
  assert.equal(second.message.data.deep_link, `svitlo://day?region=dnipro&queue=GPV1005.2&day=${TODAY}`);
  assert.equal(second.message.apns.payload.aps['interruption-level'], 'time-sensitive');
  assert.equal(second.message.apns.headers['apns-collapse-id'], `n.dnipro.e.GPV1005.2.${TODAY}`);
  assert.notEqual(sent[0].message.apns.headers['apns-collapse-id'], second.message.apns.headers['apns-collapse-id']);

  // Lifted and declared again the same day (14 November 2026: 12:19–14:46, then 20:02–21:35): once a day, like the region's.
  for (const [minute, own] of [[4, [TODAY]], [150, []], [152, []], [460, [TODAY]], [462, [TODAY]], [464, [TODAY]]]) {
    assert.equal(server.read(minute, dnipro({ own })).sent.length, 0, `minute ${minute}`);
  }
});

test('ДТЕК\'s order and ЦЕК\'s are two pieces of news, each to its own people', () => {
  const server = reader();
  server.read(-2, dnipro());
  server.read(0, dnipro({ region: [TODAY] }));
  const dtek = server.read(2, dnipro({ region: [TODAY] })).sent;
  assert.deepEqual(dtek.map((event) => [event.message.topic, event.text.subtitle]), [['e_dnipro', 'Дніпро']]);

  server.read(30, dnipro({ region: [TODAY], own: [TODAY] }));
  const cek = server.read(32, dnipro({ region: [TODAY], own: [TODAY] })).sent;
  assert.deepEqual(cek.map((event) => event.text.subtitle), ['Дніпро · ЦЕК 5.1', 'Дніпро · ЦЕК 5.2']);
  assert.ok(cek.every((event) => event.message.topic === undefined && event.message.condition));
});

test('ДТЕК\'s flag held over while YASNO is silent does not hold ЦЕК\'s order back', () => {
  const server = reader();
  server.read(-2, dnipro());
  const carried = { dnipro: ['emergency'] };
  server.read(0, dnipro({ region: [TODAY], own: [TODAY] }), { carried });
  const { sent, log } = server.read(2, dnipro({ region: [TODAY], own: [TODAY] }), { carried });
  assert.deepEqual(sent.map((event) => event.text.subtitle), ['Дніпро · ЦЕК 5.1', 'Дніпро · ЦЕК 5.2']);
  assert.ok(log.some((entry) => entry.key === `dnipro|#emergency|${TODAY}` && entry.outcome === 'held(carried)'));
});

test('our own new code is not ЦЕК\'s news: an order already on at a deploy is taken as known', () => {
  const server = reader();
  server.read(-2, dnipro({ own: [TODAY] }));
  const { sent, log } = server.read(0, dnipro({ own: [TODAY] }), { fp: 'fp2' });
  assert.equal(sent.length, 0);
  assert.ok(log.some((entry) => entry.key === `dnipro|#emergency:GPV1005.2|${TODAY}` && entry.outcome === 'adopted(rebaseline)'));
  assert.equal(server.read(2, dnipro({ own: [TODAY] }), { fp: 'fp2' }).sent.length, 0);
});

test('an order for tomorrow names the day', () => {
  const event = { type: 'emergency', kind: 'emergency', region: 'dnipro', day: TOMORROW, regionTitle: 'Дніпро', queue: 'GPV1005.2', queueName: 'ЦЕК 5.2' };
  const text = render(event, new Date(NOON));
  assert.equal(text.title, 'Аварійні відключення завтра');
  assert.equal(text.subtitle, 'Дніпро · ЦЕК 5.2');
});

test('the only condition a visible alert may be sent by is the region\'s emergency topic and one queue of that region', async () => {
  const good = ownEmergencyCondition('dnipro', 'GPV1005.2');
  assert.equal(good, "'e_dnipro' in topics && 'q_dnipro_GPV1005-2' in topics");
  assert.doesNotThrow(() => assertNewsTarget({ condition: good }));
  assert.doesNotThrow(() => assertNewsTarget({ condition: ownEmergencyCondition('ivano-frankivsk', 'GPV3.1') }));
  assert.doesNotThrow(() => assertNewsTarget({ topic: 'e_dnipro' }), 'a topic is judged as it always was');

  for (const condition of [
    "'e_dnipro' in topics || 'q_dnipro_GPV1005-2' in topics",        // either: everyone with emergency alerts
    "'q_dnipro_GPV1005-2' in topics",                                 // the queue alone: people who asked for schedule news only
    "'e_dnipro' in topics && 'q_kyiv_GPV1-1' in topics",              // another region's queue
    "'e_dnipro' in topics && 'region-dnipro' in topics",              // the silent topic every build holds
    "'e_dnipro' in topics && !('q_dnipro_GPV1005-2' in topics)",
    "'e_dnipro' in topics && 'q_dnipro_GPV1005-2' in topics || 'region-dnipro' in topics",
    '', 7, null
  ]) {
    assert.throws(() => assertNewsTarget({ condition }), TopicRefused, String(condition));
  }
  assert.throws(() => assertNewsTarget({ condition: good, topic: 'e_dnipro' }), TopicRefused, 'one or the other');
  assert.throws(() => assertNewsTarget({ condition: good }, { test: true }), TopicRefused, 'a test goes to a q_test_ topic only');
  assert.throws(() => assertNewsTarget({}), TopicRefused);
  // And nothing is posted for a refused one: it throws before the request.
  await assert.rejects(sendNews({ message: { condition: "'region-dnipro' in topics" } }, { credentialsPath: '/nonexistent' }), TopicRefused);
});
