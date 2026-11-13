import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
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
/** Nothing served and no state kept, unless a test says otherwise: never the real site, never the server's own state file. */
const publish = (options) => publishWeather({ places: one, readServed: async () => null, stateFile: null, ...options });
const fileOf = async (outDir) => JSON.parse(await readFile(join(outDir, 'weather.json'), 'utf8'));
const exists = (path) => stat(path).then(() => true, () => false);

test('a file is written, and asked again only after the half hour', async () => {
  const outDir = await dir();
  const urls = [];
  const read = async (url) => { urls.push(url); return answer(urls.length === 1 ? 6.8 : 9, 'lightrain'); };
  const first = await publish({ outDir, now: NOW, read });
  assert.deepEqual([first.written, first.asked, first.read, first.failed], [true, true, 2, 0]);
  assert.match(urls[0], /lat=50\.45&lon=30\.52$/, 'two decimals: a city, not a street');
  const file = await fileOf(outDir);
  assert.equal(file.updatedAt, NOW.toISOString());
  assert.deepEqual(file.regions.kyiv, { t: 7, sky: 'rain', night: false, at: NOW.toISOString() });

  const soon = await publish({ outDir, now: new Date(NOW.getTime() + RENEW_AFTER_MS - 1000), read });
  assert.deepEqual([soon.written, soon.asked], [false, false], 'the source is not asked more often than it asks to be');
  assert.equal(urls.length, 2);

  const later = await publish({ outDir, now: new Date(NOW.getTime() + RENEW_AFTER_MS), read });
  assert.equal(later.asked, true);
  assert.equal(urls.length, 4);
});

test('a region that cannot be read keeps its last reading for three hours, then goes', async () => {
  const outDir = await dir();
  await publish({ outDir, now: NOW, read: async () => answer(6, 'cloudy') });
  const failing = async (url) => { if (url.includes('lat=46.48')) throw new Error('503'); return answer(8, 'fair'); };

  const soon = new Date(NOW.getTime() + RENEW_AFTER_MS);
  const a = await publish({ outDir, now: soon, read: failing });
  assert.equal(a.failed, 1);
  let file = await fileOf(outDir);
  assert.equal(file.regions.kyiv.t, 8);
  assert.equal(file.regions.odesa.t, 6, 'the last reading of the one that failed');
  assert.equal(file.regions.odesa.at, NOW.toISOString(), 'and it says when that was');

  const late = new Date(NOW.getTime() + KEEP_MS + 1000);
  await publish({ outDir, now: late, read: failing });
  file = await fileOf(outDir);
  assert.equal(file.regions.odesa, undefined, 'older than that it is not the weather any more');
  assert.equal(file.regions.kyiv.t, 8);
});

test('nothing is written when nothing could be read, and what is there stays', async () => {
  const outDir = await dir();
  await writeFile(join(outDir, 'weather.json'), JSON.stringify({ updatedAt: '2026-11-13T10:00:00.000Z', regions: {} }));
  const none = await publish({ outDir, now: NOW, read: async () => { throw new Error('down'); } });
  assert.deepEqual([none.written, none.asked, none.failed], [false, true, 2]);
  assert.equal((await fileOf(outDir)).updatedAt, '2026-11-13T10:00:00.000Z');
});

// The server's tree is cleaned at the start of every cycle (vps/run.sh): the file of the cycle before is never there.

test('a clean tree starts from the served copy: put back as it is, and the source not asked while it is fresh', async () => {
  const outDir = await dir();
  const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
  // Spaces and all: what goes back into the tree is the served bytes, so the deploy has nothing new to upload.
  const served = `{"updatedAt":"${tenMinutesAgo}", "regions":{"kyiv":{"t":6,"sky":"cloudy","night":false,"at":"${tenMinutesAgo}"}}}`;
  let asked = 0;
  const result = await publish({ outDir, now: NOW, readServed: async () => served, read: async () => { asked++; return answer(1, 'fog'); } });
  assert.deepEqual([result.written, result.asked], [false, false]);
  assert.equal(asked, 0, 'renewed ten minutes ago by the cycle before: not asked again');
  assert.equal(await readFile(join(outDir, 'weather.json'), 'utf8'), served, 'in the tree for this cycle\'s deploy, byte for byte');
});

test('a served copy older than half an hour is renewed, and still lends its readings to a region that fails', async () => {
  const outDir = await dir();
  const fortyMinutesAgo = new Date(NOW.getTime() - 40 * 60 * 1000).toISOString();
  const served = JSON.stringify({ updatedAt: fortyMinutesAgo, regions: {
    kyiv: { t: 6, sky: 'cloudy', night: false, at: fortyMinutesAgo }, odesa: { t: 11, sky: 'rain', night: false, at: fortyMinutesAgo }
  } });
  const failing = async (url) => { if (url.includes('lat=46.48')) throw new Error('timeout'); return answer(5, 'fog'); };
  const result = await publish({ outDir, now: NOW, readServed: async () => served, read: failing });
  assert.deepEqual([result.written, result.read, result.failed], [true, 1, 1]);
  const file = await fileOf(outDir);
  assert.equal(file.updatedAt, NOW.toISOString());
  assert.equal(file.regions.kyiv.t, 5);
  assert.deepEqual(file.regions.odesa, { t: 11, sky: 'rain', night: false, at: fortyMinutesAgo });
});

test('a served copy that cannot be read is not «nothing served»: the source is not asked on a guess', async () => {
  const outDir = await dir();
  let asked = 0;
  const result = await publish({
    outDir, now: NOW, readServed: async () => { throw new Error('HTTP 503'); }, read: async () => { asked++; return answer(1, 'fog'); }
  });
  assert.deepEqual([result.written, result.asked], [false, false]);
  assert.equal(asked, 0);
  assert.equal(await exists(join(outDir, 'weather.json')), false);
});

test('a served copy that is not JSON is replaced by a reading', async () => {
  const outDir = await dir();
  const result = await publish({ outDir, now: NOW, readServed: async () => '<html>oops</html>', read: async () => answer(2, 'snow') });
  assert.equal(result.written, true);
  assert.equal((await fileOf(outDir)).regions.kyiv.t, 2);
});

test('a source that does not answer is asked once in half an hour all the same', async () => {
  const stateFile = join(await dir(), 'asked-at');
  let asked = 0;
  const down = async () => { asked++; throw new Error('429'); };
  // Three cycles, each from a clean tree with nothing served yet.
  const first = await publish({ outDir: await dir(), now: NOW, read: down, stateFile });
  assert.deepEqual([first.asked, first.written, first.failed], [true, false, 2]);
  assert.equal(asked, 2);

  const twoMinutesOn = await publish({ outDir: await dir(), now: new Date(NOW.getTime() + 2 * 60 * 1000), read: down, stateFile });
  assert.equal(twoMinutesOn.asked, false, 'the next cycle does not try again');
  assert.equal(asked, 2);

  const halfAnHourOn = await publish({ outDir: await dir(), now: new Date(NOW.getTime() + RENEW_AFTER_MS), read: down, stateFile });
  assert.equal(halfAnHourOn.asked, true);
  assert.equal(asked, 4);
});

test('without a state file the file\'s own stamp is the only clock', async () => {
  const outDir = await dir();
  let asked = 0;
  const read = async () => { asked++; return answer(3, 'cloudy'); };
  await publish({ outDir, now: NOW, read });
  await publish({ outDir, now: new Date(NOW.getTime() + 60 * 1000), read });
  assert.equal(asked, 2, 'two places, once');
});
