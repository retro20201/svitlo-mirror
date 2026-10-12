/**
 * Fetches the Bila Tserkva council's rename table from the Internet Archive.
 *
 *   node tools/addr/aliases/fetch-wayback.mjs <outDir> [--resume]
 *
 * bc-rada.gov.ua/node/5527 holds the council's table of renamed streets (2016: 66 objects;
 * 28.07.2022: 84 objects; amendment of 27.06.2024), but the live site now serves only a
 * placeholder. The Wayback Machine has copies; this asks its CDX index for the captures of that
 * page, newest first, and keeps the first whose HTML really is the table. It fetches the `id_`
 * form of a capture — the page as the council served it, without the Wayback toolbar and without
 * every link rewritten — and records which capture it took, so the source table can cite it.
 * At most MAX_TRIES captures are opened, one by one.
 */
import { createClient, decodeBody, isMain, openRawFolder, parseArgs, reportRun } from './http.mjs';

export const TARGET = 'https://bc-rada.gov.ua/node/5527';
const CDX = 'https://web.archive.org/cdx/search/cdx';
const MAX_TRIES = 8;

export const cdxUrl = (target = TARGET) =>
  `${CDX}?${new URLSearchParams({ url: target.replace(/^https?:\/\//, ''), output: 'json', fl: 'timestamp,statuscode,digest,length', filter: 'statuscode:200', collapse: 'digest' })}`;

export const captureUrl = (timestamp, target = TARGET) => `https://web.archive.org/web/${timestamp}id_/${target}`;

/** CDX JSON (a header row, then rows) → captures, newest first. */
export function parseCdx(text) {
  let rows;
  try { rows = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const [head, ...data] = rows;
  const at = (name) => head.indexOf(name);
  return data
    .map((r) => ({ timestamp: r[at('timestamp')], digest: r[at('digest')], length: Number(r[at('length')]) }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Why this capture is not the rename table, or null. */
export function checkTable(buf) {
  if (buf.length < 100000) return `only ${buf.length} bytes`;
  const text = decodeBody(buf);
  if (!/<table/i.test(text)) return 'no table';
  if (!/перейменув/i.test(text)) return 'no word перейменув';
  return null;
}

export async function run(outDir, { resume = false, client = createClient({ minDelayMs: 2000, jitterMs: 1000, baseBackoffMs: 15000, maxAttempts: 4 }) } = {}) {
  const folder = await openRawFolder(outDir, { source: 'bila-tserkva', tool: 'fetch-wayback.mjs', resume });
  const rel = 'node-5527.html';
  if (resume && (await folder.has(rel))) return folder.finish();
  try {
    const list = await client.get(cdxUrl(), { validate: (buf) => (parseCdx(buf.toString('utf8')).length ? null : 'CDX lists no captures') });
    const captures = parseCdx(list.body.toString('utf8'));
    process.stderr.write(`CDX: ${captures.length} distinct captures, newest ${captures[0].timestamp}\n`);
    const tried = [];
    for (const cap of captures.slice(0, MAX_TRIES)) {
      const url = captureUrl(cap.timestamp);
      try {
        const res = await client.get(url, { validate: checkTable, attempts: 3 });
        const entry = await folder.save(rel, res.body, { url, finalUrl: res.url, status: res.status, attempts: res.attempts, snapshot: cap.timestamp, cdxLength: cap.length, capturesTried: [...tried, cap.timestamp] });
        process.stderr.write(`ok ${rel} ${entry.bytes} bytes from capture ${cap.timestamp}\n`);
        return folder.finish({ captures: captures.length });
      } catch (err) {
        tried.push(`${cap.timestamp}: ${err.reason || err.message}`);
        process.stderr.write(`  capture ${cap.timestamp} rejected: ${err.reason || err.message}\n`);
      }
    }
    throw new Error(`none of the ${tried.length} newest captures is the table (${tried.join('; ')})`);
  } catch (err) {
    await folder.fail(rel, cdxUrl(), err.message);
    process.stderr.write(`FAILED ${rel}: ${err.message}\n`);
  }
  return folder.finish();
}

if (isMain(import.meta.url)) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional[0]) { process.stderr.write('usage: fetch-wayback.mjs <outDir> [--resume]\n'); process.exit(64); }
  run(positional[0], { resume: !!flags.resume })
    .then((m) => process.exit(reportRun(m)))
    .catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
