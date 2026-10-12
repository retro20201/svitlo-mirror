/**
 * Fetches the plain-file sources: one council or ODA document per entry, each source into its own
 * folder.
 *
 *   node tools/addr/aliases/fetch-files.mjs <source> <outDir> [--resume]
 *
 *   odesa-oda      Odesa ODA order 830/А-2024 (PDF, has a text layer)
 *   boryspil       three Boryspil council decisions (HTML tables old | new)
 *   brovary        annex of Brovary decision 713-26-08 (DOCX)
 *   bucha          Bucha hromada street list of 04.09.2024 (PDF)
 *   khmelnytskyi   annex 3 of Khmelnytskyi decision 24/2008 as amended (DOCX)
 *   rename-dp      rename.dp.ua JSON of Dnipro renames: CROSS-CHECK ONLY, no licence stated
 *
 * (Bila Tserkva is only reachable through the Wayback Machine: fetch-wayback.mjs.)
 *
 * Every file is checked for being complete before it is kept: a PDF must end in %%EOF, a DOCX must
 * be a zip with word/document.xml, a JSON must parse, an HTML page must hold a table. These are
 * public documents behind unremarkable web servers, so the User-Agent is the descriptive one; if a
 * host still refuses it with a 403 the file is tried once more with a browser-like one and the
 * manifest says so.
 */
import { readZipEntry } from '../../lib/xlsx.mjs';
import { createClient, decodeBody, FetchError, isMain, openRawFolder, parseArgs, reportRun, UA_BROWSER, UA_POLITE } from './http.mjs';

const BORYSPIL = 'https://borispol-rada.gov.ua/item/';

export const FILE_SOURCES = {
  'odesa-oda': {
    files: [{ path: '830-a-2024.pdf', kind: 'pdf', approxBytes: 326021, url: 'https://oda.od.gov.ua/strapi/uploads/0830_a24_01251505c5.pdf' }]
  },
  boryspil: {
    files: [
      { path: '42-2-vii.html', kind: 'html', approxBytes: 384447, url: `${BORYSPIL}23005-17-grudnya-2015-roku-42-2-vii-pro-perejmenuvannya-okremikh-vulits-provulkiv-ploshchi-ta-vodnogo-ob-ektu-mista-borispolya.html` },
      { path: '249-4-vii.html', kind: 'html', approxBytes: 354864, url: `${BORYSPIL}23506-28-sichnya-2016-roku-249-4-vii-pro-vnesennya-zmin-do-rishennya-miskoji-radi-vid-17-12-2015-42-2-vii-pro-perejmenuvannya-okremikh-vulits-provulkiv-ploshchi-ta-vodnogo-ob-ektu-mista-borispolya.html` },
      { path: '1792-23-viii.html', kind: 'html', approxBytes: 381759, url: `${BORYSPIL}52424-19-kvitnia-2022-roku-179223viii-pro-pereimenuvannia-okremykh-vulyts-ta-provulkiv-boryspilskoi-miskoi-terytorialnoi-hromady.html` }
    ]
  },
  brovary: {
    files: [{ path: '713-26-08-annex.docx', kind: 'docx', approxBytes: 16523, url: 'https://normacts.brovary-rada.gov.ua/files/103616' }]
  },
  bucha: {
    files: [{ path: 'perelik-04-09-24.pdf', kind: 'pdf', approxBytes: 460019, url: 'https://bucha-rada.gov.ua/sites/default/files/novyy_perelik_vulyc_gromady_onovleno_04.09.24.pdf' }]
  },
  khmelnytskyi: {
    files: [{ path: 'decision-24-2008-annex3.docx', kind: 'docx', approxBytes: 325971, url: 'https://khm.gov.ua/sites/default/files/council/05172408_zm_3.docx' }]
  },
  'rename-dp': {
    files: [{ path: 'rename.json', kind: 'json', approxBytes: 289000, url: 'https://rename.dp.ua/rename.json' }]
  }
};

/** Why these bytes are not a complete document of `kind`, or null. */
export function checkFile(kind, buf) {
  if (buf.length < 1000) return `only ${buf.length} bytes`;
  switch (kind) {
    case 'pdf':
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return 'not a PDF';
      if (!buf.subarray(-2048).toString('latin1').includes('%%EOF')) return 'PDF is cut short (no %%EOF)';
      return null;
    case 'docx':
      if (buf.readUInt32LE(0) !== 0x04034b50) return 'not a zip';
      try { readZipEntry(buf, 'word/document.xml'); } catch (err) { return `no word/document.xml (${err.message})`; }
      return null;
    case 'json':
      try { JSON.parse(buf.toString('utf8')); } catch { return 'not JSON'; }
      return null;
    case 'html': {
      const text = decodeBody(buf);
      if (!/<html/i.test(text)) return 'not HTML';
      if (!/<table/i.test(text)) return 'no table in the page';
      return null;
    }
    default:
      return `unknown kind ${kind}`;
  }
}

export async function run(source, outDir, { resume = false, client = createClient({ minDelayMs: 1500, jitterMs: 500, baseBackoffMs: 8000, maxAttempts: 4 }) } = {}) {
  const spec = FILE_SOURCES[source];
  if (!spec) throw new Error(`unknown source "${source}"; one of ${Object.keys(FILE_SOURCES).join(', ')}`);
  const folder = await openRawFolder(outDir, { source, tool: 'fetch-files.mjs', userAgent: UA_POLITE, resume });
  for (const file of spec.files) {
    if (resume && (await folder.has(file.path))) continue;
    const validate = (buf) => checkFile(file.kind, buf);
    let userAgent = UA_POLITE;
    let res = null;
    let failure = null;
    try {
      res = await client.get(file.url, { validate });
    } catch (err) {
      failure = err;
      if (err instanceof FetchError && err.status === 403) {
        process.stderr.write(`  ${file.path}: refused the descriptive User-Agent; trying a browser-like one\n`);
        try { res = await client.get(file.url, { validate, userAgent: UA_BROWSER }); userAgent = UA_BROWSER; failure = null; } catch (err2) { failure = err2; }
      }
    }
    if (!res) {
      await folder.fail(file.path, file.url, failure.message);
      process.stderr.write(`FAILED ${file.path}: ${failure.message}\n`);
      continue;
    }
    const entry = await folder.save(file.path, res.body, {
      url: file.url, finalUrl: res.url, status: res.status, attempts: res.attempts, kind: file.kind,
      contentType: res.headers.get('content-type'), lastModified: res.headers.get('last-modified'),
      expectedBytes: file.approxBytes, userAgent
    });
    const drift = Math.abs(entry.bytes - file.approxBytes) / file.approxBytes;
    process.stderr.write(`ok ${file.path} ${entry.bytes} bytes${drift > 0.1 ? ` (expected about ${file.approxBytes})` : ''}\n`);
  }
  return folder.finish();
}

if (isMain(import.meta.url)) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (positional.length < 2) { process.stderr.write(`usage: fetch-files.mjs <${Object.keys(FILE_SOURCES).join('|')}> <outDir> [--resume]\n`); process.exit(64); }
  run(positional[0], positional[1], { resume: !!flags.resume })
    .then((m) => process.exit(reportRun(m)))
    .catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
