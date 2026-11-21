// The reader as it is now against the transcribed pictures: how many read card for card, how many are
// refused, and how many read WRONGLY — which must be none before any change to the reader is merged.
//
//   node tools/ocr/sumy/fetch-pictures.mjs <dir>     # the pictures, by post id, from t.me/s (about four minutes)
//   node tools/ocr/sumy/check.mjs <dir>
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readSchedulePicture } from '../../mirror/lib/sumy-picture.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: check.mjs <pictures dir>');
const QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const truth = JSON.parse(readFileSync(new URL('./ground-truth.json', import.meta.url), 'utf8'));
const model = JSON.parse(readFileSync(new URL('../../mirror/sources/sumy-model.json', import.meta.url), 'utf8'));

// «22:00-00:00» ends at midnight: 1440, as the reader gives it.
const minutes = (time, isEnd) => { const [h, m] = time.split(':').map(Number); return isEnd && h * 60 + m === 0 ? 1440 : h * 60 + m; };
const transcribed = (picture) => QUEUES.map((queue) => (picture.rows[queue] ?? []).map((window) => {
  const [start, end] = window.split('-');
  return `${minutes(start, false)}-${minutes(end, true)}`;
}).join(',')).join('|');
const read = (rows) => rows.map((row) => row.map(({ start, end }) => `${start}-${end}`).join(',')).join('|');

const files = Object.keys(truth).filter((file) => existsSync(join(dir, file)));
const refused = [];
const wrong = [];
let exact = 0;
for (const file of files) {
  const result = readSchedulePicture(readFileSync(join(dir, file)), model);
  if (result.error) refused.push(`${file}: ${result.error}`);
  else if (read(result.rows) === transcribed(truth[file])) exact++;
  else wrong.push(file);
}
console.log(`${files.length} of ${Object.keys(truth).length} transcribed pictures on disk: ${exact} read card for card, ${refused.length} refused, ${wrong.length} read WRONGLY`);
if (process.argv.includes('--refused')) for (const line of refused) console.log(`  refused ${line}`);
for (const file of wrong) console.log(`  WRONG ${file}`);
process.exitCode = wrong.length ? 1 : 0;
