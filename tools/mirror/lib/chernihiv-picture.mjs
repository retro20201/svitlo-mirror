import { decodeJpeg } from './jpeg.mjs';
import { components, inkGrid, splitTimeLine, ncc } from './sumy-picture.mjs';

/**
 * Reading the ГПВ tables Чернігівобленерго posts to Telegram.
 *
 * Grid design (October 2025 – March 2026): 48 half-hour rows × 12 subqueue columns (1/I, 1/II …
 * 6/II), each cell green, red or yellow, and a legend that says what they mean: green
 * "електроенергія не відключається", red "відключення електроенергії", yellow "час розміну черг
 * (підчерга)" — the switch-over half-hour, power may or may not be there, so "possible". Read by
 * colour: the 12 columns and 48 rows are the runs of coloured cells between the grid's lines,
 * and every cell must be plainly one of the three colours or the picture is refused.
 */
const colourOf = ([r, g, b]) => {
  if (r > 200 && g > 190 && b < 110) return 'yellow';
  if (r > 170 && g < 110 && b < 110) return 'red';
  // Three greens have been used: pale sage (181,218,160), sage (143,202,139) and mint
  // (104,253,154). None of them is anywhere near red or yellow.
  if (g > 150 && g >= r + 20 && g >= b + 25 && b > 100) return 'green';
  return null;
};
const STATE = { green: 'on', red: 'off', yellow: 'possible' };

/** Runs of indices where `count` is high, as [start, end] pairs. */
function runs(counts, threshold, minLength) {
  const out = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] < threshold) continue;
    const s = i; while (i < counts.length && counts[i] >= threshold) i++;
    if (i - s >= minLength) out.push([s, i - 1]);
  }
  return out;
}

export function readColourGrid(image) {
  const { width, height } = image;
  const coloured = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) coloured[y * width + x] = colourOf(image.pixel(x, y)) ? 1 : 0;

  // Columns: x where coloured cells run down most of the picture (the legend's three swatches do not).
  const colCounts = Array.from({ length: width }, (_, x) => { let n = 0; for (let y = 0; y < height; y++) n += coloured[y * width + x]; return n; });
  const columns = runs(colCounts, height * 0.5, 4);
  if (columns.length !== 12) return { error: `${columns.length} subqueue columns` };
  const widths = columns.map(([a, b]) => b - a + 1);
  if (Math.max(...widths) - Math.min(...widths) > 4) return { error: 'subqueue columns of uneven width' };

  // Rows: y where coloured cells run across most of those columns. At 800 px some of the thin
  // rules between half-hours blend away and two rows read as one, so the rows are not counted
  // but fitted: 48 equal rows from the first coloured line to the last, each of whose centres
  // must fall inside a detected run, and every detected single run on one of them.
  const x0 = columns[0][0], x1 = columns[11][1];
  const rowCounts = Array.from({ length: height }, (_, y) => { let n = 0; for (let x = x0; x <= x1; x++) n += coloured[y * width + x]; return n; });
  const detected = runs(rowCounts, (x1 - x0 + 1) * 0.6, 3);
  if (detected.length < 30) return { error: `${detected.length} half-hour rows` };
  const top = detected[0][0], bottom = detected.at(-1)[1];
  const gap = detected.slice(1).map(([a], i) => a - detected[i][1] - 1).sort((p, q) => p - q)[detected.length >> 1];
  const pitch = (bottom - top + 1 + gap) / 48;
  const centres = Array.from({ length: 48 }, (_, i) => top + pitch * i + (pitch - gap) / 2);
  if (centres.some((c) => !detected.some(([a, b]) => c >= a + 1 && c <= b - 1))) return { error: 'half-hour rows do not fit an even grid' };
  for (const [a, b] of detected) {
    if (b - a + 1 > pitch * 0.75) continue;
    const c = (a + b) / 2;
    if (!centres.some((x) => Math.abs(x - c) <= 2)) return { error: 'a half-hour row off the even grid' };
  }
  const rows = centres.map((c) => [Math.round(c), Math.round(c)]);

  const halves = Array.from({ length: 12 }, () => []);
  for (const [r, [ya, yb]] of rows.entries()) {
    const y = Math.round((ya + yb) / 2);
    for (const [c, [xa, xb]] of columns.entries()) {
      const x = Math.round((xa + xb) / 2);
      const seen = [[x, y], [x - 2, y], [x + 2, y], [x, y - 1], [x, y + 1]].map(([sx, sy]) => colourOf(image.pixel(sx, sy)));
      if (!seen[0] || seen.some((s) => s !== seen[0])) return { error: `cell ${c + 1} at ${String(r >> 1).padStart(2, '0')}:${r % 2 ? '30' : '00'} is not one plain colour` };
      halves[c].push(STATE[seen[0]]);
    }
  }
  return { rows: halves };
}

