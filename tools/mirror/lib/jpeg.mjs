/**
 * Just enough of JPEG to read the schedule pictures operators post to Telegram: baseline
 * (SOF0), 8-bit, Huffman-coded, greyscale or YCbCr with any sampling, restart markers allowed.
 * Telegram re-encodes every photo that way. Progressive or arithmetic-coded files throw rather
 * than return pixels that are not what the operator drew.
 *
 * Same interface as `png.mjs`: `{ width, height, pixel(x, y) → [r, g, b] }`.
 */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63
];

/** cos((2x + 1)uπ / 16) · C(u) / 2, precomputed for the separable inverse DCT. */
const IDCT = (() => {
  const table = new Float64Array(64);
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      table[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2;
    }
  }
  return table;
})();

export function decodeJpeg(bytes) {
  const data = Buffer.from(bytes);
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('not a JPEG');

  const quant = [];
  const huffman = { dc: [], ac: [] };
  let frame = null;
  let restartInterval = 0;

  let at = 2;
  while (at < data.length) {
    if (data[at] !== 0xff) throw new Error(`JPEG marker expected at ${at}`);
    const marker = data[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd9) break;
    const length = data.readUInt16BE(at + 2);
    const body = data.subarray(at + 4, at + 2 + length);
    if (marker === 0xdb) {
      for (let i = 0; i < body.length;) {
        const precision = body[i] >> 4;
        const id = body[i] & 15;
        const table = new Int32Array(64);
        for (let k = 0; k < 64; k++) table[ZIGZAG[k]] = precision ? body.readUInt16BE(i + 1 + 2 * k) : body[i + 1 + k];
        quant[id] = table;
        i += 1 + 64 * (precision ? 2 : 1);
      }
    } else if (marker === 0xc0) {
      const components = [];
      for (let i = 0; i < body[5]; i++) {
        const base = 6 + i * 3;
        components.push({ id: body[base], h: body[base + 1] >> 4, v: body[base + 1] & 15, tq: body[base + 2] });
      }
      frame = { height: body.readUInt16BE(1), width: body.readUInt16BE(3), components };
      if (body[0] !== 8) throw new Error(`JPEG precision ${body[0]}`);
    } else if (marker >= 0xc1 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error(`unsupported JPEG frame 0x${marker.toString(16)} (only baseline)`);
    } else if (marker === 0xc4) {
      for (let i = 0; i < body.length;) {
        const kind = body[i] >> 4 ? 'ac' : 'dc';
        const id = body[i] & 15;
        const counts = body.subarray(i + 1, i + 17);
        const total = counts.reduce((sum, n) => sum + n, 0);
        huffman[kind][id] = buildHuffman(counts, body.subarray(i + 17, i + 17 + total));
        i += 17 + total;
      }
    } else if (marker === 0xdd) {
      restartInterval = body.readUInt16BE(0);
    } else if (marker === 0xda) {
      if (!frame) throw new Error('JPEG scan before frame');
      const scan = [];
      for (let i = 0; i < body[0]; i++) {
        const component = frame.components.find((c) => c.id === body[1 + i * 2]);
        component.td = body[2 + i * 2] >> 4;
        component.ta = body[2 + i * 2] & 15;
        scan.push(component);
      }
      at = decodeScan(data, at + 2 + length, frame, scan, quant, huffman, restartInterval);
      continue;
    }
    at += 2 + length;
  }
  if (!frame?.components[0].pixels) throw new Error('JPEG without image data');
  return toImage(frame);
}

/** Canonical Huffman codes → a map keyed by (length << 16 | code). */
function buildHuffman(counts, symbols) {
  const map = new Map();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) map.set((length << 16) | code++, symbols[k++]);
    code <<= 1;
  }
  return map;
}

