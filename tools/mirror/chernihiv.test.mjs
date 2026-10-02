import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readChernihivPicture, loadDigits } from './lib/chernihiv-picture.mjs';
import { parseLine, parseAmendment } from './lib/chernihiv-amendments.mjs';
import { scheduleDay, fetchRegion } from './sources/chernihiv.mjs';
import { kyivDayStart } from './lib/canonical.mjs';

// Pictures and captions as @chernigivoblenergo posted them: the colour grid of October 2025 –
// March 2026, the tile table since February 2026, and the stock banner amendments ride under.
const fixture = (name) => readFileSync(new URL(`./${name}`, import.meta.url));
const MODEL = JSON.parse(fixture('sources/chernihiv-model.json'));
const DIGITS = loadDigits(MODEL);
const FX = JSON.parse(fixture('chernihiv.fixture.json'));
const QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const spans = (slots, state) => {
  const hhmm = (i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  const out = [];
  for (let i = 0; i < 48; i++) {
    if (slots[i] !== state || slots[i - 1] === state) continue;
    let e = i; while (e < 48 && slots[e] === state) e++;
    out.push(`${hhmm(i)}-${e === 48 ? '24:00' : hhmm(e)}`);
  }
  return out;
};

test('a colour grid: red is off, yellow (switch-over) is possible', () => {
  // 3 жовтня 2025, checked cell for cell by independent readers.
  const { rows, error } = readChernihivPicture(fixture('chernihiv.fixture-grid-4129.jpg'), MODEL, DIGITS);
  assert.equal(error, undefined);
  assert.deepEqual(spans(rows[0], 'off'), ['00:00-04:00', '08:30-14:30', '19:00-24:00']);
  assert.deepEqual(spans(rows[0], 'possible'), ['04:00-04:30', '08:00-08:30', '14:30-15:00', '18:30-19:00']);
  assert.deepEqual(spans(rows[8], 'off'), ['00:00-00:30', '05:00-11:00', '15:30-21:30']);
});

test('a tile table reads window for window as transcribed', () => {
  const { rows, error } = readChernihivPicture(fixture('chernihiv.fixture-tiles-5260.jpg'), MODEL, DIGITS);
  assert.equal(error, undefined);
  QUEUES.forEach((q, i) => assert.deepEqual(spans(rows[i], 'off'), FX.tiles5260[q].map((w) => w.replace(/-00:00$/, '-24:00')), q));
});

test('a tile table it is not sure of is refused, and a banner is no table at all', () => {
  const tiles = readChernihivPicture(fixture('chernihiv.fixture-tiles-5013.jpg'), MODEL, DIGITS);
  assert.ok(tiles.error);
  assert.equal(tiles.notTable, undefined);
  const banner = readChernihivPicture(fixture('chernihiv.fixture-banner.jpg'), MODEL, DIGITS);
  assert.ok(banner.notTable);
});

test('amendment lines: windows, extensions from the post, and open starts as possible', () => {
  const at20 = 40;
  assert.deepEqual(parseLine('🕗 З 22:00 до 24:00 додатково відключається черга 5/1.', at20), [{ key: 'GPV5.1', from: 44, to: 48, state: 'off' }]);
  assert.deepEqual(parseLine('🕗 Черга 1/1 – 21:30-24:00.', at20), [{ key: 'GPV1.1', from: 43, to: 48, state: 'off' }]);
  assert.deepEqual(parseLine('🕗 До 21:00 продовжуються відключення для черг 1/1 та 1/2.', at20), [
    { key: 'GPV1.1', from: 40, to: 42, state: 'off' }, { key: 'GPV1.2', from: 40, to: 42, state: 'off' }
  ]);
  assert.deepEqual(parseLine('🕗 Відключення у чергах 6/1 і 6/2 подовжується до 17:30.', 30), [
    { key: 'GPV6.1', from: 30, to: 35, state: 'off' }, { key: 'GPV6.2', from: 30, to: 35, state: 'off' }
  ]);
  assert.deepEqual(parseLine('🕗 З 22:00 відключається черга 4/1.', at20), [{ key: 'GPV4.1', from: 44, to: 48, state: 'possible' }]);
  assert.equal(parseLine('📊 За вказівкою НЕК "Укренерго", з 18:00 до 20:00 обсяг обмежень збільшиться на 0,5 черги.', at20), null);
  // A shape it does not know: the черги it names become possible from the post, nothing is guessed.
  const unknown = parseAmendment('🕗 Додаткові відключення у цей період додадуться у черги 2/1.', at20);
  assert.deepEqual(unknown.changes, [{ key: 'GPV2.1', from: 40, to: 48, state: 'possible' }]);
});

test('amendments land on the day\'s table, each from when it was posted', async () => {
  // 15 січня 2026: the table posted the evening before, then two night amendments.
  const post = (id, photo) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="chernigivoblenergo/${id}">` +
    `<a class="tgme_widget_message_photo_wrap" style="width:800px;background-image:url('https://cdn.example/${photo}')"></a>` +
    `<div class="tgme_widget_message_text js-message_text">${FX.captions[id].replace(/\n/g, '<br/>')}</div>` +
    `<time datetime="${FX.postedAt[id]}"></time></div></div>`;
  const html = post(4588, 'grid') + post(4590, 'banner') + post(4591, 'banner');
  const files = { 'https://cdn.example/grid': 'chernihiv.fixture-grid-4588.jpg', 'https://cdn.example/banner': 'chernihiv.fixture-banner.jpg' };
  const snapshot = await fetchRegion({ id: 'chernihiv', title: 'Чернігівська область' }, {
    now: new Date('2026-01-14T22:30:00Z'), spacing: 0, fetchPage: async () => html, fetchImage: async (url) => fixture(files[url])
  });
  const day = snapshot.fact.data[kyivDayStart(new Date('2026-01-15T12:00:00Z'))];
  // "З 03:00 до 04:00 додатково відключається черга 3/2" and "З 02:00 до 04:00 … черга 6/2".
  assert.equal(day['GPV3.2']['4'], 'no');
  assert.equal(day['GPV6.2']['3'], 'no');
  assert.equal(day['GPV6.2']['4'], 'no');
  // "З 00:00 до 00:30 додатково відключається черга 1/2".
  assert.ok(['no', 'first'].includes(day['GPV1.2']['1']));
});

test('the day comes from the caption, or the day an undated amendment went out', () => {
  const day = (text, postedAt) => scheduleDay({ id: 1, postedAt, text })?.epoch;
  assert.equal(day(FX.captions['4588'], FX.postedAt['4588']), kyivDayStart(new Date('2026-01-15T12:00:00Z')));
  assert.equal(day('🕗 З 22:00 відключається черга 4/1.', '2026-01-14T19:30:00Z'), kyivDayStart(new Date('2026-01-14T12:00:00Z')));
  assert.equal(day('Шановні споживачі! Дякуємо за розуміння.', '2026-01-14T19:30:00Z'), undefined);
});