// ── Tile design (February 2026 onward) ────────────────────────────────────────────────────────

const isPeach = ([r, g, b]) => r > 225 && g > 170 && g < 230 && b > 130 && b < 205 && r - b > 40;
const TILE_ORDER = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

/**
 * The 12 tiles and, in each, its text lines below the label: `{ tiles: [{ label, lines: [{ kind:
 * 'time', grid, split } | { kind: 'text' }] }] }` or `{ error }`. Digits are not read here.
 */
export function tileLayout(image) {
  const { width, height } = image;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mask[y * width + x] = isPeach(image.pixel(x, y)) ? 1 : 0;
  const tiles = components(width, height, mask)
    .map((b) => ({ ...b, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }))
    .filter((b) => b.w > width * 0.15 && b.h > height * 0.08 && b.n > b.w * b.h * 0.5);
  if (tiles.length !== 12) return { error: `${tiles.length} tiles` };
  // Reading order: rows of three, top to bottom.
  tiles.sort((a, b) => a.y0 - b.y0);
  const ordered = [];
  for (let r = 0; r < 4; r++) ordered.push(...tiles.slice(r * 3, r * 3 + 3).sort((a, b) => a.x0 - b.x0));
  for (let r = 1; r < 4; r++) if (ordered[r * 3].y0 < ordered[r * 3 - 1].y1) return { error: 'tiles are not in rows of three' };

  const luma = (x, y) => { const [r, g, b] = image.pixel(x, y); return 0.299 * r + 0.587 * g + 0.114 * b; };
  const lm = { at: (x, y) => luma(x, y) };
  const out = [];
  for (const [i, tile] of ordered.entries()) {
    const bg = 215;
    const pad = 4;
    const ink = (x, y) => { const [r, g, b] = image.pixel(x, y); return !isPeach([r, g, b]) && luma(x, y) < 170; };
    const rows = [];
    for (let y = tile.y0 + pad; y <= tile.y1 - pad; y++) {
      let n = 0; for (let x = tile.x0 + pad; x <= tile.x1 - pad; x++) if (ink(x, y)) n++;
      rows.push(n > 0);
    }
    const bands = [];
    for (let k = 0; k < rows.length; k++) {
      if (!rows[k]) continue;
      const s = k; while (k < rows.length && rows[k]) k++;
      if (k - s >= 4) bands.push({ y0: tile.y0 + pad + s, y1: tile.y0 + pad + k - 1 });
    }
    if (bands.length < 2) return { error: `tile ${TILE_ORDER[i]}: ${bands.length} lines` };
    // The first line is the tile's own label (outlined, coloured); the rest are its content.
    const lines = bands.slice(1).map((band) => {
      const grid = inkGrid(lm, bg, tile.x0 + pad, band.y0 - 1, tile.x1 - pad, band.y1 + 1);
      // The crossed-out ⚡ before each window is the leftmost piece of ink and taller than the
      // digits after it; reading starts after it. A message line has no such piece.
      const colRows = (x) => { let top = -1, bottom = -1; for (let y = 0; y < grid.h; y++) if (grid.v(x, y) > 0.4) { if (top < 0) top = y; bottom = y; } return top < 0 ? null : [top, bottom]; };
      let x = 0; while (x < grid.w && !colRows(x)) x++;
      const iconStart = x;
      let iconTop = grid.h, iconBottom = -1;
      while (x < grid.w && colRows(x)) { const [t, b] = colRows(x); iconTop = Math.min(iconTop, t); iconBottom = Math.max(iconBottom, b); x++; }
      const afterIcon = x;
      let restTop = grid.h, restBottom = -1;
      for (let xx = afterIcon; xx < grid.w; xx++) { const r = colRows(xx); if (r) { restTop = Math.min(restTop, r[0]); restBottom = Math.max(restBottom, r[1]); } }
      const isIcon = restBottom >= 0 && iconBottom - iconTop + 1 > (restBottom - restTop + 1) * 1.2 && afterIcon - iconStart < grid.w * 0.2;
      const start = isIcon ? afterIcon : iconStart;
      const split = splitTimeLine(grid, { start, faintTop: true });
      return split.error ? { kind: /0 left, 0 right|no dash|^0 colons/.test(split.error) ? 'text' : 'broken', error: split.error, grid } : { kind: 'time', grid, split };
    });
    out.push({ label: TILE_ORDER[i], lines });
  }
  return { tiles: out };
}

