// Rebuilds tools/mirror/sources/sumy-model.json from the transcribed pictures.
//
//   node tools/ocr/sumy/fetch-pictures.mjs <dir>     # the pictures, by post id, from t.me/s
//   node tools/ocr/sumy/build-model.mjs <dir>
//
// Every digit of every card in ground-truth.json (80 pictures, two independent readers who agreed
// on all 2 801 cards) is cut out the way the reader cuts it and labelled from the transcription;
// a digit's template is the mean of its samples per design, after dropping the samples that do
// not look like their own class (badly cut). The duration line's hours digit is labelled from the
// window's length and kept with the range of widths it may have.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJpeg } from '../../mirror/lib/jpeg.mjs';
import {
  analyse, labelRuns, rowsFromLabels, cardLines, inkGrid, splitTimeLine, splitPair, normalise, ncc,
  durationHoursBoxes, DURATION_INK
} from '../../mirror/lib/sumy-picture.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: build-model.mjs <pictures dir>');
const QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const truth = JSON.parse(readFileSync(new URL('./ground-truth.json', import.meta.url), 'utf8'));
const minutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

const digits = [];
const durations = [];
for (const [file, picture] of Object.entries(truth)) {
  const image = decodeJpeg(readFileSync(join(dir, file)));
  const a = analyse(image);
  if (rowsFromLabels(labelRuns(image, a), a.chips).error) continue;
  const theme = a.dark ? 'dark' : 'light';
  QUEUES.forEach((queue, row) => {
    a.chips.filter((c) => c.row === row).sort((p, q) => p.x0 - q.x0).forEach((card, k) => {
      const window = picture.rows[queue][k];
      if (!window) return;
      const { bg, bands } = cardLines(a.lm, card);
      if (bands.length < 2) return;
      const grid = inkGrid(a.lm, bg, card.x0 + 3, bands[0].y0 - 1, card.x1 - 3, bands[0].y1 + 1);
      const split = splitTimeLine(grid);
      if (!split.error) {
        const labels = window.replace(/[-:]/g, '');
        split.groups.forEach((g, gi) => splitPair(grid, g).forEach((box, di) => {
          const n = normalise(grid, box);
          if (n) digits.push({ theme, label: labels[gi * 2 + di], vec: [...n.vec] });
        }));
      }
      const [start, end] = window.split('-').map(minutes);
      const hours = String(Math.floor(((end || 1440) - start) / 60));
      const dgrid = inkGrid(a.lm, bg, card.x0 + 3, bands[1].y0 - 1, card.x1 - 3, bands[1].y1 + 1);
      const boxes = durationHoursBoxes(dgrid);
      if (boxes?.length === hours.length) boxes.forEach((b, i) => {
        const n = normalise(dgrid, b, DURATION_INK);
        if (n) durations.push({ label: hours[i], vec: [...n.vec], aspect: n.aspect });
      });
    });
  });
}

const mean = (vecs) => vecs[0].map((_, j) => vecs.reduce((s, v) => s + v[j], 0) / vecs.length);
const round = (vec) => vec.map((x) => +x.toFixed(4));
const model = { note: JSON.parse(readFileSync(new URL('../../mirror/sources/sumy-model.json', import.meta.url), 'utf8')).note, digits: {}, duration: {} };
for (const theme of ['dark', 'light']) {
  model.digits[theme] = {};
  const by = {};
  for (const s of digits) if (s.theme === theme) (by[s.label] ??= []).push(s.vec);
  for (const [label, all] of Object.entries(by)) {
    const kept = all.filter((v) => ncc(v, mean(all)) >= 0.8);
    if (kept.length) model.digits[theme][label] = [round(mean(kept))];
  }
}
const byDuration = {};
for (const s of durations) (byDuration[s.label] ??= []).push(s);
for (const [label, all] of Object.entries(byDuration)) {
  const centre = mean(all.map((s) => s.vec));
  const kept = all.filter((s) => ncc(s.vec, centre) >= 0.75);
  const widths = kept.map((s) => s.aspect).sort((p, q) => p - q);
  const lo = widths[Math.floor(0.02 * (widths.length - 1))], hi = widths[Math.ceil(0.98 * (widths.length - 1))];
  model.duration[label] = { vec: round(mean(kept.map((s) => s.vec))), aspect: [+(lo - 0.05).toFixed(2), +(hi + 0.05).toFixed(2)] };
}
writeFileSync(new URL('../../mirror/sources/sumy-model.json', import.meta.url), JSON.stringify(model));
console.log(`digit samples ${digits.length}, duration samples ${durations.length}`);
