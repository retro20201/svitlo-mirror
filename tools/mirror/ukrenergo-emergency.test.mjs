import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REGIONS, regionById, indexEntry } from './regions.mjs';
import { ADAPTERS } from './adapters.mjs';
import { kyivDayStart } from './lib/canonical.mjs';
import { markCarried, carriedParts } from './lib/carried.mjs';
import { statementOf, readUkrenergo, withUkrenergoEmergency, MAX_AGE_MS } from './lib/ukrenergo-emergency.mjs';

// @Ukrenergo's own posts, 7 October – 19 November 2026: every one that names the oblasts under «аварійні відключення», and the
// ones beside them that must not be read as naming any. On the 19th, at 10:39 Kyiv, the channel named Полтавська область; the
// operator's page said nothing, the app showed no warning, and at 11:08 a person there wrote that the light had not come back.
const POSTS = JSON.parse(readFileSync(new URL('./ukrenergo.fixture-2026-11-19.json', import.meta.url), 'utf8'));
const at = (iso) => new Date(iso);
const post = (id) => POSTS.find((entry) => entry.id === id);
/** The word for `oblast` at `iso`, told from the posts the channel had then. */
const wordAt = (oblast, iso, options = {}) =>
  readUkrenergo(POSTS.filter((entry) => Date.parse(entry.postedAt) <= Date.parse(iso)), { oblast, now: at(iso), ...options });

test('the morning Укренерго named Полтавська область, the oblast is under the order — in the channel\'s words, with its name and hour', () => {
  assert.equal(wordAt('Полтавськ', '2026-11-19T08:30:00Z').active, false, 'the list of the 18th was Харківська and Сумська');
  const word = wordAt('Полтавськ', '2026-11-19T09:08:00Z');
  assert.equal(word.active, true);
  assert.equal(word.since, '2026-11-19T08:39:08+00:00');
  assert.equal(word.note, '«Через пошкодження енергетичного обладнання у Сумській, Полтавській, Харківській та Дніпропетровській областях '
    + 'наразі вимушено застосовуються аварійні відключення» — Укренерго, 10:39');
});

test('a word nobody takes back is believed for twelve hours', () => {
  assert.equal(MAX_AGE_MS, 12 * 3600 * 1000);
  assert.equal(wordAt('Полтавськ', '2026-11-19T20:38:00Z').active, true);
  assert.equal(wordAt('Полтавськ', '2026-11-19T20:40:00Z').active, false);
});

test('the oblasts are read from the order\'s sentence, not from the list of where the shelling left people without power', () => {
  // 17 November, 11:58: «знеструмлена частина споживачів у Дніпропетровській, Донецькій, Запорізькій, Миколаївській, Одеській,
  // Рівненській, Сумській, Чернігівській та Чернівецькій областях», and a paragraph down the order: Кіровоградська, Полтавська, Сумська.
  const now = '2026-11-17T10:30:00Z';
  for (const oblast of ['Кіровоградськ', 'Полтавськ']) assert.equal(wordAt(oblast, now).active, true, oblast);
  for (const oblast of ['Миколаївськ', 'Одеськ', 'Рівненськ', 'Чернівецьк']) assert.equal(wordAt(oblast, now).active, false, oblast);
});

test('the newest list is the word: an oblast it leaves out is no longer under the order, one it repeats is so from that hour', () => {
  assert.equal(wordAt('Харківськ', '2026-11-17T09:00:00Z').active, true, '10:06: «діють у Полтавській та Харківській областях»');
  assert.equal(wordAt('Харківськ', '2026-11-17T10:30:00Z').active, false, 'not in the list of 11:58');
  assert.equal(wordAt('Полтавськ', '2026-11-17T09:00:00Z').since, post(5648).postedAt);
  assert.equal(wordAt('Полтавськ', '2026-11-17T10:30:00Z').since, post(5649).postedAt);
});

test('«зранку застосовувалися» is said of a morning that is over', () => {
  // 9 November, 11:42: «зранку застосовуються»; 10 November, 11:25: «У Київській, Сумській, Полтавській та Харківській областях
  // зранку застосовувалися графіки аварійних відключень». Asked with a day and a half of belief, so that only the words decide.
  const long = { maxAgeMs: 36 * 3600 * 1000 };
  assert.equal(wordAt('Полтавськ', '2026-11-10T09:20:00Z', long).active, true);
  assert.equal(wordAt('Полтавськ', '2026-11-10T09:30:00Z', long).active, false);
  assert.deepEqual(statementOf(post(5629).text), { on: [] });
});

test('«скасовано … продовжують діяти лише у Харківській області» leaves the one oblast it names', () => {
  assert.deepEqual(statementOf(post(5608).text).on.map((entry) => entry.names), ['Харківській']);
  assert.equal(wordAt('Харківськ', '2026-11-04T12:00:00Z').active, true);
});

test('an order that names no oblast, the explainer, the plan for tomorrow and «у цих регіонах» say nothing of any oblast', () => {
  // «в окремих регіонах України запроваджені аварійні відключення» (5499, 5603), «у низці регіонів України, зокрема у Києві» (5607),
  // «перевірте, чи діють у вашому регіоні аварійні відключення» (5524), «Завтра … діятимуть планові відключення» (5652), and
  // «без світла залишилися споживачі у Запорізькій та Дніпропетровській областях. У цих регіонах вимушені аварійні відключення» (5642).
  for (const id of [5499, 5524, 5603, 5607, 5642, 5652]) assert.equal(statementOf(post(id).text), null, String(id));
  // And so they leave the word before them standing: the evening post of the 18th does not end the morning's list.
  assert.equal(wordAt('Харківськ', '2026-11-18T18:00:00Z').since, post(5651).postedAt);
});

