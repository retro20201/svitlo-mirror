/**
 * Reading a schedule grid out of a picture by colour, for operators that publish nothing else.
 *
 * Built for the inneti «poweron» renderer (Волинь, Закарпаття): flat cells in exactly two colours
 * separated by white lines, header rows in the dark colour with white text. Nothing about the
 * geometry is assumed — Волинь's picture went from 1920 to 1750 px wide between December 2025
 * and April 2026, and fixed coordinates read the December one a column off. Rows are found as
 * horizontal bands of cell colour between white separators, cells as runs of one colour along a
 * line just inside the top of each band, above any text.
 *
 * Every cell must be one of the two colours exactly (within `tolerance`, for the odd
 * anti-aliased edge). A cell in any other colour throws: an operator that changes its palette
 * should break the region loudly, not have its new colour read as light.
 */
export function readGrids(image, { on, off, slots, rows, tolerance = 10, minCell = 12 }) {
  const near = (pixel, colour) => colour.every((value, i) => Math.abs(pixel[i] - value) <= tolerance);
  const classify = (x, y) => {
    const pixel = image.pixel(x, y);
    if (near(pixel, on)) return 'on';
    if (near(pixel, off)) return 'off';
    return pixel.every((value) => value >= 235) ? 'white' : 'other';
  };

  // A line of the picture belongs to a grid row when most of it is cell colour. The white lines
  // between rows break that everywhere except under a merged label cell, a few percent wide.
  const bands = [];
  for (let y = 0; y < image.height; y++) {
    if (!isBandLine(y)) continue;
    const top = y;
    while (y < image.height && isBandLine(y)) y++;
    if (y - top >= minCell) bands.push({ top, bottom: y });
  }

  function isBandLine(y) {
    let cells = 0;
    for (let x = 0; x < image.width; x++) {
      const kind = classify(x, y);
      if (kind === 'on' || kind === 'off') cells++;
    }
    return cells >= image.width * 0.4;
  }

  /** Runs of one cell colour along line `y`, white-separated, at least `minCell` long. */
  function runsAt(y) {
    const runs = [];
    for (let x = 0; x < image.width; x++) {
      const kind = classify(x, y);
      if (kind !== 'on' && kind !== 'off') continue;
      const start = x;
      while (x < image.width && classify(x, y) === kind) x++;
      if (x - start >= minCell) runs.push({ start, end: x, state: kind });
    }
    return runs;
  }

  // A header is a band of nothing but dark cells, the last `slots` of them all one width — the
  // time columns. Its own text sits lower in the cell, so the line just under its top is clean.
  const isHeader = (band) => {
    const runs = runsAt(band.top + 2);
    if (runs.length < slots || runs.some((run) => run.state !== 'off')) return null;
    const columns = runs.slice(-slots);
    const widths = columns.map((run) => run.end - run.start);
    return Math.max(...widths) - Math.min(...widths) <= 3 ? columns : null;
  };

  const grids = [];
  for (let i = 0; i < bands.length; i++) {
    const columns = isHeader(bands[i]);
    if (!columns) continue;
    const body = bands.slice(i + 1, i + 1 + rows);
    if (body.length !== rows || body.some(isHeader)) {
      throw new Error(`a grid header at y=${bands[i].top} is followed by ${body.length} rows, not ${rows}`);
    }
    grids.push(body.map(({ top, bottom }) => columns.map((column) => {
      // The centre and four points around it: a cell is flat colour, so all five must agree.
      const cx = Math.floor((column.start + column.end) / 2);
      const cy = Math.floor((top + bottom) / 2);
      const dx = Math.floor((column.end - column.start) / 4);
      const dy = Math.floor((bottom - top) / 4);
      const states = [[cx, cy], [cx - dx, cy], [cx + dx, cy], [cx, cy - dy], [cx, cy + dy]]
        .map(([x, y]) => classify(x, y));
      if (states.some((state) => state !== states[0]) || (states[0] !== 'on' && states[0] !== 'off')) {
        throw new Error(`cell at x=${cx}, y=${cy} is not a flat schedule colour (${states.join(',')})`);
      }
      return states[0];
    })));
    i += rows;
  }
  return grids;
}
