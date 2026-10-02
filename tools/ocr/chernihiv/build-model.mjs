// Rebuilds tools/mirror/sources/chernihiv-model.json from the transcribed tile pictures.
//
//   node tools/ocr/chernihiv/build-model.mjs <pictures dir>
//
// The pictures are the posts named in ground-truth.json (t.me/chernigivoblenergo/<id>), fetched
// the way tools/ocr/sumy/fetch-pictures.mjs fetches Сумиобленерго's. Every digit of every window
// the reader can cut is labelled from the transcription; the samples kept are those a condensed
// nearest neighbour needs (each one the kept set misread or only narrowly read right).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJpeg } from '../../mirror/lib/jpeg.mjs';
import { tileLayout, digitBoxes, normalise2, lineVec } from '../../mirror/lib/chernihiv-picture.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: build-model.mjs <pictures dir>');
const truth = JSON.parse(readFileSync(new URL('./ground-truth.json', import.meta.url), 'utf8'));
const digits = [];
const messages = [[], []];
for (const [file, picture] of Object.entries(truth)) {
  const layout = tileLayout(decodeJpeg(readFileSync(join(dir, file))));
  if (layout.error) continue;
  for (const tile of layout.tiles) {
    const windows = picture.rows[tile.label] ?? [];
    if (!windows.length) {
      if (tile.lines.length === 2) tile.lines.forEach((line, i) => { const v = lineVec(line.grid); if (v) messages[i].push(v); });
      continue;
    }
    if (windows.length !== tile.lines.length) continue;
    tile.lines.forEach((line, k) => {
      const cut = digitBoxes(line.grid);
      if (cut.error) return;
      const labels = windows[k].replace(/[-:]/g, '');
      cut.digits.forEach((box, i) => digits.push({ label: labels[i], vec: [...normalise2(line.grid, box).vec] }));
    });
  }
}

const unit = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; const c = v.map((x) => x - m); const n = Math.sqrt(c.reduce((a, b) => a + b * b, 0)) || 1; return c.map((x) => x / n); };
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
for (const s of digits) s.p = unit(s.vec);
const kept = [];
for (const s of digits) if (!kept.some((k) => k.label === s.label)) kept.push(s);
for (let pass = 0; pass < 4; pass++) {
  let added = 0;
  for (const s of digits) {
    const best = {};
    for (const k of kept) { const d = dot(s.p, k.p); if (!(k.label in best) || d > best[k.label]) best[k.label] = d; }
    const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
    if (ranked[0][0] !== s.label || ranked[0][1] - (ranked[1]?.[1] ?? -1) < 0.02) { kept.push(s); added++; }
  }
  if (!added) break;
}
const mean = (vs) => vs[0].map((_, j) => vs.reduce((t, v) => t + v[j], 0) / vs.length);
const out = new URL('../../mirror/sources/chernihiv-model.json', import.meta.url);
const model = {
  note: JSON.parse(readFileSync(out, 'utf8')).note,
  digits: kept.map((s) => ({ label: s.label, v: Buffer.from(s.vec.map((x) => Math.max(0, Math.min(255, Math.round(x * 255))))).toString('base64') })),
  messages: messages.map((m) => mean(m).map((x) => +x.toFixed(4)))
};
writeFileSync(out, JSON.stringify(model));
console.log(`digit samples ${digits.length}, kept ${kept.length}; message lines ${messages.map((m) => m.length).join(' / ')}`);
