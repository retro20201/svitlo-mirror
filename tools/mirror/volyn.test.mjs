import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { halvesFromPicture, hoursFromHalves, archiveEntry } from './sources/volyn.mjs';
import { kyivDayStart } from './lib/canonical.mjs';

// Pictures as Волиньобленерго published them (api-voe-poweron.inneti.net archive): 3 грудня 2025
// in the 1920-px layout with outages, 2 липня 2026 in the 1750-px layout with none.
const fixture = (name) => readFileSync(new URL(`./${name}`, import.meta.url));
const DECEMBER = fixture('volyn.fixture-2025-12-03.png');
const JULY = fixture('volyn.fixture-2026-07-02.png');
const ARCHIVE = JSON.parse(fixture('volyn.fixture-archive.json'));

const offHours = (hours) => Object.fromEntries(Object.entries(hours).filter(([, state]) => state !== 'yes'));

test('the December picture reads cell for cell as drawn', () => {
  const halves = halvesFromPicture(DECEMBER);
  const row = (queue) => halves[queue].map((state) => (state === 'off' ? '#' : '.')).join('');
  // Checked against the picture itself: 1.1 dark 08:00–09:00 and 15:00–16:00, 6.2 16:00–17:30
  // and 23:00–24:00.
  assert.equal(row('GPV1.1'), '................##............##................');
  assert.equal(row('GPV3.1'), '....................##.................#######..');
  assert.equal(row('GPV6.2'), '................................###...........##');
  assert.equal(row('GPV5.1'), '.'.repeat(48));
});

test('half-hour edges keep their own code', () => {
  const hours = hoursFromHalves(halvesFromPicture(DECEMBER));
  assert.deepEqual(offHours(hours['GPV3.1']), { 11: 'no', 20: 'second', 21: 'no', 22: 'no', 23: 'no' });
  assert.deepEqual(offHours(hours['GPV6.2']), { 17: 'no', 18: 'first', 24: 'no' });
  assert.deepEqual(offHours(hours['GPV5.2']), {});
});

test('the narrower layout reads too, and a picture without a dark cell is no schedule', () => {
  const halves = halvesFromPicture(JULY);
  assert.equal(Object.keys(halves).length, 12);
  assert.equal(hoursFromHalves(halves), null);
});

test('a picture that is not the grid throws, so the adapter publishes the picture instead', () => {
  assert.throws(() => halvesFromPicture(blankPng(400, 120)), /found 0 grids/);
  assert.throws(() => halvesFromPicture(Buffer.from('not a png')), /not a PNG/);
});

test('a published file is dated by the archive, as Kyiv wall-clock digits', () => {
  const path = ARCHIVE['hydra:member'][0].imageUrl.contentUrl;
  const entry = archiveEntry(ARCHIVE, path);
  assert.equal(entry.dateGraph.slice(0, 10), '2026-07-02');
  assert.equal(kyivDayStart(new Date(Date.UTC(2026, 6, 2, 12))), 1782939600);
  assert.equal(archiveEntry(ARCHIVE, '/media/none.png'), null);
});

/** A white RGB PNG, for the shape of a picture the grid reader must refuse. */
function blankPng(width, height) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    return out; // the reader does not check CRCs
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (width * 3 + 1), 255);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))
  ]);
}