function decodeScan(data, start, frame, scan, quant, huffman, restartInterval) {
  const hMax = Math.max(...frame.components.map((c) => c.h));
  const vMax = Math.max(...frame.components.map((c) => c.v));
  const mcusX = Math.ceil(frame.width / (8 * hMax));
  const mcusY = Math.ceil(frame.height / (8 * vMax));
  for (const c of frame.components) {
    c.stride = mcusX * c.h * 8;
    c.pixels = new Uint8ClampedArray(c.stride * mcusY * c.v * 8);
    c.pred = 0;
  }

  let at = start;
  let bits = 0;
  let count = 0;
  const readBit = () => {
    if (count === 0) {
      let byte = data[at++];
      if (byte === 0xff) {
        const next = data[at++];
        if (next !== 0) throw new Error(`JPEG marker 0xff${next.toString(16)} inside entropy data`);
      }
      bits = byte;
      count = 8;
    }
    count--;
    return (bits >> count) & 1;
  };
  const receive = (n) => {
    let value = 0;
    for (let i = 0; i < n; i++) value = (value << 1) | readBit();
    return value;
  };
  const extend = (value, n) => (n && value < 1 << (n - 1) ? value - (1 << n) + 1 : value);
  const decodeSymbol = (table) => {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | readBit();
      const symbol = table.get((length << 16) | code);
      if (symbol !== undefined) return symbol;
    }
    throw new Error('bad JPEG Huffman code');
  };

  const block = new Float64Array(64);
  const temp = new Float64Array(64);
  const decodeBlock = (c, bx, by) => {
    block.fill(0);
    const q = quant[c.tq];
    const size = decodeSymbol(huffman.dc[c.td]);
    c.pred += extend(receive(size), size);
    block[0] = c.pred * q[0];
    for (let k = 1; k < 64;) {
      const rs = decodeSymbol(huffman.ac[c.ta]);
      const run = rs >> 4;
      const s = rs & 15;
      if (s === 0) {
        if (run === 15) { k += 16; continue; }
        break;
      }
      k += run;
      if (k > 63) throw new Error('JPEG AC run past the block');
      const z = ZIGZAG[k];
      block[z] = extend(receive(s), s) * q[z];
      k++;
    }
    // Separable inverse DCT: rows, then columns.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += IDCT[x * 8 + u] * block[y * 8 + u];
        temp[y * 8 + x] = sum;
      }
    }
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let v = 0; v < 8; v++) sum += IDCT[y * 8 + v] * temp[v * 8 + x];
        c.pixels[(by * 8 + y) * c.stride + bx * 8 + x] = Math.round(sum + 128);
      }
    }
  };

  let mcu = 0;
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval && mcu && mcu % restartInterval === 0) {
        // Byte-align, then step over the RSTn marker and reset the DC predictors.
        count = 0;
        while (at < data.length && !(data[at] === 0xff && data[at + 1] >= 0xd0 && data[at + 1] <= 0xd7)) at++;
        at += 2;
        for (const c of scan) c.pred = 0;
      }
      for (const c of scan) {
        for (let v = 0; v < c.v; v++) {
          for (let h = 0; h < c.h; h++) decodeBlock(c, mx * c.h + h, my * c.v + v);
        }
      }
      mcu++;
    }
  }
  for (const c of frame.components) {
    c.scaleX = c.h / hMax;
    c.scaleY = c.v / vMax;
  }
  // Skip to the next marker that is not a restart or stuffing.
  while (at < data.length - 1 && !(data[at] === 0xff && data[at + 1] !== 0 && !(data[at + 1] >= 0xd0 && data[at + 1] <= 0xd7))) at++;
  return at;
}

function toImage({ width, height, components }) {
  const sample = (c, x, y) => c.pixels[Math.floor(y * c.scaleY) * c.stride + Math.floor(x * c.scaleX)];
  return {
    width,
    height,
    pixel(x, y) {
      if (components.length === 1) {
        const g = sample(components[0], x, y);
        return [g, g, g];
      }
      const Y = sample(components[0], x, y);
      const Cb = sample(components[1], x, y) - 128;
      const Cr = sample(components[2], x, y) - 128;
      const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
      return [clamp(Y + 1.402 * Cr), clamp(Y - 0.344136 * Cb - 0.714136 * Cr), clamp(Y + 1.772 * Cb)];
    }
  };
}
