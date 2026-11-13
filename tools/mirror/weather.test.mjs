import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP_MS, PLACES, RENEW_AFTER_MS, publishWeather, readingOf, skyOf } from './lib/weather.mjs';
import { REGIONS } from './regions.mjs';

const NOW = new Date('2026-11-13T19:00:00Z');

/** What api.met.no answered for Kyiv on the evening of 13 November 2026 (cut to the fields that are read). */
const answer = (temperature, symbol, extra = {}) => ({
  properties: { timeseries: [{ time: '2026-11-13T18:00:00Z', data: { instant: { details: { air_temperature: temperature } }, next_1_hours: { summary: { symbol_code: symbol } }, ...extra } }] }
});

test('the symbol codes of the source come out as one of eight skies, and night', () => {
  assert.deepEqual(skyOf('lightrain'), { sky: 'rain', night: false });
  assert.deepEqual(skyOf('partlycloudy_night'), { sky: 'partly', night: true });
  assert.deepEqual(skyOf('clearsky_day'), { sky: 'clear', night: false });
  assert.deepEqual(skyOf('fair_night'), { sky: 'clear', night: true });
  assert.deepEqual(skyOf('heavysleetshowersandthunder_day'), { sky: 'thunder', night: false }, 'thunder before the rest');
  assert.deepEqual(skyOf('lightsnowshowers_night'), { sky: 'snow', night: true });
  assert.deepEqual(skyOf('rainshowers_day'), { sky: 'rain', night: false });
  assert.deepEqual(skyOf('fog'), { sky: 'fog', night: false });
  assert.deepEqual(skyOf('cloudy'), { sky: 'cloudy', night: false });
  assert.equal(skyOf('something-new'), null, 'a symbol this does not know is not guessed at');
  assert.equal(skyOf(undefined), null);
});

test('the reading is the whole degrees and the sky of the hour', () => {
  assert.deepEqual(readingOf(answer(6.8, 'lightrain'), { now: NOW }), { t: 7, sky: 'rain', night: false });
  assert.deepEqual(readingOf(answer(-0.4, 'cloudy'), { now: NOW }), { t: 0, sky: 'cloudy', night: false }, 'not -0');
  assert.deepEqual(readingOf(answer(-5.5, 'snow'), { now: NOW }), { t: -5, sky: 'snow', night: false });
  // The sky may be only in the six-hour block.
  const sixHours = { properties: { timeseries: [{ time: '2026-11-13T18:00:00Z', data: { instant: { details: { air_temperature: 3 } }, next_6_hours: { summary: { symbol_code: 'fog' } } } }] } };
  assert.deepEqual(readingOf(sixHours, { now: NOW }), { t: 3, sky: 'fog', night: false });
  assert.equal(readingOf({}, { now: NOW }), null);
  assert.equal(readingOf(answer('warm', 'cloudy'), { now: NOW }), null);
  assert.equal(readingOf(answer(5, 'unknown_symbol'), { now: NOW }), null);
});

test('every region the app can show has a city, but the occupied ones', () => {
  const sourced = REGIONS.filter((region) => region.source).map((region) => region.id);
  for (const id of sourced) assert.ok(PLACES[id], `${id} has no place for the weather`);
  for (const id of ['luhansk', 'crimea', 'donetsk']) assert.equal(PLACES[id], undefined);
  for (const [lat, lon] of Object.values(PLACES)) {
    assert.ok(lat > 44 && lat < 53 && lon > 22 && lon < 41, `${lat},${lon} is not in Ukraine`);
  }
});

const one = { kyiv: PLACES.kyiv, odesa: PLACES.odesa };
const dir = () => mkdtemp(join(tmpdir(), 'weather-'));

test('a file is written, and asked again only after the half hour', async () => {
  const outDir = await dir();
  const urls = [];
  const read = async (url) => { urls.push(url); return answer(urls.length === 1 ? 6.8 : 9, 'lightrain'); };
  const first = await publishWeather({ outDir, now: NOW, places: one, read });
  assert.deepEqual([first.written, first.asked, first.read, first.failed], [true, true, 2, 0]);
  assert.match(urls[0], /lat=50\.45&lon=30\.52$/, 'two decimals: a city, not a street');
  const file = JSON.parse(await readFile(join(outDir, 'weather.json'), 'utf8'));
  assert.equal(file.updatedAt, NOW.toISOString());
  assert.deepEqual(file.regions.kyiv, { t: 7, sky: 'rain', night: false, at: NOW.toISOString() });

  const soon = await publishWeather({ outDir, now: new Date(NOW.getTime() + RENEW_AFTER_MS - 1000), places: one, read });
  assert.deepEqual([soon.written, soon.asked], [false, false], 'the source is not asked more often than it asks to be');
  assert.equal(urls.length, 2);

  const later = await publishWeather({ outDir, now: new Date(NOW.getTime() + RENEW_AFTER_MS), places: one, read });
  assert.equal(later.asked, true);
  assert.equal(urls.length, 4);
});

test('a region that cannot be read keeps its last reading for three hours, then goes', async () => {
  const outDir = await dir();
  await publishWeather({ outDir, now: NOW, places: one, read: async () => answer(6, 'cloudy') });
  const failing = async (url) => { if (url.includes('lat=46.48')) throw new Error('503'); return answer(8, 'fair'); };

  const soon = new Date(NOW.getTime() + RENEW_AFTER_MS);
  const a = await publishWeather({ outDir, now: soon, places: one, read: failing });
  assert.equal(a.failed, 1);
  let file = JSON.parse(await readFile(join(outDir, 'weather.json'), 'utf8'));
  assert.equal(file.regions.kyiv.t, 8);
  assert.equal(file.regions.odesa.t, 6, 'the last reading of the one that failed');
  assert.equal(file.regions.odesa.at, NOW.toISOString(), 'and it says when that was');

  const late = new Date(NOW.getTime() + KEEP_MS + 1000);
  await publishWeather({ outDir, now: late, places: one, read: failing });
  file = JSON.parse(await readFile(join(outDir, 'weather.json'), 'utf8'));
  assert.equal(file.regions.odesa, undefined, 'older than that it is not the weather any more');
  assert.equal(file.regions.kyiv.t, 8);
});

test('nothing is written when nothing could be read, and what is there stays', async () => {
  const outDir = await dir();
  await writeFile(join(outDir, 'weather.json'), JSON.stringify({ updatedAt: '2026-11-13T10:00:00.000Z', regions: {} }));
  const none = await publishWeather({ outDir, now: NOW, places: one, read: async () => { throw new Error('down'); } });
  assert.deepEqual([none.written, none.asked, none.failed], [false, true, 2]);
  const file = JSON.parse(await readFile(join(outDir, 'weather.json'), 'utf8'));
  assert.equal(file.updatedAt, '2026-11-13T10:00:00.000Z');
});
