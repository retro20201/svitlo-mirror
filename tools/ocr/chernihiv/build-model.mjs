// Rebuilds tools/mirror/sources/chernihiv-model.json from the transcribed tile pictures.
//
//   node tools/ocr/chernihiv/build-model.mjs <pictures dir>
//
// The pictures are the posts named in ground-truth.json (t.me/chernigivoblenergo/<id>), saved as <id>.jpg the way
// tools/ocr/sumy/fetch-pictures.mjs saves Сумиобленерго's; each has its windows as they read, queue by queue, and a `weight` of 3 where
// it is of the bolder type the channel has posted since October 2026 (471×800 px, digits that touch each other and the colon).
//
// The model is one network: a hidden layer of 64 ReLU units over a digit's 16×20 canvas, to the ten digits and an eleventh class,
// "not a digit". It is trained on every digit of every window the reader can cut, shifted by up to a pixel as it learns, and on boxes
// cut wrongly from the same lines (moved or resized until they are no longer that digit, or across two neighbours). It reads a box,
// and — because it can tell a digit from half of two — it places the boxes where the ink touches (digitBoxesByRecognition).
// Where the pieces of ink come out as eight digits the boxes are theirs; where not, the eight boxes are put where they look most like
// what the transcription says. That is done twice: the first network places them, and a second is trained on boxes placed by the
// first, so that what it learns from is what it will be shown when it places boxes itself (cross-validated by picture, this took the
// bolder pictures from 15 read right of 22 to all 22).
// Nearest samples were tried first: 99.76 % of digits right on pictures held out, but with margins too thin for a whole picture's
// hundred digits to clear; the network's 1-in-100 margin was 3.9 log-odds where theirs was 1.2.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeJpeg } from '../../mirror/lib/jpeg.mjs';
import { tileLayout, digitBoxes, digitBoxesByRecognition, normalise2, lineVec, loadDigits, scorerOf, networkInput, networkLogits } from '../../mirror/lib/chernihiv-picture.mjs';

const D = 320;
const HIDDEN = 64;

/** Every digit of every transcribed window in `files`, labelled, and the "не прогнозується" lines. */
export function collect(truth, dir, files, standing) {
  const digits = [];
  const negatives = [];
  let seed = 777;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const messages = [[], []];
  let placed = 0, skipped = 0;
  for (const file of files) {
    const picture = truth[file];
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
        const labels = windows[k].replace(/[-:]/g, '');
        let cut = digitBoxes(line.grid);
        if (cut.error) { cut = digitBoxesByRecognition(line.grid, scorerOf(standing), 0.4, labels); if (!cut.error) placed++; }
        if (cut.error) { skipped++; return; }
        cut.digits.forEach((box, i) => {
          const n = normalise2(line.grid, box);
          if (n) digits.push({ label: labels[i], vec: [...n.vec], weight: picture.weight ?? 1 });
        });
        // Boxes the placement is offered and must refuse: windows the placement would try (as wide as three to twelve columns, inked
        // at both edges and as tall as a digit) that are no digit of this line — they overlap none of its eight boxes by half or more —
        // and two neighbours' box where it is narrow enough to be offered.
        const { w, h } = line.grid;
        const inked = (x) => { for (let y = 0; y < h; y++) if (line.grid.g[y * w + x] > 0.4) return true; return false; };
        const rows = (x0, x1) => { let top = h, bottom = -1; for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) if (line.grid.g[y * w + x] > 0.4) { top = Math.min(top, y); bottom = Math.max(bottom, y); } return bottom - top + 1; };
        const tall = Math.max(...cut.digits.map((box) => rows(box.x0, box.x1)));
        const first = cut.digits[0].x0, last = cut.digits.at(-1).x1;
        const overlaps = (x0, x1) => cut.digits.some((box) => Math.max(0, Math.min(x1, box.x1) - Math.max(x0, box.x0) + 1) / (Math.max(x1, box.x1) - Math.min(x0, box.x0) + 1) >= 0.5);
        const offer = (x0, x1) => {
          if (x1 - x0 < 2 || x0 < 0 || x1 >= w) return;
          const n = normalise2(line.grid, { x0, x1 });
          if (n) negatives.push({ label: '10', vec: [...n.vec], weight: 1 });
        };
        for (let made = 0, tries = 0; made < 14 && tries < 200; tries++) {
          const a = first - 8 + Math.floor(rnd() * (last - first + 17)), width = 3 + Math.floor(rnd() * 10), b = a + width - 1;
          if (a < 0 || b >= w || !inked(a) || !inked(b) || rows(a, b) < tall * 0.8 || overlaps(a, b)) continue;
          offer(a, b); made++;
        }
        cut.digits.forEach((box, i) => {
          const next = cut.digits[i + 1];
          if (next && next.x1 - box.x0 + 1 <= 12) offer(box.x0, next.x1);
        });
      });
    }
  }
  return { digits, negatives, messages, placed, skipped };
}

/** Shifted by (dx, dy) canvas pixels, the edge filled with the mean (zero). */
function shifted(x, dx, dy) {
  const out = new Float32Array(D);
  for (let j = 0; j < 20; j++) for (let i = 0; i < 16; i++) { const si = i - dx, sj = j - dy; if (si >= 0 && si < 16 && sj >= 0 && sj < 20) out[j * 16 + i] = x[sj * 16 + si]; }
  return out;
}