/**
 * Line grid → the eight digit boxes of "HH:MM - HH:MM", from connected pieces of ink: the icon
 * (taller than the digits) and anything left of it dropped, a colon recognised as two small
 * stacked dots, the dash as one flat piece at mid-height. `{ digits, colons, dash }` or `{ error }`.
 */
export function digitBoxes(grid, threshold = 0.4) {
  const { w, h } = grid;
  const mask = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) mask[i] = grid.g[i] > threshold;
  const comps = components(w, h, mask).filter((c) => c.n >= 3).map((c) => ({ ...c, cw: c.x1 - c.x0 + 1, ch: c.y1 - c.y0 + 1, parts: 1, small: 0 })).sort((a, b) => a.x0 - b.x0);
  if (comps.length < 10) return { error: `${comps.length} pieces of ink` };
  const tall = comps.map((c) => c.ch).sort((a, b) => b - a);
  // Digit height: the most common height among the taller pieces.
  const H = tall[Math.min(tall.length - 1, 5)];
  for (const c of comps) c.small = c.ch < H * 0.4 ? 1 : 0;
  // Pieces overlapping in x are one glyph (a colon's two dots, a broken stroke).
  const glyphs = [];
  for (const c of comps) {
    const g = glyphs.at(-1);
    if (g && c.x0 <= g.x1 - 1) { g.x0 = Math.min(g.x0, c.x0); g.x1 = Math.max(g.x1, c.x1); g.y0 = Math.min(g.y0, c.y0); g.y1 = Math.max(g.y1, c.y1); g.parts++; g.small += c.small; g.cw = g.x1 - g.x0 + 1; g.ch = g.y1 - g.y0 + 1; }
    else glyphs.push({ ...c });
  }
  // The icon, and anything before it, is taller than the digits.
  let first = 0;
  for (let i = 0; i < Math.min(3, glyphs.length); i++) if (glyphs[i].ch > H * 1.25) first = i + 1;
  const rest = glyphs.slice(first);
  // Digits are the full-height pieces; everything between them (colon dots, dash) is low. The
  // line must be exactly D D | D D | D D | D D with something low in each of the three gaps.
  // A colon is two dots stacked with a gap between them — narrow, in two pieces — where a 1 is
  // one stroke; both can be nearly as tall as the digits.
  const isColon = (g) => g.parts >= 2 && g.small === g.parts && g.cw <= H * 0.45;
  const isDigit = (g) => !isColon(g) && g.ch >= H * 0.75 && g.ch <= H * 1.15 && g.cw <= H * 1.0;
  const isLow = (g) => isColon(g) || g.ch <= H * 0.7;
  const kinds = rest.map((g) => (isDigit(g) ? 'D' : isLow(g) ? 's' : '?'));
  const pattern = kinds.join('').replace(/s+/g, 's');
  if (pattern !== 'DDsDDsDDsDD') return { error: `pieces read as ${pattern}` };
  return { digits: rest.filter((_, i) => kinds[i] === 'D').map((g) => ({ x0: g.x0, x1: g.x1 })), H };
}

