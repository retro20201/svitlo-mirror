/**
 * Fetches the twelve Verkhovna Rada acts that rename settlements in the Kyiv, Dnipropetrovsk,
 * Odesa and Khmelnytskyi oblasts (2016, 2019, 2024, 2025), as the printable HTML of each.
 *
 *   node tools/addr/aliases/fetch-rada.mjs <outDir> [--resume] [--only=984-19,1037-19]
 *
 * Writes <outDir>/<act>.html plus manifest.json. <outDir> must be a new, empty folder outside the
 * repo. zakon.rada.gov.ua resets the connection of a non-browser User-Agent on /print and fails
 * intermittently with 403/502 for a browser one; on 2026-10-12 it also never completed a handshake
 * with Node's own fetch (ECONNRESET / connect timeout) while the same request through curl came
 * back in a second. So this sends a Chrome User-Agent through curl, takes compressed responses and
 * retries slowly; a 200 that is not the act is retried too.
 */
import { createClient, decodeBody, isMain, openRawFolder, parseArgs, reportRun, UA_BROWSER } from './http.mjs';

/** act URL code → how the act is numbered in the text ("№ 984-VIII"). */
export const RADA_ACTS = {
  '984-19': '984-VIII',
  '1037-19': '1037-VIII',
  '1353-19': '1353-VIII',
  '1374-19': '1374-VIII',
  '1375-19': '1375-VIII',
  '1377-19': '1377-VIII',
  '1465-19': '1465-VIII',
  '1467-19': '1467-VIII',
  '251-20': '251-IX',
  '3984-20': '3984-IX',
  '4008-20': '4008-IX',
  '4483-20': '4483-IX'
};

export const radaUrl = (act) => `https://zakon.rada.gov.ua/laws/show/${act}/print`;

/**
 * Why this body is not the act, or null. The smallest real /print page is about 12 KB; the error
 * and challenge pages the site serves with a 200 are far smaller and carry no act text.
 */
export function checkRadaPage(buf) {
  if (buf.length < 8000) return `only ${buf.length} bytes`;
  const text = decodeBody(buf);
  if (!/<html/i.test(text)) return 'not HTML';
  if (!/(Верховн\S+\s+Рад|ПОСТАНОВА|ЗАКОН)/.test(text)) return 'no act text in it';
  return null;
}

export async function run(outDir, { resume = false, only = null, client = createClient({ userAgent: UA_BROWSER, transport: 'curl', minDelayMs: 1500, jitterMs: 1000, baseBackoffMs: 8000 }) } = {}) {
  const folder = await openRawFolder(outDir, { source: 'rada', tool: 'fetch-rada.mjs', userAgent: UA_BROWSER, resume });
  for (const act of Object.keys(RADA_ACTS)) {
    if (only && !only.includes(act)) continue;
    const rel = `${act}.html`;
    if (resume && (await folder.has(rel))) continue;
    const url = radaUrl(act);
    try {
      const res = await client.get(url, { validate: checkRadaPage, headers: { accept: 'text/html', 'accept-language': 'uk,en;q=0.5' } });
      const entry = await folder.save(rel, res.body, { url, status: res.status, contentType: res.headers.get('content-type'), attempts: res.attempts });
      process.stderr.write(`ok ${rel} ${entry.bytes} bytes (attempt ${res.attempts})\n`);
    } catch (err) {
      await folder.fail(rel, url, err.message);
      process.stderr.write(`FAILED ${rel}: ${err.message}\n`);
    }
  }
  return folder.finish();
}

if (isMain(import.meta.url)) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional[0]) { process.stderr.write('usage: fetch-rada.mjs <outDir> [--resume] [--only=act,act]\n'); process.exit(64); }
  run(positional[0], { resume: !!flags.resume, only: flags.only ? String(flags.only).split(',') : null })
    .then((m) => process.exit(reportRun(m)))
    .catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
