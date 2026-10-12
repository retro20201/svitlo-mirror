/**
 * A .docx as paragraphs and tables of plain text, with no dependencies (the zip reader of
 * tools/lib/xlsx.mjs does the unpacking). Only `word/document.xml` is read; it is data, never run.
 */
import { readZipEntry, decodeXml } from '../../lib/xlsx.mjs';

const text = (xml) => decodeXml([...xml.replace(/<\/w:p>/g, '<w:tab/>').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] === undefined ? ' ' : m[1])).join(''))
  .replace(/[\s ]+/g, ' ').trim();

/** `[{ kind: 'p', text }, { kind: 'table', rows: [[cell…]…] }]` in document order. */
export function readDocx(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml').toString('utf8');
  const body = xml.slice(xml.indexOf('<w:body'));
  const blocks = [];
  let at = 0;
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
  for (const m of body.matchAll(re)) {
    if (m.index < at) continue;
    if (m[1] !== undefined) {
      const rows = [...m[1].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((tr) =>
        [...tr[0].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((tc) => text(tc[1])));
      blocks.push({ kind: 'table', rows });
      at = m.index + m[0].length;
    } else {
      const t = text(m[0]);
      if (t) blocks.push({ kind: 'p', text: t });
    }
  }
  return blocks;
}