/** Digit box → 16×20 canvas, scaled by height (aspect kept), centred; bilinear sampling. */
export function normalise2(grid, { x0, x1 }, W = 16, H = 20, threshold = 0.3) {
  let y0 = grid.h, y1 = -1;
  for (let y = 0; y < grid.h; y++) for (let x = x0; x <= x1; x++) if (grid.v(x, y) > threshold) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (y1 < 0) return null;
  const bh = y1 - y0 + 1, bw = x1 - x0 + 1, scale = (H - 1) / Math.max(1, bh - 1);
  const out = new Float32Array(W * H);
  const cx = (x0 + x1) / 2;
  const sample = (fx, fy) => { const xa = Math.floor(fx), ya = Math.floor(fy), dx = fx - xa, dy = fy - ya; const g = (x, y) => (x < x0 - 1 || x > x1 + 1 || y < 0 || y >= grid.h || x < 0 || x >= grid.w ? 0 : grid.v(x, y)); return g(xa, ya) * (1 - dx) * (1 - dy) + g(xa + 1, ya) * dx * (1 - dy) + g(xa, ya + 1) * (1 - dx) * dy + g(xa + 1, ya + 1) * dx * dy; };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) out[j * W + i] = sample(cx + (i - (W - 1) / 2) / scale, y0 + j / scale);
  return { vec: out, aspect: bw / bh };
}

/** A whole text line → 48×8 darkness, for recognising the constant "не прогнозується" message. */
export function lineVec(grid) {
  const W = 48, H = 8, out = [];
  let x0 = grid.w, x1 = -1;
  for (let x = 0; x < grid.w; x++) for (let y = 0; y < grid.h; y++) if (grid.v(x, y) > 0.4) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  if (x1 < 0) return null;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let sum = 0, n = 0;
      const ya = Math.floor((j * grid.h) / H), yb = Math.max(ya + 1, Math.floor(((j + 1) * grid.h) / H));
      const xa = Math.floor(x0 + (i * (x1 - x0 + 1)) / W), xb = Math.max(xa + 1, Math.floor(x0 + ((i + 1) * (x1 - x0 + 1)) / W));
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { sum += grid.v(x, y); n++; }
      out.push(sum / n);
    }
  }
  return out;
}

const unit = (v) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const c = v.map((x) => x - m);
  const n = Math.sqrt(c.reduce((a, b) => a + b * b, 0)) || 1;
  return c.map((x) => x / n);
};

/** The model's digit samples, decoded once: `{ label, p }` with `p` zero-mean, unit-length. */
export function loadDigits(model) {
  return model.digits.map(({ label, v }) => ({ label, p: unit([...Buffer.from(v, 'base64')].map((b) => b / 255)) }));
}

/** A digit's score for each label: its nearest sample of that label (cosine of centred vectors). */
function digitScores(vec, samples) {
  const p = unit([...vec]);
  const best = {};
  for (const s of samples) {
    let dot = 0;
    for (let i = 0; i < p.length; i++) dot += p[i] * s.p[i];
    if (!(s.label in best) || dot > best[s.label]) best[s.label] = dot;
  }
  return best;
}

const HOURS = Array.from({ length: 25 }, (_, h) => String(h).padStart(2, '0'));
const PAIR_MARGIN = 0.025;

/** Two digits under a grammar → their value, or a reason not to trust any. */
function readPair(scores, allowed) {
  const ranked = allowed.map((v) => ({ v, score: (scores[0][v[0]] ?? -1) + (scores[1][v[1]] ?? -1) })).sort((a, b) => b.score - a.score);
  for (let i = 0; i < 2; i++) {
    const chosen = scores[i][ranked[0].v[i]];
    if (Math.max(...Object.values(scores[i])) - chosen > 0.08) return { error: 'a digit reads as something the grammar does not allow' };
  }
  if (ranked[1] && ranked[0].score - ranked[1].score < PAIR_MARGIN) return { error: `ambiguous ${ranked[0].v}/${ranked[1].v}` };
  return { value: ranked[0].v };
}

