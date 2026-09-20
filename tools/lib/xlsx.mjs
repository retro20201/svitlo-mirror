/**
 * Just enough .xlsx to read a sheet as a grid of text, with no dependencies.
 *
 * Two kinds of workbook turn up in this project and they store text differently: the operators'
 * hand-filled schedule sheets write every value inline as `<is><t>`, while files exported from
 * Excel put the text in a shared table and leave `<v>` holding an index into it. A reader that
 * knows only the first kind returns a grid of numbers that look like data and are not, so both
 * are handled here rather than in each caller.
 */
import { inflateRawSync } from 'node:zlib';

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (whole, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return XML_ENTITIES[name] ?? whole;
  });
}

/** "AW" → 49. */
export function columnIndex(letters) {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index;
}

/**
 * Pulls one entry out of the .xlsx zip.
 *
 * The central directory is read rather than the local headers because a writer that streams its
 * output leaves the local header's sizes zeroed and puts the real ones in a trailing data
 * descriptor — only the central directory can be trusted to say how long an entry is.
 */
export function readZipEntry(buffer, wanted) {
  let eocd = -1;
  // The end-of-central-directory record is last, but a trailing comment can push it back by up to
  // 64 KiB, so it has to be searched for rather than read from a fixed offset.
  for (let at = buffer.length - 22; at >= 0 && at > buffer.length - 65558; at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const entries = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    if (name === wanted) {
      // The local header repeats the name and extra field at its own lengths, which need not match
      // the central directory's, so the data offset is computed from the local header.
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      return method === 0 ? data : inflateRawSync(data);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wanted} missing from workbook`);
}

/** `sharedStrings.xml` → the table `t="s"` cells index into. Absent in hand-filled sheets. */
export function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) =>
    // A single <si> can be split across several runs; the string is their concatenation.
    decodeXml([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))
  );
}

/**
 * `sheet1.xml` → `grid[row][column]` of trimmed cell text, 1-based on both axes.
 *
 * Cell references are honoured where present and a running column cursor covers writers that omit
 * them. A `t="s"` cell holds an index into `shared`, not a value: resolving it is the difference
 * between a street name and the number 2817.
 */
export function parseSheet(xml, shared = []) {
  const grid = [];
  const rows = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  for (let row; (row = rows.exec(xml)); ) {
    const rowIndex = Number(/\br="(\d+)"/.exec(row[1])?.[1]);
    if (!rowIndex || row[2] === undefined) continue;

    const cells = [];
    let nextColumn = 1;
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (let cell; (cell = cellPattern.exec(row[2])); ) {
      const attributes = cell[1];
      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const column = reference ? columnIndex(reference) : nextColumn;
      nextColumn = column + 1;

      const body = cell[2] ?? '';
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      const inline = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('');

      let value;
      if (type === 's') value = shared[Number(raw)] ?? '';
      else value = decodeXml(inline || raw);
      cells[column] = value.trim();
    }
    grid[rowIndex] = cells;
  }
  return grid;
}

/** The whole job: workbook bytes → grid, shared strings resolved if the file has them. */
export function sheetGrid(buffer, sheet = 'xl/worksheets/sheet1.xml') {
  let shared = [];
  try {
    shared = parseSharedStrings(readZipEntry(buffer, 'xl/sharedStrings.xml').toString('utf8'));
  } catch {
    // No shared table: the sheet stores its text inline, which parseSheet reads directly.
  }
  return parseSheet(readZipEntry(buffer, sheet).toString('utf8'), shared);
}
