import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factFromGraphs } from './sources/ternopil.mjs';

/**
 * `/api/a_gpv_g` only ever serves the *currently active* graph, so out of season there is no live
 * payload to capture and nothing archived one. These fixtures are built to the shape the
 * operator's own front-end bundle reads — `dataJson["<черга>"].times["HH:00"|"HH:30"]`, with `"1"`
 * painted dark, `"10"` grey, anything else light and missing keys defaulted to `"0"` — which is a
 * first-party reading of the field but not a recording of one. They pin the mapping we ship; the
 * first real in-season payload is what confirms it.
 */

/** Europe/Kyiv midnight of 2025-12-15, i.e. what `kyivDayStart` returns for that winter day. */
const DAY = 1765749600;

function graph(times, overrides = {}) {
  return {
    '@id': '/api/actual_gpv_graphs/1',
    '@type': 'ActualGpvGraph',
    dateCreate: '2025-12-14T18:42:11+00:00',
    dateGraph: '2025-12-15T00:00:00+00:00',
    imageUrl: '/uploads/gpv/2025-12-15.png',
    rawHtml: '<table>…</table>',
    dataJson: { '4.1': { times } },
    ...overrides
  };
}

test('half-hour codes fold into the hour codes the app decodes', () => {
  const { fact } = factFromGraphs([graph({
    '00:00': '1',  '00:30': '1',    // whole hour dark
    '01:00': '1',  '01:30': '0',    // dark first half only
    '02:00': '0',  '02:30': '1',    // dark second half only
    '10:00': '10', '10:30': '10',   // whole hour uncertain
    '11:00': '10', '11:30': '1',    // half uncertain, half dark — no promise of light
    '12:00': '10', '12:30': '0'     // uncertain first half only
  })]);

  const hours = fact[DAY]['GPV4.1'];
  assert.equal(hours['1'], 'no');
  assert.equal(hours['2'], 'first');
  assert.equal(hours['3'], 'second');
  assert.equal(hours['11'], 'maybe');
  assert.equal(hours['12'], 'no');
  assert.equal(hours['13'], 'mfirst');
});

test('hours the graph says nothing about are light, and all 24 are emitted', () => {
  const { fact } = factFromGraphs([graph({ '20:00': '1', '20:30': '1' })]);
  const hours = fact[DAY]['GPV4.1'];

  assert.equal(Object.keys(hours).length, 24);
  assert.equal(hours['21'], 'no');
  assert.equal(hours['1'], 'yes');
  assert.equal(hours['24'], 'yes');
});

test('a code we do not recognise is "можливо", never "світло є"', () => {
  // Promising power we have no basis for is the failure that costs someone their fridge.
  const { fact } = factFromGraphs([graph({ '08:00': '7', '08:30': '7' })]);
  assert.equal(fact[DAY]['GPV4.1']['9'], 'maybe');
});

test('the "#suffix" the operator appends to a queue key is not part of the queue', () => {
  const { fact, labels } = factFromGraphs([
    graph({ '05:00': '1', '05:30': '1' }, { dataJson: { '1.2#Бережани': { times: { '05:00': '1', '05:30': '1' } } } })
  ]);

  assert.deepEqual(labels, ['1.2']);
  assert.equal(fact[DAY]['GPV1.2']['6'], 'no');
});

test('two graphs for the same day and queue merge to the darker half-hour', () => {
  // Localities can be split across separate graphs with no field saying which address each
  // covers, so the union of the outages is the only honest answer.
  const { fact } = factFromGraphs([
    graph({ '03:00': '1', '03:30': '1' }),
    graph({ '03:00': '0', '03:30': '0', '04:00': '10', '04:30': '10' })
  ]);

  const hours = fact[DAY]['GPV4.1'];
  assert.equal(hours['4'], 'no');
  assert.equal(hours['5'], 'maybe');
});

test('each dateGraph keys its own Europe/Kyiv day', () => {
  const { fact } = factFromGraphs([
    graph({ '00:00': '1', '00:30': '1' }),
    graph({ '00:00': '1', '00:30': '1' }, { dateGraph: '2025-12-16T00:00:00+00:00' })
  ]);

  assert.deepEqual(Object.keys(fact).sort(), [String(DAY), '1765836000']);
});

test('the newest dateCreate is what the app shows as the operator timestamp', () => {
  const { update } = factFromGraphs([
    graph({}, { dateCreate: '2025-12-14T18:42:11+00:00' }),
    graph({}, { dateCreate: '2025-12-14T21:05:00+00:00', dateGraph: '2025-12-16T00:00:00+00:00' })
  ]);
  assert.equal(update, '2025-12-14T21:05:00+00:00');
});

test('out of season the empty collection yields no schedule and no error', () => {
  // What the endpoint actually returns today: `{"hydra:member": [], "hydra:totalItems": 0}`.
  assert.deepEqual(factFromGraphs([]), { fact: {}, labels: [], update: null });
});

test('an unfamiliar dataJson is skipped rather than guessed at', () => {
  const wrong = [
    graph({}, { dataJson: null }),
    graph({}, { dataJson: [{ '4.1': {} }] }),
    graph({}, { dataJson: { '4.1': { hours: ['off', 'off'] } } }),
    graph({}, { dataJson: { '4.1': { times: ['1', '1'] } } }),
    graph({}, { dateGraph: null })
  ];

  for (const member of wrong) {
    assert.deepEqual(factFromGraphs([member]).fact, {}, JSON.stringify(member.dataJson));
  }
  assert.deepEqual(factFromGraphs(null).fact, {});
  assert.deepEqual(factFromGraphs(undefined).fact, {});
});