/**
 * Tile design → `{ rows: [[{ start, end }]] }` (minutes; 1440 = midnight), or `{ error }`.
 *
 * A tile is either the two-line "ВІДКЛЮЧЕНЬ НЕ ПРОГНОЗУЄТЬСЯ" (matched whole against the
 * model's average of 174 of them) or one "⚡ HH:MM - HH:MM" per line. Digits are cut as the
 * connected pieces of ink between the icon and the line's end — exactly D D | D D | D D | D D —
 * and read against 1 400 samples kept from 7 750 transcribed (nearest sample wins), under the
 * grammar hours 00–24, minutes 00 or 30. Any doubt refuses the picture.
 */
export function readTiles(image, model, digits = loadDigits(model)) {
  const layout = tileLayout(image);
  if (layout.error) return layout;
  const rows = [];
  for (const tile of layout.tiles) {
    if (tile.lines.length === 2) {
      const v = tile.lines.map((l) => lineVec(l.grid));
      if (v.every(Boolean) && ncc(v[0], model.messages[0]) >= 0.8 && ncc(v[1], model.messages[1]) >= 0.8) { rows.push([]); continue; }
    }
    const windows = [];
    for (const line of tile.lines) {
      const cut = digitBoxes(line.grid);
      if (cut.error) return { error: `tile ${tile.label}: ${cut.error}` };
      const scores = cut.digits.map((box) => digitScores(normalise2(line.grid, box).vec, digits));
      const parts = [];
      for (const [i, allowed] of [[0, HOURS], [2, ['00', '30']], [4, HOURS], [6, ['00', '30']]]) {
        const pair = readPair([scores[i], scores[i + 1]], allowed);
        if (pair.error) return { error: `tile ${tile.label}: ${pair.error}` };
        parts.push(pair.value);
      }
      const start = Number(parts[0]) * 60 + Number(parts[1]);
      let end = Number(parts[2]) * 60 + Number(parts[3]);
      if (end === 0) end = 1440;
      if (start >= 1440 || end > 1440 || end <= start) return { error: `tile ${tile.label}: ${parts.join(':')} is not a window` };
      if (windows.length && start < windows.at(-1).end) return { error: `tile ${tile.label}: windows out of order` };
      windows.push({ start, end });
    }
    if (!windows.length) return { error: `tile ${tile.label}: neither windows nor the "не прогнозується" message` };
    rows.push(windows);
  }
  return { rows };
}

const toHalves = (rows) => rows.map((windows) => {
  const slots = Array(48).fill('on');
  for (const { start, end } of windows) for (let s = Math.floor(start / 30); s < Math.ceil(end / 30); s++) slots[s] = 'off';
  return slots;
});

/**
 * A posted picture → `{ rows: [12 × 48 half-hour states] }`, `{ error }` for a schedule it could
 * not read, or `{ error, notTable: true }` for a picture that is no schedule at all (a banner, an
 * infographic) — which must never be published in a schedule's place.
 */
export function readChernihivPicture(bytes, model, digits) {
  let image;
  try {
    image = decodeJpeg(bytes);
  } catch (error) {
    return { error: `picture does not decode: ${error.message}` };
  }
  if (Math.abs(image.width - image.height) < 20) {
    const grid = readColourGrid(image);
    return grid.error && /subqueue columns/.test(grid.error) ? { ...grid, notTable: true } : grid;
  }
  if (image.height > image.width * 1.3) {
    const tiles = readTiles(image, model, digits);
    if (tiles.error) return /^\d+ tiles$/.test(tiles.error) ? { ...tiles, notTable: true } : tiles;
    return { rows: toHalves(tiles.rows) };
  }
  return { error: `a ${image.width}×${image.height} picture is no schedule`, notTable: true };
}
