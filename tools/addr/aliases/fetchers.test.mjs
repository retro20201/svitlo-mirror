import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { FILE_SOURCES, checkFile } from './fetch-files.mjs';
import { OSM_AREAS, checkOverpassAnswer, overpassQuery, parseSlotWait } from './fetch-osm.mjs';
import { RADA_ACTS, checkRadaPage, radaUrl } from './fetch-rada.mjs';
import { TARGET, captureUrl, cdxUrl, checkTable, parseCdx } from './fetch-wayback.mjs';
import { WIKI_SETS, checkWikiAnswer, wikiUrl } from './fetch-wikipedia.mjs';
import { docxRows, htmlTableRows, odaPairs, osmStats, pairRows, radaRenames } from './verify-raw.mjs';

// --- what is fetched ------------------------------------------------------------------------

/** Every URL any fetcher can request. */
function allUrls() {
  return [
    ...Object.keys(RADA_ACTS).map(radaUrl),
    ...Object.keys(WIKI_SETS).map((s) => wikiUrl(s)),
    ...OSM_AREAS.length ? ['https://overpass-api.de/api/interpreter'] : [],
    ...Object.values(FILE_SOURCES).flatMap((s) => s.files.map((f) => f.url)),
    cdxUrl(), captureUrl('20260101000000')
  ];
}

test('only the approved Phase 1 hosts are ever contacted, and never an operator', () => {
  const allowed = new Set([
    'zakon.rada.gov.ua', 'uk.wikipedia.org', 'ru.wikipedia.org', 'overpass-api.de', 'oda.od.gov.ua',
    'borispol-rada.gov.ua', 'normacts.brovary-rada.gov.ua', 'bucha-rada.gov.ua', 'khm.gov.ua', 'rename.dp.ua',
    'web.archive.org'
  ]);
  for (const url of allUrls()) {
    const host = new URL(url).hostname;
    assert.ok(allowed.has(host), `${host} is not an approved source`);
    assert.doesNotMatch(host, /dtek|oblenergo|hoe\.com\.ua|yasno|svitlo/i);
  }
});

test('the phase 2 sources are not fetched: no Kyiv OSM, no kmr_xml, no kyiv-streets', () => {
  assert.ok(!OSM_AREAS.some((a) => /kyiv|київ/i.test(a.id) && !/oblast/.test(a.id)));
  for (const url of allUrls()) assert.doesNotMatch(url, /kmr_xml|kyiv-streets|data\.gov\.ua|jsdelivr/);
  assert.ok(!OSM_AREAS.some((a) => a.relation === 421866));
});

test('the Rada list is the twelve acts of the design', () => {
  assert.deepEqual(Object.keys(RADA_ACTS), ['984-19', '1037-19', '1353-19', '1374-19', '1375-19', '1377-19', '1465-19', '1467-19', '251-20', '3984-20', '4008-20', '4483-20']);
  assert.equal(radaUrl('984-19'), 'https://zakon.rada.gov.ua/laws/show/984-19/print');
});

test('Wikipedia sets: 33 Kyiv pages, 10 other uk pages, 1 ru page, one request each', () => {
  assert.equal(WIKI_SETS.kyiv.titles.length, 33);
  assert.equal(new Set(WIKI_SETS.kyiv.titles).size, 33);
  assert.equal(WIKI_SETS['uk-other'].titles.length, 10);
  assert.deepEqual(WIKI_SETS['ru-odesa'].titles, ['Список улиц Одессы']);
  const url = new URL(wikiUrl('kyiv'));
  assert.equal(url.hostname, 'uk.wikipedia.org');
  assert.equal(url.searchParams.get('titles').split('|').length, 33);
  assert.equal(url.searchParams.get('rvprop'), 'content|ids|timestamp');
  assert.equal(url.searchParams.get('formatversion'), '2');
  assert.equal(new URL(wikiUrl('ru-odesa')).hostname, 'ru.wikipedia.org');
});

test('Overpass areas: 21 unique cities, each with a relation or a sane box', () => {
  assert.equal(OSM_AREAS.length, 21);
  assert.equal(new Set(OSM_AREAS.map((a) => a.id)).size, 21);
  for (const a of OSM_AREAS) {
    assert.ok(Boolean(a.relation) !== Boolean(a.bbox), `${a.id}: exactly one of relation and bbox`);
    if (a.bbox) {
      const [s, w, n, e] = a.bbox;
      assert.ok(s < n && w < e && s > 44 && n < 53 && w > 22 && e < 41, `${a.id}: box inside Ukraine`);
      assert.ok((n - s) * (e - w) < 0.2, `${a.id}: a city, not an oblast`);
    }
  }
});

