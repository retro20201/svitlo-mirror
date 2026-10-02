import { decodeJpeg } from './jpeg.mjs';

/**
 * Reading the ГПВ table Сумиобленерго posts to Telegram as a picture: a title, then twelve rows
 * (1.1 … 6.2) of cards, each card "HH:MM - HH:MM" over "N год. MM хв.". Two designs have been
 * used — grey cards on white (November–December 2025) and white/cream cards on dark blue — and
 * both are handled without fixed coordinates.
 *
 * Nothing here guesses. Rows come from the row labels, cards from their colour, digits from
 * templates averaged over 80 pictures transcribed twice by independent readers (2 801 cards); the
 * time must fit a grammar (hours 00–23, minutes 00 or 30), and the printed duration under each
 * window has to agree with it. A card that fails any of that fails the whole picture, and the
 * adapter publishes the picture itself instead. Checked by cross-validation on those 80: no
 * picture read wrongly; 57 read exactly, the rest refused.
 *
 * The model (templates) is `sources/sumy-model.json`; `tools/ocr/sumy/` rebuilds it.
 */

// ── Layout ──────────────────────────────────────────────────────────────────────────────
// Prototype: find cards (chips) and the 12 row labels in a Sumy ГПВ picture.
export function lumaMap(image) {
  const { width, height } = image;
  const L = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = image.pixel(x, y);
    L[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width, height, L, at: (x, y) => L[y * width + x] };
}

/** Connected components of a boolean mask (4-connectivity) → bounding boxes with pixel counts. */
export function components(width, height, mask) {
  const label = new Int32Array(width * height).fill(-1);
  const out = [];
  const stack = [];
  for (let start = 0; start < width * height; start++) {
    if (!mask[start] || label[start] !== -1) continue;
    const id = out.length;
    const box = { x0: width, y0: height, x1: 0, y1: 0, n: 0 };
    label[start] = id; stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % width, y = (p - x) / width;
      box.n++;
      if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q >= 0 && mask[q] && label[q] === -1) { label[q] = id; stack.push(q); }
      }
    }
    out.push(box);
  }
  return out;
}

export function analyse(image) {
  const lm = lumaMap(image);
  const { width, height, L } = lm;
  let sum = 0; for (let i = 0; i < L.length; i += 7) sum += L[i];
  const dark = sum / Math.ceil(L.length / 7) < 160;
  const chipMask = new Uint8Array(width * height);
  for (let i = 0; i < L.length; i++) chipMask[i] = dark ? L[i] >= 200 : L[i] >= 230 && L[i] <= 249;
  const chips = components(width, height, chipMask)
    .map((b) => ({ ...b, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }))
    .filter((b) => b.w >= 50 && b.h >= 28 && b.w / b.h >= 1.3 && b.w / b.h <= 3.2 && b.n / (b.w * b.h) >= 0.5 && b.h < height / 8);
  return { dark, chips, lm };
}

/** Row label runs ("1.1" … "6.2") in the column left of every card; white text on dark, black on light. */
export function labelRuns(image, { dark, chips }) {
  const { width, height } = image;
  const right = (chips.length ? Math.min(...chips.map((c) => c.x0)) : Math.floor(width * 0.25)) - 3;
  const ink = (x, y) => {
    const [r, g, b] = image.pixel(x, y);
    return dark ? Math.min(r, g, b) >= 185 : Math.max(r, g, b) <= 110;
  };
  // Labels fill well under a quarter of any column; table borders, however unevenly lit, more.
  const columns = [];
  for (let x = 0; x < right; x++) {
    let n = 0; for (let y = 0; y < height; y++) if (ink(x, y)) n++;
    if (n < height * 0.25) columns.push(x);
  }
  const counts = [];
  for (let y = 0; y < height; y++) {
    let n = 0; for (const x of columns) if (ink(x, y)) n++;
    counts.push(n >= 2 && n < columns.length * 0.7 ? n : 0);
  }
  const runs = [];
  for (let y = 0; y < height; y++) {
    if (!counts[y]) continue;
    const top = y; while (y < height && counts[y]) y++;
    if (y - top >= 6) runs.push({ top, bottom: y - 1, centre: (top + y - 1) / 2 });
  }
  return runs;
}

