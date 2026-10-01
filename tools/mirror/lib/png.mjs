import { inflateSync } from 'node:zlib';

/**
 * Just enough of PNG to read the schedule pictures operators publish: 8-bit, non-interlaced,
 * greyscale, RGB or RGBA. Those pictures are drawn by software and saved losslessly, so a cell's
 * colour comes back exactly as the operator's renderer painted it — which is what makes reading
 * them by colour sound, where OCR on a photo would not be. Anything else throws, rather than
 * returning pixels that are not what the operator drew.
 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** PNG bytes → `{ width, height, pixel(x, y) → [r, g, b] }`. */
export function decodePng(bytes) {
  const data = Buffer.from(bytes);
  if (!data.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let width, height, channels;
  const idat = [];
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      channels = CHANNELS[colour];
      if (depth !== 8 || !channels || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}, interlace ${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (!width || !idat.length) throw new Error('PNG without image data');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error('PNG image data has the wrong length');

  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[i - channels] : 0;
      const up = prior[i];
      const upLeft = i >= channels ? prior[i - channels] : 0;
      let predicted;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: predicted = paeth(left, up, upLeft); break;
        default: throw new Error(`PNG filter ${filter}`);
      }
      out[i] = (line[i] + predicted) & 0xff;
    }
  }

  return {
    width,
    height,
    pixel(x, y) {
      const at = y * stride + x * channels;
      return channels < 3
        ? [pixels[at], pixels[at], pixels[at]]
        : [pixels[at], pixels[at + 1], pixels[at + 2]];
    }
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