test('Overpass queries: relation → area, box → bbox; any old_name* key; tags and a point per way', () => {
  assert.equal(
    overpassQuery({ relation: 1934961 }),
    '[out:json][timeout:180];area(id:3601934961)->.a;way(area.a)["highway"]["name"][~"^old_name"~"."];out tags center;'
  );
  assert.equal(
    overpassQuery({ bbox: [48.33, 34.8, 48.62, 35.3] }, 120),
    '[out:json][timeout:120];way(48.33,34.8,48.62,35.3)["highway"]["name"][~"^old_name"~"."];out tags center;'
  );
});

test('an Overpass answer that ran out of time is not a download, even with a 200 and elements', () => {
  const now = Date.parse('2026-10-12T16:00:00Z');
  const ok = JSON.stringify({ osm3s: { timestamp_osm_base: '2026-10-12T15:44:36Z' }, elements: [{ type: 'way', tags: { name: 'x' } }] });
  assert.equal(checkOverpassAnswer(Buffer.from(ok), { now }), null);
  // A mirror that serves a five-month-old planet is as bad as a partial answer.
  const stale = JSON.stringify({ osm3s: { timestamp_osm_base: '2026-05-06T03:25:00Z' }, elements: [{ type: 'way', tags: { name: 'x' } }] });
  assert.match(checkOverpassAnswer(Buffer.from(stale), { now }), /older than 3 days/);
  const partial = JSON.stringify({ osm3s: { timestamp_osm_base: 'x' }, remark: 'runtime error: Query timed out in "query" at line 1 after 181 seconds.', elements: [{}] });
  assert.match(checkOverpassAnswer(Buffer.from(partial)), /remark: runtime error/);
  assert.match(checkOverpassAnswer(Buffer.from('<html><body>Too Many Requests</body></html>')), /not JSON/);
  assert.match(checkOverpassAnswer(Buffer.from('{"elements": []}'), { now }), /timestamp_osm_base/);
});

test('the Overpass status text says whether to wait', () => {
  assert.equal(parseSlotWait('Rate limit: 4\n4 slots available now.\n'), 0);
  assert.equal(parseSlotWait('Rate limit: 4\nSlot available after: 2026-10-12T15:44:50Z, in 12 seconds.\n'), 12);
  assert.equal(parseSlotWait(''), 0);
});

test('a Wikipedia answer must hold every page asked for, with text', () => {
  const titles = WIKI_SETS['ru-odesa'].titles;
  const page = (extra = {}) => ({ title: titles[0], revisions: [{ slots: { main: { content: 'x'.repeat(600) } } }], ...extra });
  const body = (o) => Buffer.from(JSON.stringify(o));
  assert.equal(checkWikiAnswer(body({ query: { pages: [page()] } }), 'ru-odesa'), null);
  assert.match(checkWikiAnswer(body({ query: { pages: [page({ missing: true })] } }), 'ru-odesa'), /missing/);
  assert.match(checkWikiAnswer(body({ query: { pages: [] } }), 'ru-odesa'), /0 pages instead of 1/);
  assert.match(checkWikiAnswer(body({ error: { code: 'ratelimited' } }), 'ru-odesa'), /ratelimited/);
  assert.match(checkWikiAnswer(Buffer.from('<html>'), 'ru-odesa'), /not JSON/);
});

test('Rada pages: a challenge or error page is rejected, an act is kept', () => {
  assert.match(checkRadaPage(Buffer.from('<html>blocked</html>')), /only \d+ bytes/);
  const act = `<html><head><title>x</title></head><body>${'Верховна Рада України постановляє '.repeat(400)}</body></html>`;
  assert.equal(checkRadaPage(Buffer.from(act)), null);
  assert.match(checkRadaPage(Buffer.from(`<html>${'lorem ipsum '.repeat(1000)}</html>`)), /no act text/);
});

test('Wayback: CDX rows come back newest first, and only the real table is accepted', () => {
  const cdx = JSON.stringify([['timestamp', 'statuscode', 'digest', 'length'], ['20220101000000', '200', 'A', '9'], ['20260101000000', '200', 'B', '8'], ['20240601000000', '200', 'C', '7']]);
  assert.deepEqual(parseCdx(cdx).map((c) => c.timestamp), ['20260101000000', '20240601000000', '20220101000000']);
  assert.deepEqual(parseCdx('[]'), []);
  assert.deepEqual(parseCdx('<html>'), []);
  assert.match(checkTable(Buffer.from('<table>перейменування</table>')), /only/);
  const page = `<table><tr><td>перейменування</td></tr></table>${' '.repeat(100001)}`;
  assert.equal(checkTable(Buffer.from(page)), null);
  assert.equal(captureUrl('20240101000000'), `https://web.archive.org/web/20240101000000id_/${TARGET}`);
  assert.match(cdxUrl(), /url=bc-rada\.gov\.ua%2Fnode%2F5527/);
});

// --- file checks -----------------------------------------------------------------------------

/** A stored (uncompressed) or deflated zip of { name: Buffer }, just enough for the central directory reader. */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const row = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
const docx = (body) => zipOf({ 'word/document.xml': Buffer.from(`<w:document><w:body><w:tbl>${body}</w:tbl></w:body></w:document>`) });

