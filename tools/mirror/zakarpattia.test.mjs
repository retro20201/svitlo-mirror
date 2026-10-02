import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeJpeg } from './lib/jpeg.mjs';
import { readGrid, readZakarpattiaPicture } from './lib/zakarpattia-picture.mjs';
import { scheduleDay, fetchRegion } from './sources/zakarpattia.mjs';
import { kyivDayStart } from './lib/canonical.mjs';

// Pictures as @zakarpatenergyofficial posted them (Telegram serves them 800 px wide): 17.01.2026,
// a heavy day; 01.07.2026, outages only in the evening; 30.10.2025, the first of the season.
const fixture = (name) => readFileSync(new URL(`./${name}`, import.meta.url));
const ORIGINAL = JSON.parse(fixture('zakarpattia.fixture.json'));
const pattern = (rows) => rows.map((slots) => slots.map((s) => (s === 'off' ? '#' : '.')).join(''));
const windows = (slots) => {
  const out = [];
  const hhmm = (i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  for (let i = 0; i < 48; i++) {
    if (slots[i] !== 'off' || slots[i - 1] === 'off') continue;
    let e = i; while (e < 48 && slots[e] === 'off') e++;
    out.push(`${hhmm(i)}-${e === 48 ? '24:00' : hhmm(e)}`);
  }
  return out;
};

test('a heavy day reads cell for cell as its full-size original', () => {
  const result = readZakarpattiaPicture(fixture('zakarpattia.fixture-9496.jpg'));
  assert.equal(result.error, undefined);
  assert.deepEqual(pattern(result.rows), ORIGINAL['9496']);
});

test('an evening-only day: filled is off, and nothing else is', () => {
  // 1 липня 2026: Укренерго applied schedules 17:00–22:00 only.
  const { rows } = readZakarpattiaPicture(fixture('zakarpattia.fixture-10440.jpg'));
  assert.deepEqual(windows(rows[0]), ['17:00-18:30']);
  assert.deepEqual(windows(rows[2]), ['18:30-20:00']);
  assert.deepEqual(windows(rows[8]), ['20:00-22:00']);
  assert.deepEqual(windows(rows[11]), ['20:00-22:00']);
  assert.deepEqual(windows(rows[3]), []);
});

test('a half-filled hour is its half-hour', () => {
  // 30 жовтня 2025: 4-1 and 4-2 are off 08:00–08:30 only — the left half of the 08:00 cell.
  const { rows } = readZakarpattiaPicture(fixture('zakarpattia.fixture-8792.jpg'));
  assert.deepEqual(windows(rows[6]), ['08:00-08:30']);
  assert.deepEqual(windows(rows[7]), ['08:00-08:30']);
  assert.deepEqual(windows(rows[0]), ['14:00-17:00']);
});

test('a cell that is neither white nor its row\'s colour refuses the picture', () => {
  const image = decodeJpeg(fixture('zakarpattia.fixture-10440.jpg'));
  // Paint the middle of 1-1's 12:00 cell grey: not white, not yellow.
  const painted = { ...image, pixel: (x, y) => (x >= 430 && x <= 445 && y >= 52 && y <= 58 ? [150, 150, 150] : image.pixel(x, y)) };
  assert.match(readGrid(painted).error, /neither white nor the row's colour/);
});

test('the day is the one the caption names', () => {
  const day = scheduleDay({ id: 1, postedAt: '2025-12-23T21:01:00+00:00', text: 'Увага! Змінено графік погодинних включень/відключень електроенергії ГПВ на 24.12.2025 згідно з розпорядженням НЕК «Укренерго».' });
  assert.equal(day.epoch, kyivDayStart(new Date('2025-12-24T12:00:00Z')));
  assert.equal(scheduleDay({ id: 2, postedAt: '2025-12-24T08:42:00+00:00', text: 'Укренерго про ситуацію в енергосистемі України на сьогодні, 24 грудня' }), null);
});

test('a posted grid becomes the day\'s hours', async () => {
  const html = `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="zakarpatenergyofficial/10440">` +
    `<a class="tgme_widget_message_photo_wrap" style="width:800px;background-image:url('https://cdn.example/10440.jpg')"></a>` +
    `<div class="tgme_widget_message_text js-message_text">До уваги споживачів графік погодинних включень/відключень електроенергії на 01.07.2026</div>` +
    `<time datetime="2026-06-30T17:08:00+00:00"></time></div></div>`;
  const snapshot = await fetchRegion({ id: 'zakarpattia', title: 'Закарпатська область' }, {
    now: new Date('2026-07-01T09:00:00Z'), spacing: 0,
    fetchPage: async () => html, fetchImage: async () => fixture('zakarpattia.fixture-10440.jpg')
  });
  const day = kyivDayStart(new Date('2026-07-01T12:00:00Z'));
  assert.equal(snapshot.fact.data[day]['GPV1.1']['18'], 'no');
  assert.equal(snapshot.fact.data[day]['GPV1.1']['19'], 'first');
  assert.equal(snapshot.fact.data[day]['GPV2.2']['19'], 'yes');
  assert.equal(snapshot.sheets, undefined);
});