/** The 12 rows as y-intervals (midpoints between label centres), or a reason they cannot be trusted. */
export function rowsFromLabels(runs, chips) {
  if (runs.length < 13) return { error: `only ${runs.length} label runs` };
  const labels = runs.slice(-12);
  const heights = labels.map((r) => r.bottom - r.top + 1).sort((a, b) => a - b);
  const median = heights[6];
  if (heights[0] < median * 0.7 || heights[11] > median * 1.35) return { error: `label heights ${heights.join(',')}` };
  const rows = labels.map((r, i) => ({
    centre: r.centre,
    top: i ? (labels[i - 1].centre + r.centre) / 2 : r.centre - (labels[1].centre - r.centre) / 2,
    bottom: i < 11 ? (r.centre + labels[i + 1].centre) / 2 : r.centre + (r.centre - labels[10].centre) / 2
  }));
  for (const c of chips) {
    const yc = (c.y0 + c.y1) / 2;
    const row = rows.findIndex((r) => yc >= r.top && yc < r.bottom);
    if (row < 0 || Math.abs(yc - rows[row].centre) > (c.y1 - c.y0) * 0.45) return { error: `card at y=${Math.round(yc)} off its row` };
    c.row = row;
  }
  return { rows };
}

/**
 * A card's two text lines, each as glyphs: `{ x0, x1, y0, y1 }` boxes of connected ink columns.
 * Ink is anything clearly darker than the card itself.
 */
export function cardLines(lm, card) {
  const { at } = lm;
  const pad = 3;
  const xs = [card.x0 + pad, card.x1 - pad], ys = [card.y0 + pad, card.y1 - pad];
  const bgSamples = [];
  for (let y = ys[0]; y <= ys[1]; y += 2) for (let x = xs[0]; x <= xs[1]; x += 2) bgSamples.push(at(x, y));
  bgSamples.sort((a, b) => a - b);
  const bg = bgSamples[Math.floor(bgSamples.length * 0.75)];
  const darkness = (x, y) => Math.max(0, bg - at(x, y));
  const inkRows = [];
  for (let y = ys[0]; y <= ys[1]; y++) {
    let s = 0; for (let x = xs[0]; x <= xs[1]; x++) if (darkness(x, y) > 60) s++;
    inkRows.push(s > 0);
  }
  const bands = [];
  for (let i = 0; i < inkRows.length; i++) {
    if (!inkRows[i]) continue;
    const top = i; while (i < inkRows.length && inkRows[i]) i++;
    if (i - top >= 4) bands.push({ y0: ys[0] + top, y1: ys[0] + i - 1 });
  }
  return { bg, bands: bands.map((band) => ({ ...band, glyphs: glyphsIn(band) })) };

  function glyphsIn(band) {
    const glyphs = [];
    for (let x = xs[0]; x <= xs[1]; x++) {
      let col = 0; for (let y = band.y0; y <= band.y1; y++) if (darkness(x, y) > 60) col++;
      if (!col) continue;
      const x0 = x;
      while (x <= xs[1]) {
        let c = 0; for (let y = band.y0; y <= band.y1; y++) if (darkness(x, y) > 60) c++;
        if (!c) break; x++;
      }
      let gy0 = band.y1, gy1 = band.y0;
      for (let gx = x0; gx < x; gx++) for (let y = band.y0; y <= band.y1; y++) if (darkness(gx, y) > 60) { gy0 = Math.min(gy0, y); gy1 = Math.max(gy1, y); }
      glyphs.push({ x0, x1: x - 1, y0: gy0, y1: gy1 });
    }
    return glyphs;
  }
}

// ── Text lines ──────────────────────────────────────────────────────────────────────────

/** Darkness of the card's text, 0…1, over a rectangle — the unit every step below works in. */
export function inkGrid(lm, bg, x0, y0, x1, y1) {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = Math.min(1, Math.max(0, (bg - lm.at(x0 + x, y0 + y) - 25) / 120));
  return { w, h, g, v: (x, y) => g[y * w + x] };
}

/**
 * "HH:MM - HH:MM" (or "HH:MM—HH:MM") → four two-digit groups, cut at the two colons and the dash.
 * Returns the groups as column ranges of the line, or a reason.
 */
/**
 * `start` skips anything left of the time itself — Чернігів puts a ⚡ before each window.
 */
