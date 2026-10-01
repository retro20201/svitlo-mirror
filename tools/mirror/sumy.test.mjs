import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeJpeg } from './lib/jpeg.mjs';
import { readPicture, readSchedulePicture, analyse } from './lib/sumy-picture.mjs';
import { scheduleDay, halvesFromRows, fetchRegion } from './sources/sumy.mjs';
import { kyivDayStart } from './lib/canonical.mjs';

// Pictures as Сумиобленерго posted them: 2594 in the light design of November 2025, 2985 and
// 3516 in the dark one (a full day and a sparse July one), 2603 one whose rows the reader cannot
// place. The transcriptions are two independent readers' who agreed on every card.
const fixture = (name) => readFileSync(new URL(`./${name}`, import.meta.url));
const MODEL = JSON.parse(fixture('sources/sumy-model.json'));
const TRUTH = JSON.parse(fixture('sumy.fixture.json')).pictures;
const QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const asText = (rows) => Object.fromEntries(QUEUES.map((q, i) => [q, rows[i].map((w) => `${hhmm(w.start)}-${hhmm(w.end)}`)]));

for (const id of ['2594', '2985', '3516']) {
  test(`picture ${id} reads card for card as transcribed`, () => {
    const result = readSchedulePicture(fixture(`sumy.fixture-${id}.jpg`), MODEL);
    assert.equal(result.error, undefined);
    assert.deepEqual(asText(result.rows), TRUTH[id].rows);
  });
}

test('a picture whose rows cannot be placed is refused, not guessed', () => {
  assert.match(readSchedulePicture(fixture('sumy.fixture-2603.jpg'), MODEL).error, /rows/);
});

test('a card the reader does not recognise as one refuses the picture', () => {
  // The same day with one card repainted orange: it is no longer found as a card, and a window
  // silently missing is exactly what must not happen.
  const image = decodeJpeg(fixture('sumy.fixture-2985.jpg'));
  const card = analyse(image).chips[7];
  const repainted = {
    ...image,
    pixel(x, y) {
      const p = image.pixel(x, y);
      return x >= card.x0 && x <= card.x1 && y >= card.y0 && y <= card.y1 && p[0] > 200 ? [255, 160, 40] : p;
    }
  };
  assert.match(readPicture(repainted, { P: MODEL.digits, DP: MODEL.duration }).error, /unread/);
});

test('a picture with no cards at all is refused rather than read as a quiet day', () => {
  const white = { width: 300, height: 400, pixel: () => [255, 255, 255] };
  assert.match(readPicture(white, { P: MODEL.digits, DP: MODEL.duration }).error, /no cards/);
});

test('windows become off half-hours of their subqueue', () => {
  const rows = QUEUES.map(() => []);
  rows[0] = [{ start: 9 * 60 + 30, end: 10 * 60 }, { start: 22 * 60, end: 1440 }];
  const halves = halvesFromRows(rows);
  assert.deepEqual(halves['GPV1.1'].map((s, i) => (s === 'off' ? i : null)).filter((i) => i !== null), [19, 44, 45, 46, 47]);
  assert.ok(halves['GPV6.2'].every((s) => s === 'on'));
});

test('the day comes from the caption, and an undated update only before evening', () => {
  const kyivDay = (iso) => kyivDayStart(new Date(`${iso}T12:00:00Z`));
  const post = (text, postedAt) => ({ id: 1, postedAt, text });
  assert.equal(scheduleDay(post('Завтра, 21 січня, діятимуть графіки погодинних відключень.', '2026-01-20T18:29:20+00:00')).epoch, kyivDay('2026-01-21'));
  assert.equal(scheduleDay(post('Командою НЕК "Укренерго" внесено зміни в обсяг застосування графіків погодинних відключень на 30-06-2026.', '2026-06-30T13:27:00+00:00')).epoch, kyivDay('2026-06-30'));
  // "Маємо оновлення в застосуванні ГПВ" names no day: 15:57 in Kyiv is that day…
  assert.equal(scheduleDay(post('Маємо оновлення в застосуванні ГПВ на Сумщині.', '2025-11-29T13:57:00+00:00')).epoch, kyivDay('2025-11-29'));
  // …20:30 might already be about tomorrow, so it is not filed at all.
  assert.equal(scheduleDay(post('Маємо оновлення в застосуванні ГПВ на Сумщині.', '2025-11-29T18:30:00+00:00')), null);
  assert.equal(scheduleDay(post('Негода на Сумщині спричинила відключення.', '2026-08-19T08:08:00+00:00')), null);
});

/** A preview page with photo posts, shaped as t.me/s serves it. */
const page = (posts) => posts.map(({ id, at, text, photo }) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="SumyEnergo/${id}">` +
  `<a class="tgme_widget_message_photo_wrap" href="https://t.me/SumyEnergo/${id}" style="width:460px;background-image:url('${photo}')"></a>` +
  `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>` +
  `<div class="tgme_widget_message_footer"><time datetime="${at}" class="time">x</time></div></div></div>`).join('');

test('the newest picture of a day decides: read, it is hours; unreadable, it is the picture', async () => {
  const now = new Date('2026-01-21T08:00:00Z');
  const html = page([
    { id: 2980, at: '2026-01-20T18:29:20+00:00', text: 'Завтра, 21 січня, діятимуть графіки погодинних відключень.', photo: 'https://cdn.example/2985.jpg' },
    { id: 2990, at: '2026-01-21T07:30:00+00:00', text: 'Командою НЕК "Укренерго" внесено зміни в обсяг застосування графіків погодинних відключень на 22 січня.', photo: 'https://cdn.example/2603.jpg' }
  ]);
  const files = { 'https://cdn.example/2985.jpg': 'sumy.fixture-2985.jpg', 'https://cdn.example/2603.jpg': 'sumy.fixture-2603.jpg' };
  const snapshot = await fetchRegion({ id: 'sumy', title: 'Сумська область' }, {
    now, spacing: 0, fetchPage: async () => html, fetchImage: async (url) => fixture(files[url])
  });
  const jan21 = kyivDayStart(new Date('2026-01-21T12:00:00Z'));
  const jan22 = kyivDayStart(new Date('2026-01-22T12:00:00Z'));
  assert.deepEqual(Object.keys(snapshot.fact.data).map(Number), [jan21]);
  assert.equal(snapshot.fact.data[jan21]['GPV1.1']['1'], 'no');
  assert.deepEqual(snapshot.sheets.map((s) => s.dayStart), [jan22]);
  assert.equal(snapshot.sheets[0].sourceUrl, 'https://t.me/SumyEnergo/2990');
});
