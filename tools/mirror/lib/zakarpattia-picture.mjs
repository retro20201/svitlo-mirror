import { decodeJpeg } from './jpeg.mjs';

/**
 * Reading the ГПВ grid Закарпаттяобленерго posts to Telegram: twelve rows (1-1 … 6-2), each
 * subqueue's label cell in its queue's colour, and 24 hour cells per row, an hour half-filled when
 * only half of it is off. Telegram serves the picture at 800 px wide, so an hour is ~30 px and a
 * row ~11 px — enough to read colour, not to read text, and nothing here reads text.
 *
 * Filled means off: on 1 липня 2026, a day Укренерго applied schedules only in the evening, the
 * operator's picture has a handful of filled cells, all between 17:00 and 22:00.
 *
 * Rows are the bands between the table's horizontal rules; hours are the 24 cells between the 25
 * evenly spaced vertical rules of the time grid. Every half-hour is read at its centre and must be
 * plainly white or plainly the colour of its row's label; anything else refuses the picture.
 */
const kind = ([r, g, b]) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (min >= 200) return 'white';
  if (max - min >= 60 && max >= 120) return 'colour';
  if (max <= 140) return 'dark';
  return 'grey';
};

const hue = ([r, g, b]) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** Image → `{ rows: [[48 × 'on'|'off']] }` in subqueue order 1.1 … 6.2, or `{ error }`. */
export function readGrid(image) {
  const { width, height } = image;
  const at = (x, y) => kind(image.pixel(x, y));

  // Vertical rules: columns that are dark or grey down much of the lower part of the picture
  // (on a heavy day the fills hide part of them).
  const top = Math.floor(height * 0.3);
  const ruleCols = [];
  for (let x = 0; x < width; x++) {
    let n = 0;
    for (let y = top; y < height; y++) { const k = at(x, y); if (k === 'dark' || k === 'grey') n++; }
    if (n >= (height - top) * 0.35) ruleCols.push(x);
  }
  const rules = [];
  for (const x of ruleCols) if (!rules.length || x - rules.at(-1).x1 > 1) rules.push({ x0: x, x1: x }); else rules.at(-1).x1 = x;
  const centres = rules.map((r) => (r.x0 + r.x1) / 2);
  // The time grid: 25 evenly spaced rules. Fit the progression that the most rules sit on —
  // the table's own borders and the label columns' rules are not on it.
  const gaps = centres.slice(1).map((x, i) => x - centres[i]).filter((g) => g >= width / 40 && g <= width / 20).sort((a, b) => a - b);
  if (!gaps.length) return { error: 'no hour rules' };
  let step = gaps[gaps.length >> 1];
  let best = null;
  for (const start of centres) {
    const hits = Array.from({ length: 25 }, (_, k) => centres.find((c) => Math.abs(c - (start + k * step)) <= 2));
    const n = hits.filter((h) => h !== undefined).length;
    if (!best || n > best.n) best = { start, hits, n };
  }
  if (best.n < 18) return { error: `only ${best.n} of 25 hour rules found` };
  // Refine on the rules actually found, dropping the worst outlier until every rule sits on the
  // line — a label column's rule can sit within 2 px of where 00:00 would be.
  let found = best.hits.map((c, k) => (c === undefined ? null : [k, c])).filter(Boolean);
  let grid;
  for (;;) {
    const meanK = found.reduce((t, [k]) => t + k, 0) / found.length, meanC = found.reduce((t, [, c]) => t + c, 0) / found.length;
    step = found.reduce((t, [k, c]) => t + (k - meanK) * (c - meanC), 0) / found.reduce((t, [k]) => t + (k - meanK) ** 2, 0);
    const origin = meanC - step * meanK;
    grid = Array.from({ length: 25 }, (_, k) => origin + k * step);
    const residuals = found.map(([k, c]) => Math.abs(c - grid[k]));
    const worst = Math.max(...residuals);
    if (worst <= 1.2) break;
    found = found.filter((_, i) => residuals[i] !== worst);
    if (found.length < 18) return { error: 'hour rules unevenly spaced' };
  }
  if (grid[24] > width - 1 || grid[0] < width * 0.05) return { error: 'time grid outside the picture' };

  // Horizontal rules, read in the subqueue label column just left of the time grid: across the
  // grid itself a busy day's fills cover the rule between two subqueues that are both off.
  // Scaled down to 800 px the 1-px rules blend into the fill beside them — a black rule between
  // two orange cells comes out dark orange — so a rule is a dip in brightness, not a colour.
  const labelFrom = Math.round(grid[0] - step * 0.9), labelTo = Math.round(grid[0] - step * 0.1);
  const luma = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = labelFrom; x <= labelTo; x++) { const [r, g, b] = image.pixel(x, y); sum += 0.299 * r + 0.587 * g + 0.114 * b; }
    luma.push(sum / (labelTo - labelFrom + 1));
  }
  const lineRow = (y) => luma[y] < 90 || luma[y] < Math.min(luma[Math.max(0, y - 2)], luma[Math.min(height - 1, y + 2)]) - 30;
  const bands = [];
  for (let y = 0; y < height; y++) {
    if (lineRow(y)) continue;
    const y0 = y; while (y < height && !lineRow(y)) y++;
    if (y - y0 >= 5) bands.push({ y0, y1: y - 1 });
  }
  // The header band (rotated time labels) is the first and tallest above the body.
  const body = bands.filter((b) => b.y0 > height * 0.18);
  const rowsFound = body.filter((b) => b.y1 - b.y0 + 1 <= height * 0.12);
  if (rowsFound.length !== 12) return { error: `${rowsFound.length} rows` };

  const rows = [];
  for (const band of rowsFound) {
    const y = Math.round((band.y0 + band.y1) / 2);
    // The row's own colour, from its label cell left of the time grid.
    const labelX = Math.round(grid[0] - step * 0.5);
    const label = image.pixel(labelX, y);
    if (kind(label) !== 'colour') return { error: `row at y=${y}: label cell is not coloured` };
    const labelHue = hue(label);
    const slots = [];
    for (let h = 0; h < 24; h++) {
      for (const half of [0.27, 0.73]) {
        const x = Math.round(grid[h] + (grid[h + 1] - grid[h]) * half);
        // Along the row, not across it: a row is ~11 px tall and its rules are 1 px off either way.
        const samples = [[x - 2, y], [x - 1, y], [x, y], [x + 1, y], [x + 2, y]].map(([sx, sy]) => image.pixel(sx, sy));
        const kinds = samples.map(kind);
        if (kinds.every((k) => k === 'white')) { slots.push('on'); continue; }
        if (kinds.every((k) => k === 'colour') && samples.every((p) => hueGap(hue(p), labelHue) <= 25)) { slots.push('off'); continue; }
        return { error: `row at y=${y}, ${String(h).padStart(2, '0')}:${half < 0.5 ? '00' : '30'}: neither white nor the row's colour (${kinds.join(',')})` };
      }
    }
    rows.push(slots);
  }
  return { rows };
}

export function readZakarpattiaPicture(bytes) {
  return readGrid(decodeJpeg(bytes));
}
