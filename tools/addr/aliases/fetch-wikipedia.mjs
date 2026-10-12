/**
 * Fetches street-rename pages from uk.wikipedia / ru.wikipedia as wikitext, through the MediaWiki
 * API, one request per set.
 *
 *   node tools/addr/aliases/fetch-wikipedia.mjs <set> <outDir> [--resume]
 *
 * Sets, each into its own folder:
 *   kyiv       the 33 «Список вулиць Києва» pages              → kyiv-33-pages.json
 *   uk-other   Dnipro, Kryvyi Rih, Nikopol, Pavlohrad, Odesa, Boryspil, Vasylkiv, Khmelnytskyi and
 *              the two settlement-rename lists (10 pages)      → uk-10-pages.json
 *   ru-odesa   ru.wikipedia «Список улиц Одессы»               → ru-odesa.json
 *
 * The API answer is saved as received (formatversion 2, wikitext under
 * query.pages[].revisions[0].slots.main.content). `rvprop` asks for the revision id and timestamp
 * as well as the text: the text is CC BY-SA 4.0, and the revision it was taken from is what a
 * credit line and the committed source tables need to point at. Pages are never merged or edited.
 */
import { createClient, decodeBody, isMain, openRawFolder, parseArgs, reportRun } from './http.mjs';

const KYIV_LETTERS = ['А', 'Б', 'В', 'Г', 'Ґ', 'Д', 'Е', 'Є', 'Ж', 'З', 'І', 'Ї', 'Й', 'К', 'Л', 'М', 'Н', 'О', 'П', 'Р', 'С', 'Т', 'У', 'Ф', 'Х', 'Ц', 'Ч', 'Ш', 'Щ', 'Ю', 'Я'];

export const WIKI_SETS = {
  kyiv: {
    lang: 'uk',
    file: 'kyiv-33-pages.json',
    titles: [...KYIV_LETTERS.map((l) => `Список вулиць Києва (${l})`), 'Список вулиць Києва (лінії)', 'Список вулиць Києва (Садові)']
  },
  'uk-other': {
    lang: 'uk',
    file: 'uk-10-pages.json',
    titles: [
      'Вулиці Дніпра', 'Вулиці Кривого Рогу', 'Вулиці Нікополя', 'Вулиці Павлограда', 'Вулиці Одеси',
      'Вулиці Борисполя', 'Список перейменованих вулиць Василькова', 'Вулиці Хмельницького',
      'Список топонімів України, перейменованих внаслідок декомунізації',
      'Список топонімів України, перейменованих внаслідок деколонізації'
    ]
  },
  'ru-odesa': { lang: 'ru', file: 'ru-odesa.json', titles: ['Список улиц Одессы'] }
};

export function wikiUrl(set, extra = {}) {
  const { lang, titles } = WIKI_SETS[set];
  const q = new URLSearchParams({
    action: 'query', prop: 'revisions', rvprop: 'content|ids|timestamp', rvslots: 'main',
    format: 'json', formatversion: '2', utf8: '1', titles: titles.join('|'), ...extra
  });
  return `https://${lang}.wikipedia.org/w/api.php?${q}`;
}

/**
 * Why this API answer is not the set, or null: not JSON, an API error, a page that does not exist
 * or has no text, or a page count other than the titles asked for.
 */
export function checkWikiAnswer(buf, set) {
  let json;
  try { json = JSON.parse(decodeBody(buf)); } catch { return 'not JSON'; }
  if (json.error) return `API error ${json.error.code}`;
  const pages = json.query?.pages;
  if (!Array.isArray(pages)) return 'no query.pages';
  const want = WIKI_SETS[set].titles.length;
  if (pages.length !== want) return `${pages.length} pages instead of ${want}`;
  for (const p of pages) {
    if (p.missing) return `page missing: ${p.title}`;
    const text = p.revisions?.[0]?.slots?.main?.content;
    if (typeof text !== 'string' || text.length < 500) return `no text for ${p.title}`;
  }
  return null;
}

export async function run(set, outDir, { resume = false, client = createClient({ minDelayMs: 1500, jitterMs: 500, baseBackoffMs: 15000 }) } = {}) {
  if (!WIKI_SETS[set]) throw new Error(`unknown set "${set}"; one of ${Object.keys(WIKI_SETS).join(', ')}`);
  const folder = await openRawFolder(outDir, { source: `wikipedia-${set}`, tool: 'fetch-wikipedia.mjs', resume });
  const { file } = WIKI_SETS[set];
  if (resume && (await folder.has(file))) return folder.finish();
  const url = wikiUrl(set);
  try {
    const res = await client.get(url, { validate: (buf) => checkWikiAnswer(buf, set), headers: { accept: 'application/json' } });
    const json = JSON.parse(res.body.toString('utf8'));
    const revisions = Object.fromEntries(json.query.pages.map((p) => [p.title, { revid: p.revisions[0].revid, timestamp: p.revisions[0].timestamp }]));
    const entry = await folder.save(file, res.body, { url, status: res.status, attempts: res.attempts, pages: json.query.pages.length, revisions });
    process.stderr.write(`ok ${file} ${entry.bytes} bytes, ${entry.pages} pages\n`);
  } catch (err) {
    await folder.fail(file, url, err.message);
    process.stderr.write(`FAILED ${file}: ${err.message}\n`);
  }
  return folder.finish();
}

if (isMain(import.meta.url)) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (positional.length < 2) { process.stderr.write(`usage: fetch-wikipedia.mjs <${Object.keys(WIKI_SETS).join('|')}> <outDir> [--resume]\n`); process.exit(64); }
  run(positional[0], positional[1], { resume: !!flags.resume })
    .then((m) => process.exit(reportRun(m)))
    .catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