test('a DOCX is read into table rows, with entities decoded and blank rows left blank', () => {
  const buf = docx(row('№', 'Стара назва', 'Нова назва') + row('1', 'вул. Леніна', 'вул. Шевченка &amp; Ко') + row('', '', ''));
  const rows = docxRows(buf);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['1', 'вул. Леніна', 'вул. Шевченка & Ко']);
  assert.equal(pairRows(rows).length, 2, 'the header and the data row have two filled cells; the blank one none');
});

test('file checks: truncated PDF, wrong magic, a zip without document.xml, bad JSON, a page without a table', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 32), Buffer.from('\n%%EOF\n')]);
  assert.equal(checkFile('pdf', pdf), null);
  assert.match(checkFile('pdf', pdf.subarray(0, 1500)), /cut short/);
  assert.match(checkFile('pdf', Buffer.concat([Buffer.from('<html>'), Buffer.alloc(2000, 32)])), /not a PDF/);
  assert.equal(checkFile('docx', Buffer.concat([docx(row('a', 'b')), Buffer.alloc(1000)])), null);
  assert.match(checkFile('docx', zipOf({ 'other.xml': randomBytes(1200) })), /no word\/document\.xml/);
  assert.match(checkFile('docx', Buffer.alloc(1500, 97)), /not a zip/);
  assert.equal(checkFile('json', Buffer.from(JSON.stringify(Array(300).fill({ a: 1 })))), null);
  assert.match(checkFile('json', Buffer.from(`<html>${' '.repeat(1100)}`)), /not JSON/);
  assert.match(checkFile('html', Buffer.from(`<html>${' '.repeat(1100)}</html>`)), /no table/);
  assert.equal(checkFile('html', Buffer.from(`<html><table>${' '.repeat(1100)}</table></html>`)), null);
  assert.match(checkFile('pdf', Buffer.from('%PDF-')), /only 5 bytes/);
});

test('the file sources match the design: six sources, three Boryspil acts, nothing else', () => {
  assert.deepEqual(Object.keys(FILE_SOURCES), ['odesa-oda', 'boryspil', 'brovary', 'bucha', 'khmelnytskyi', 'rename-dp']);
  assert.equal(FILE_SOURCES.boryspil.files.length, 3);
  assert.deepEqual(FILE_SOURCES.boryspil.files.map((f) => f.path), ['42-2-vii.html', '249-4-vii.html', '1792-23-viii.html']);
});

// --- smoke counters ---------------------------------------------------------------------------

test('HTML council tables: rows with two filled cells are rename pairs, junk rows are not', () => {
  const html = `<table>
    <tr><td>№</td><td>Стара назва</td><td>Нова назва</td></tr>
    <tr><td>1</td><td><p>вул.&nbsp;Леніна</p></td><td>вул. Шевченка</td></tr>
    <tr><td>2</td><td></td><td>&nbsp;</td></tr>
    <tr><td colspan="3"><span style="mso-x:y">Додаток 1</span></td></tr></table>`;
  const rows = htmlTableRows(html);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], ['1', 'вул. Леніна', 'вул. Шевченка']);
  assert.equal(pairRows(rows).length, 2);
});

test('Rada rename sentences are counted across the wordings the acts use', () => {
  const text = `1. Перейменувати:
    село Жовтневе Васильківського району на село Нове;
    селище міського типу Орджонікідзе на місто Покров;
    місто Южне на місто Південне.`;
  assert.equal(radaRenames(text), 3);
  assert.equal(radaRenames('Про перейменування міста Дніпродзержинськ'), 0);
});

test('Odesa order pairs are half the street-type words, so rows run together by the text layer still count', () => {
  const text = 'місто Одеса\nВулиця Адмірала Лазарева Вулиця Михайла Болтенка\nПровулок Бадаєва Провулок Марії Станішевської\nГагарінське плато Аркадійське плато\nВулиця Генерала Петрова Вулиця Євгенія ТанцюриВулиця Генерала Ратова Вулиця Генерала Швигіна';
  assert.equal(odaPairs(text), 4);
});

test('Overpass stats count ways, names, old_name keys and points', () => {
  const stats = osmStats({
    osm3s: { timestamp_osm_base: 'T' },
    elements: [
      { tags: { name: 'A', old_name: 'a', 'old_name:ru': 'а', 'old_name:uk': 'a' }, center: { lat: 1, lon: 1 } },
      { tags: { name: 'A', old_name: 'a' }, center: { lat: 1, lon: 1 } },
      { tags: { name: 'B', 'old_name:uk:1985-2015': 'b' } }
    ]
  });
  assert.deepEqual(stats, { ways: 3, distinctNames: 2, withOldRu: 1, withOldUk: 3, withCenter: 2, oldNameKeys: ['old_name', 'old_name:ru', 'old_name:uk', 'old_name:uk:1985-2015'], osmBase: 'T' });
});