export function splitTimeLine(grid, { start = 0, faintTop = false } = {}) {
  const { w, h, v } = grid;
  const on = (x, y) => v(x, y) > 0.4;
  // The text's own vertical extent, so heights below are fractions of the digits, not the band.
  let top = h, bottom = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  if (bottom < 0) return { error: 'no ink' };
  const H = bottom - top + 1;
  const rel = (y) => (y - top) / H;
  const profile = (x) => {
    const r = { top: false, upper: false, gap: false, lower: false };
    for (let y = top; y <= bottom; y++) {
      if (!on(x, y)) continue;
      const f = rel(y);
      if (f < 0.08) r.top = true;
      else if (f < 0.5) r.upper = true;
      else if (f < 0.66) r.gap = true;
      else r.lower = true;
    }
    return r;
  };
  const cols = Array.from({ length: w }, (_, x) => profile(x));
  // Чернігів's 0 has a top stroke thin enough to anti-alias below the ink threshold, which leaves
  // its inside looking like a colon; a colon's dots never reach the top, faint ink or not.
  if (faintTop) {
    for (let x = 0; x < w; x++) {
      for (let y = top; y < top + Math.max(2, Math.round(H * 0.12)); y++) if (v(x, y) > 0.15) { cols[x].top = true; break; }
    }
  }
  let first = start; while (first < w && !Object.values(cols[first]).some(Boolean)) first++;
  let last = w - 1; while (last > 0 && !Object.values(cols[last]).some(Boolean)) last--;
  // Dash: the widest run of columns inked only around mid-height, near the middle of the line —
  // a 4's crossbar or a 7's stem can look mid-only for a column or two, never there and as wide.
  const midOnly = (x) => {
    let any = false;
    for (let y = top; y <= bottom; y++) {
      if (!on(x, y)) continue;
      const f = rel(y);
      if (f < 0.3 || f > 0.78) return false;
      any = true;
    }
    return any;
  };
  const from = first + Math.floor((last - first) * 0.3), to = first + Math.ceil((last - first) * 0.7);
  let dash = null;
  for (let x = from; x <= to; x++) {
    if (!midOnly(x)) continue;
    const s0 = x; while (x <= last && midOnly(x)) x++;
    if (!dash || x - s0 > dash.x1 - dash.x0 + 1) dash = { x0: s0, x1: x - 1 };
  }
  if (!dash || dash.x1 - dash.x0 + 1 < 2) return { error: 'no dash' };
  // Colon columns: a dot in the upper half and one on the baseline, nothing at the top or between.
  const colonCol = (x) => cols[x].upper && cols[x].lower && !cols[x].top && !cols[x].gap;
  const groups = [];
  for (let x = first; x <= last; x++) {
    if (!colonCol(x)) continue;
    const s0 = x; while (x <= last && colonCol(x)) x++;
    // The dots' anti-aliased edges carry only one of the two dots; they belong to the colon,
    // not to the digit beside it.
    const dotOnly = (c) => c >= first && c <= last && (cols[c].upper || cols[c].lower) && !cols[c].top && !cols[c].gap;
    let g0 = s0, g1 = x - 1;
    if (dotOnly(g0 - 1)) g0--;
    if (dotOnly(g1 + 1)) g1++;
    groups.push({ x0: g0, x1: g1 });
  }
  const left = groups.filter((g) => g.x1 < dash.x0 && g.x0 > first + 2);
  const right = groups.filter((g) => g.x0 > dash.x1 && g.x1 < last - 2);
  const inkSpan = (a, b) => {
    let x0 = -1, x1 = -1;
    for (let x = a; x <= b; x++) if (Object.values(cols[x]).some(Boolean)) { if (x0 < 0) x0 = x; x1 = x; }
    return x0 < 0 ? null : { x0, x1 };
  };
  // Four groups of two digits each: the right colons are the pair that makes them alike in width.
  let best = null;
  for (const c1 of left) for (const c2 of right) {
    const parts = [inkSpan(first, c1.x0 - 1), inkSpan(c1.x1 + 1, dash.x0 - 1), inkSpan(dash.x1 + 1, c2.x0 - 1), inkSpan(c2.x1 + 1, last)];
    if (parts.some((p) => !p)) continue;
    const widths = parts.map((p) => p.x1 - p.x0 + 1);
    const mean = widths.reduce((a, b) => a + b, 0) / 4;
    const score = widths.reduce((a, w) => a + (w - mean) ** 2, 0);
    if (!best || score < best.score) best = { c1, c2, parts, score };
  }
  if (!best) return { error: `colons: ${left.length} left, ${right.length} right` };
  const { c1, c2, parts } = best;
  return { groups: parts, colons: [c1, c2], dash };
}