/**
 * The network: D → 64 ReLU → 10 softmax, minibatch Adam, each digit shifted by up to a pixel in each direction as it is seen. The
 * random numbers are a seeded generator, so the same pictures always make the same model.
 */
export function trainNetwork(digits, { epochs = 30, lr = 0.005, l2 = 1e-4, batch = 128 } = {}) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const rows = digits.map((s) => ({ x: networkInput(s.vec), y: Number(s.label), w: s.weight ?? 1 }));
  const OUT = 11;
  const net = {
    hidden: HIDDEN,
    w1: Float32Array.from({ length: D * HIDDEN }, () => (rnd() - 0.5) * 0.2), b1: new Float32Array(HIDDEN),
    w2: Float32Array.from({ length: HIDDEN * OUT }, () => (rnd() - 0.5) * 0.4), b2: new Float32Array(OUT)
  };
  const P = [net.w1, net.b1, net.w2, net.b2];
  const M = P.map((p) => new Float32Array(p.length)), V = P.map((p) => new Float32Array(p.length)), G = P.map((p) => new Float32Array(p.length));
  const order = rows.map((_, i) => i);
  const h = new Float32Array(HIDDEN), dh = new Float32Array(HIDDEN);
  let t = 0;
  for (let e = 0; e < epochs; e++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let at = 0; at < order.length; at += batch) {
      G.forEach((g) => g.fill(0));
      let weights = 0;
      for (const ri of order.slice(at, at + batch)) {
        const r = rows[ri];
        weights += r.w;
        const x = shifted(r.x, Math.floor(rnd() * 3) - 1, Math.floor(rnd() * 3) - 1);
        const z = networkLogits(net, x, h);
        const top = Math.max(...z); let sum = 0;
        for (let c = 0; c < OUT; c++) { z[c] = Math.exp(z[c] - top); sum += z[c]; }
        dh.fill(0);
        for (let c = 0; c < OUT; c++) {
          const dz = (z[c] / sum - (c === r.y ? 1 : 0)) * r.w;
          G[3][c] += dz;
          const o = c * HIDDEN; for (let u = 0; u < HIDDEN; u++) { G[2][o + u] += dz * h[u]; dh[u] += dz * net.w2[o + u]; }
        }
        for (let u = 0; u < HIDDEN; u++) {
          if (h[u] <= 0) continue;
          G[1][u] += dh[u];
          const o = u * D; for (let i = 0; i < D; i++) G[0][o + i] += dh[u] * x[i];
        }
      }
      t++;
      const c1 = 1 - 0.9 ** t, c2 = 1 - 0.999 ** t;
      P.forEach((p, k) => {
        for (let j = 0; j < p.length; j++) {
          const g = G[k][j] / weights + (k % 2 === 0 ? l2 * p[j] : 0);
          M[k][j] = 0.9 * M[k][j] + 0.1 * g; V[k][j] = 0.999 * V[k][j] + 0.001 * g * g;
          p[j] -= (lr * (M[k][j] / c1)) / (Math.sqrt(V[k][j] / c2) + 1e-8);
        }
      });
    }
  }
  return net;
}

const base64 = (floats) => Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
const mean = (vs) => vs[0].map((_, j) => vs.reduce((t, v) => t + v[j], 0) / vs.length);

/** The model from the transcribed pictures in `files`. */
export function buildModel({ truth, dir, files, standing, note }) {
  const first = collect(truth, dir, files, standing);
  // Boxes the placement could not take from separate pieces of ink were put where the standing model liked them; the network that is
  // then trained likes other columns (a box a little wider, a little narrower), so the boxes are placed again by that network and the
  // network trained once more on those — what it is trained on is then what it will be shown.
  const { digits, negatives, messages, placed, skipped } = collect(truth, dir, files, { samples: standing.samples, network: trainNetwork([...first.digits, ...first.negatives]) });
  const network = trainNetwork([...digits, ...negatives]);
  return {
    stats: { digits: digits.length, negatives: negatives.length, placed, skipped, messages: messages.map((m) => m.length) },
    model: {
      note,
      network: { hidden: network.hidden, w1: base64(network.w1), b1: base64(network.b1), w2: base64(network.w2), b2: base64(network.b2) },
      messages: messages.map((m) => mean(m).map((x) => +x.toFixed(4)))
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: build-model.mjs <pictures dir> [model to place the first boxes by]');
  const truth = JSON.parse(readFileSync(new URL('./ground-truth.json', import.meta.url), 'utf8'));
  const out = new URL('../../mirror/sources/chernihiv-model.json', import.meta.url);
  const current = JSON.parse(readFileSync(out, 'utf8'));
  // The first boxes are placed by a model: by default the one on disk (so a rebuild begins from the last), or the one named — a
  // model of nearest samples from the repository's history, when the one on disk is not to be trusted.
  const from = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : current;
  const { model, stats } = buildModel({ truth, dir, files: Object.keys(truth), standing: loadDigits(from), note: current.note });
  writeFileSync(out, JSON.stringify(model));
  console.log(`digit samples ${stats.digits} (+${stats.negatives} cut wrongly); lines placed by recognition ${stats.placed}, skipped ${stats.skipped}; message lines ${stats.messages.join(' / ')}`);
}