test('a sentence about later is no word on this hour', () => {
  // Not seen with an oblast named; «Аварійні відключення будуть скасовані, щойно це дозволить стан енергосистеми» closes most orders.
  assert.equal(statementOf('У Полтавській області аварійні відключення будуть скасовані, щойно це дозволить стан енергосистеми.'), null);
  assert.equal(statementOf('Завтра у Полтавській області будуть застосовані графіки аварійних відключень.'), null);
});

test('every oblast with no signal of its own and a table we can read reads Укренерго, by a stem its own title starts with, and the index says so', () => {
  const reading = REGIONS.filter((region) => region.emergencyUkrenergo).map((region) => region.id);
  // Not Вінниця: its table has not been readable since 16 October 2026, and the word is added only to what an adapter read.
  assert.deepEqual(reading, ['odesa', 'mykolaiv', 'lviv', 'kirovohrad', 'rivne', 'volyn', 'ivano-frankivsk', 'ternopil',
    'chernivtsi', 'zakarpattia', 'khmelnytskyi', 'poltava']);
  assert.ok(!('emergencySignal' in indexEntry(regionById('vinnytsia'))));
  for (const id of reading) {
    const region = regionById(id);
    assert.ok(!region.yasno && !region.emergencyTelegram && !region.emergencySite, `${id} has a nearer word`);
    assert.equal(indexEntry(region).emergencySignal, true, id);
    // «Одеса» is titled by its city; ДТЕК serves the oblast under it.
    if (id !== 'odesa') assert.ok(region.title.startsWith(region.emergencyUkrenergo.oblast), id);
    assert.ok(new RegExp(`${region.emergencyUkrenergo.oblast}ій`, 'u').test(`у ${region.emergencyUkrenergo.oblast}ій області`));
  }
  // Every adapter is still an adapter under the wrapper that adds the word.
  for (const source of Object.keys(ADAPTERS)) assert.equal(typeof ADAPTERS[source], 'function', source);
});

test('the wrapper puts today under the warning while the word stands, and takes it off when it does not', async () => {
  const region = regionById('poltava');
  const snapshot = { regionId: 'poltava', fact: { data: {}, update: '19 листопада 2026 06:03' } };
  const posts = (iso) => async ({ oblast, now, maxAgeMs }) =>
    readUkrenergo(POSTS.filter((entry) => Date.parse(entry.postedAt) <= Date.parse(iso)), { oblast, now, maxAgeMs });

  const during = await withUkrenergoEmergency(snapshot, region, { read: posts('2026-11-19T09:08:00Z'), now: at('2026-11-19T09:08:00Z'), log: () => {} });
  assert.deepEqual(during.fact.emergency, [kyivDayStart(at('2026-11-19T09:08:00Z'))]);
  assert.match(during.fact.emergencyNote, /Полтавській.+— Укренерго, 10:39$/u);
  assert.equal(during.fact.update, snapshot.fact.update);

  const before = await withUkrenergoEmergency(snapshot, region, { read: posts('2026-11-19T08:30:00Z'), now: at('2026-11-19T08:30:00Z'), log: () => {} });
  assert.ok(!('emergency' in before.fact) && !('emergencyNote' in before.fact));
});

test('a channel that does not answer leaves phones the warning they have for today, marked as carried', async () => {
  const now = at('2026-11-19T12:00:00Z');
  const today = kyivDayStart(now);
  const failing = async () => { throw new Error('HTTP 503'); };
  const lines = [];
  const region = { ...regionById('poltava'), previous: { fact: { emergency: [today], emergencyNote: '«…» — Укренерго, 10:39' } } };
  const held = await withUkrenergoEmergency({ regionId: 'poltava', fact: { data: {} } }, region, { read: failing, now, log: (line) => lines.push(line) });
  assert.deepEqual(held.fact.emergency, [today]);
  assert.equal(held.fact.emergencyNote, '«…» — Укренерго, 10:39');
  assert.deepEqual(carriedParts(held), ['emergency']);
  assert.deepEqual(lines, ['poltava: channel failed: HTTP 503']);

  // Yesterday's warning is not today's.
  const stale = { ...regionById('poltava'), previous: { fact: { emergency: [today - 86400] } } };
  const dropped = await withUkrenergoEmergency({ regionId: 'poltava', fact: { data: {} } }, stale, { read: failing, now, log: () => {} });
  assert.ok(!('emergency' in dropped.fact));
  assert.equal(carriedParts(dropped), null);
});

test('what the adapter carried over stays marked on the copy, and a region that does not read Укренерго is handed back untouched', async () => {
  const now = at('2026-11-19T09:08:00Z');
  const tomorrow = kyivDayStart(now) + 86400;
  const off = async () => ({ active: false, since: null, note: null });
  const carried = markCarried({ regionId: 'chernivtsi', fact: { data: {} } }, [tomorrow]);
  const result = await withUkrenergoEmergency(carried, regionById('chernivtsi'), { read: off, now, log: () => {} });
  assert.deepEqual(carriedParts(result), [tomorrow]);

  const own = { regionId: 'kharkiv', fact: { data: {}, emergency: [kyivDayStart(now)] } };
  assert.equal(await withUkrenergoEmergency(own, regionById('kharkiv'), { read: off, now, log: () => {} }), own);
  // An operator's own word, should an adapter of these oblasts ever bring one, is not taken off by Укренерго's silence.
  const nearer = { regionId: 'poltava', fact: { data: {}, emergency: [kyivDayStart(now)], emergencyNote: 'у Кременчуцькому районі' } };
  assert.equal(await withUkrenergoEmergency(nearer, regionById('poltava'), { read: off, now, log: () => {} }), nearer);
});