/**
 * A two-digit group → its two digit boxes: at a blank column when there is one, otherwise down the
 * middle — the font's digits are all one width, and a merged pair splits evenly.
 */
export function splitPair(grid, { x0, x1 }) {
  const width = x1 - x0 + 1;
  const colInk = (x) => { let s = 0; for (let y = 0; y < grid.h; y++) s += grid.v(x, y) > 0.3 ? 1 : 0; return s; };
  const lo = x0 + Math.floor(width * 0.3), hi = x0 + Math.ceil(width * 0.7);
  for (let x = lo; x <= hi; x++) {
    if (colInk(x) === 0) {
      let e = x; while (e < hi && colInk(e + 1) === 0) e++;
      return [{ x0, x1: x - 1 }, { x0: e + 1, x1 }];
    }
  }
  const m = x0 + Math.floor(width / 2);
  return [{ x0, x1: m - 1 }, { x0: m, x1 }];
}

const NW = 10, NH = 14;
/** A digit box → a fixed NW×NH darkness vector, cropped to its own ink rows. */
export function normalise(grid, { x0, x1 }, threshold = 0.3) {
  let y0 = grid.h, y1 = -1;
  for (let y = 0; y < grid.h; y++) for (let x = x0; x <= x1; x++) if (grid.v(x, y) > threshold) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (y1 < 0) return null;
  const out = new Float32Array(NW * NH);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  for (let j = 0; j < NH; j++) for (let i = 0; i < NW; i++) {
    // Area-average the source pixels this cell covers.
    const sx0 = x0 + (i * bw) / NW, sx1 = x0 + ((i + 1) * bw) / NW, sy0 = y0 + (j * bh) / NH, sy1 = y0 + ((j + 1) * bh) / NH;
    let s = 0, n = 0;
    for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) { s += grid.v(x, y); n++; }
    out[j * NW + i] = n ? s / n : 0;
  }
  return { vec: out, aspect: bw / bh };
}

export function ncc(a, b) {
  let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** The duration line "4 год. 00 хв." → the boxes of its leading number (1 or 2 digits). */
export const DURATION_INK = 0.18;
export function durationHoursBoxes(grid) {
  const { w, h, v } = grid;
  const colInk = (x) => { for (let y = 0; y < h; y++) if (v(x, y) > DURATION_INK) return true; return false; };
  let x = 0; while (x < w && !colInk(x)) x++;
  if (x >= w) return null;
  const segs = [];
  while (x < w) {
    if (!colInk(x)) { x++; continue; }
    const s = x; while (x < w && colInk(x)) x++;
    segs.push({ x0: s, x1: x - 1 });
  }
  // Text height from the first segment's ink.
  let top = h, bottom = -1;
  for (let yy = 0; yy < h; yy++) for (let xx = segs[0].x0; xx <= segs[0].x1; xx++) if (v(xx, yy) > DURATION_INK) { top = Math.min(top, yy); bottom = Math.max(bottom, yy); }
  const H = bottom - top + 1;
  // The number ends at the first word gap.
  const token = [segs[0]];
  for (let i = 1; i < segs.length && segs[i].x0 - token.at(-1).x1 - 1 < Math.max(2, H * 0.28); i++) token.push(segs[i]);
  const span = { x0: token[0].x0, x1: token.at(-1).x1 };
  const width = span.x1 - span.x0 + 1;
  // A thin 4 falls apart into its diagonal and its stem, so pieces are not digits: the width is.
  return width > H * 0.95 ? [{ x0: span.x0, x1: span.x0 + Math.floor(width / 2) - 1 }, { x0: span.x0 + Math.floor(width / 2), x1: span.x1 }] : [span];
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────

/** NCC of a glyph against each digit's template(s). */
const scoresFor = (n, T) => Object.fromEntries(Object.entries(T).map(([label, cs]) => [label, Math.max(...cs.map((c) => ncc(n.vec, c)))]));

/** One two-digit group under a grammar → its candidate values, best first, with scores. */
function groupCandidates(grid, group, T, kind) {
  const boxes = splitPair(grid, group);
  const s = boxes.map((b) => { const n = normalise(grid, b); return n ? scoresFor(n, T) : null; });
  if (s.some((x) => !x)) return { error: 'blank digit' };
  const allowed = kind === 'minutes' ? ['00', '30'] : Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const ranked = allowed.map((v) => ({ v, score: (s[0][v[0]] ?? -1) + (s[1][v[1]] ?? -1) })).sort((a, b) => b.score - a.score);
  // The grammar's choice must also be what each digit looks like, or the glyph is something else.
  for (let i = 0; i < 2; i++) {
    const chosen = s[i][ranked[0].v[i]];
    const top = Math.max(...Object.values(s[i]));
    if (top - chosen > 0.06) return { error: `digit ${i} reads as something else (${chosen.toFixed(3)} vs ${top.toFixed(3)})` };
  }
  return { ranked: ranked.slice(0, 3) };
}

const CONTENDER = 0.06;
const minutesOf = (parts) => {
  const start = Number(parts[0]) * 60 + Number(parts[1]);
  let end = Number(parts[2]) * 60 + Number(parts[3]);
  if (end === 0) end = 1440;
  return { start, end };
};

/** How well the card's duration line reads as `hours`; null if the line cannot be cut into that many digits. */
function durationScore(lm, bg, card, band, hours, D) {
  const dgrid = inkGrid(lm, bg, card.x0 + 3, band.y0 - 1, card.x1 - 3, band.y1 + 1);
  const boxes = durationHoursBoxes(dgrid);
  if (!boxes || boxes.length !== hours.length) return null;
  let total = 0, rival = 0;
  for (const [i, b] of boxes.entries()) {
    const n = normalise(dgrid, b, DURATION_INK); if (!n) return null;
    // Only digits as wide as this glyph are in the running: a thin 4 at this size can look like a
    // 1 in shape, never in width.
    const fits = (k) => D[k] && n.aspect >= D[k].aspect[0] && n.aspect <= D[k].aspect[1];
    const score = (k) => (fits(k) ? ncc(n.vec, D[k].vec) : -1);
    total += score(hours[i]);
    rival += Math.max(-1, ...Object.keys(D).filter((k) => k !== hours[i]).map(score));
  }
  return { total, rival };
}

export function readPicture(image, { P, DP }) {
  const a = analyse(image);
  const T = P[a.dark ? 'dark' : 'light'];
  const D = DP;
  // A picture without a single card is not read as a day without outages: it is more likely a
  // picture this reader does not understand.
  if (!a.chips.length) return { error: 'no cards found' };
  const r = rowsFromLabels(labelRuns(image, a), a.chips);
  if (r.error) return { error: `rows: ${r.error}` };
  const leftover = unreadInk(image, a, r.rows);
  if (leftover) return { error: leftover };
  const rows = Array.from({ length: 12 }, () => []);
  for (const card of a.chips) {
    const { bg, bands } = cardLines(a.lm, card);
    if (bands.length < 2) return { error: `card at ${card.x0},${card.y0}: ${bands.length} text lines` };
    const grid = inkGrid(a.lm, bg, card.x0 + 3, bands[0].y0 - 1, card.x1 - 3, bands[0].y1 + 1);
    const sp = splitTimeLine(grid);
    if (sp.error) return { error: `card at ${card.x0},${card.y0}: ${sp.error}` };
    const groups = [];
    for (const [i, g] of sp.groups.entries()) {
      const c = groupCandidates(grid, g, T, i % 2 ? 'minutes' : 'hours');
      if (c.error) return { error: `card at ${card.x0},${card.y0}: ${c.error}` };
      groups.push(c.ranked);
    }
    // Whole-card readings: every combination of each group's top candidates, best first.
    let readings = [[]];
    for (const ranked of groups) readings = readings.flatMap((r) => ranked.map((c) => [...r, c]));
    readings = readings.map((r) => ({ parts: r.map((c) => c.v), score: r.reduce((s, c) => s + c.score, 0) }))
      // Every window in 80 transcribed pictures (2 801 cards) is at most 4 hours; a longer reading
      // has no duration template to be checked against, so it is not trusted.
      .filter((r) => { const { start, end } = minutesOf(r.parts); return end > start && end - start < 300; })
      .sort((a, b) => b.score - a.score);
    if (!readings.length) return { error: `card at ${card.x0},${card.y0}: no reading runs forwards` };
    const contenders = readings.filter((r) => readings[0].score - r.score < CONTENDER);
    // The printed duration decides between close readings, and vetoes a confident one it contradicts.
    const withDuration = contenders.map((r) => {
      const { start, end } = minutesOf(r.parts);
      return { ...r, start, end, d: durationScore(a.lm, bg, card, bands[1], String(Math.floor((end - start) / 60)), D) };
    });
    let pick;
    if (withDuration.length === 1) {
      pick = withDuration[0];
      if (!pick.d) return { error: `card at ${card.x0},${card.y0}: duration line unreadable` };
      if (pick.d.rival - pick.d.total > 0.12) return { error: `card at ${card.x0},${card.y0}: ${pick.parts.join(':')} contradicted by its duration` };
    } else {
      const durations = new Set(withDuration.map((r) => r.end - r.start));
      if (durations.size < withDuration.length) return { error: `card at ${card.x0},${card.y0}: ${withDuration.map((r) => r.parts.join(':')).join(' / ')} — same duration, cannot tell` };
      const byDuration = withDuration.filter((r) => r.d !== null).sort((p, q) => q.d.total - p.d.total);
      if (!byDuration.length || (byDuration[1] && byDuration[0].d.total - byDuration[1].d.total < 0.1)) return { error: `card at ${card.x0},${card.y0}: ambiguous ${withDuration.map((r) => r.parts.join(':')).join(' / ')}` };
      pick = byDuration[0];
    }
    const { start, end } = pick;
    rows[card.row].push({ x: card.x0, start, end });
  }
  for (const row of rows) {
    row.sort((p, q) => p.x - q.x);
    for (let i = 1; i < row.length; i++) if (row[i].start < row[i - 1].end) return { error: 'windows overlap or out of order' };
  }
  return { rows: rows.map((row) => row.map(({ start, end }) => ({ start, end }))) };
}

/**
 * Something card-like in a row that is not one of the cards found means a window would go
 * unread — a card in an unexpected colour, say. On the dark design that is a solid card-sized
 * patch (the background's light streaks are long and thin, never solid); on the light one, any
 * text taller than the "—" an empty row shows.
 */
function unreadInk(image, { dark, chips, lm }, rows) {
  const left = Math.min(...chips.map((c) => c.x0));
  const { width, height } = image;
  const sorted = (xs) => xs.sort((p, q) => p - q);
  const cardW = sorted(chips.map((c) => c.w))[chips.length >> 1];
  const cardH = sorted(chips.map((c) => c.h))[chips.length >> 1];
  const top = Math.ceil(rows[0].top), bottom = Math.floor(rows[11].bottom);
  const mask = new Uint8Array(width * height);
  for (let y = Math.max(0, top); y <= Math.min(height - 1, bottom); y++) {
    for (let x = left; x < width; x++) {
      if (chips.some((c) => x >= c.x0 - 3 && x <= c.x1 + 3 && y >= c.y0 - 3 && y <= c.y1 + 3)) continue;
      if (dark) {
        // Anything that is not the dark-blue background, whatever its colour.
        const [r, , b] = image.pixel(x, y);
        mask[y * width + x] = lm.at(x, y) >= 120 && b - r < 60;
      } else {
        mask[y * width + x] = lm.at(x, y) <= 130;
      }
    }
  }
  for (const blob of components(width, height, mask)) {
    const w = blob.x1 - blob.x0 + 1, h = blob.y1 - blob.y0 + 1;
    const missedCard = dark
      ? w >= cardW * 0.5 && h >= cardH * 0.5 && blob.n >= w * h * 0.45
      : h >= 6 && h <= cardH && w <= cardW;
    if (missedCard) return `unread ${w}x${h} shape at ${blob.x0},${blob.y0} outside the cards`;
  }
  return null;
}

/** JPEG bytes → `{ rows: [[{ start, end }]] }` in minutes of the day (end 1440 = midnight), or `{ error }`. */
export function readSchedulePicture(bytes, model) {
  return readPicture(decodeJpeg(bytes), { P: model.digits, DP: model.duration });
}
