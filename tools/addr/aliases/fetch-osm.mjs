/**
 * Fetches the OpenStreetMap ways that carry an `old_name*` tag, one Overpass query per city.
 *
 *   node tools/addr/aliases/fetch-osm.mjs <outDir> [--resume] [--only=boryspil,dnipro] [--list]
 *
 * Writes <outDir>/<city>.json (the Overpass answer as received) plus manifest.json. Queries run
 * strictly one at a time with a pause between them, after asking /api/status whether a slot is
 * free. The main instance often answers 504 for a heavy query; this backs off and retries, and
 * only after that goes to a public mirror (the manifest says which server served each file).
 *
 * The filter is `[highway][name]` plus ANY key starting with `old_name` — old_name, old_name:uk,
 * old_name:ru and the dated variants (old_name:uk:1985-2015) — because a plain `[old_name]` would
 * miss the dated ones. `out tags center` returns the tags and one point per way. The point is the
 * only thing that tells a street of the town itself from a village street the same area or box
 * also covers (Obukhiv, Fastiv and Pereyaslav are whole hromadas), so the later parser can keep
 * the town's own.
 *
 * ODbL 1.0: © OpenStreetMap contributors. Anything published from this must credit them.
 */
import { createClient, decodeBody, isMain, openRawFolder, parseArgs, reportRun, sleep } from './http.mjs';

export const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

/**
 * Kyiv is Phase 2 and absent on purpose. `relation` = OSM boundary relation (area id =
 * 3600000000 + id); `bbox` = south,west,north,east. Relation ids come from the research runs; the
 * three hromada ones cover villages too.
 */
export const OSM_AREAS = [
  { id: 'bila-tserkva', name: 'Біла Церква', relation: 2069683 },
  { id: 'brovary', name: 'Бровари', relation: 1929810 },
  { id: 'boryspil', name: 'Бориспіль', relation: 1934961 },
  { id: 'irpin', name: 'Ірпінь', relation: 11092577 },
  { id: 'bucha', name: 'Буча', relation: 2265598 },
  { id: 'vyshhorod', name: 'Вишгород', relation: 421865 },
  { id: 'vasylkiv', name: 'Васильків', relation: 4740389 },
  { id: 'obukhiv', name: 'Обухів (громада)', relation: 12744970 },
  { id: 'fastiv', name: 'Фастів (громада)', relation: 12544244 },
  { id: 'pereyaslav', name: 'Переяслав (громада)', relation: 11824920 },
  { id: 'dnipro', name: 'Дніпро', bbox: [48.33, 34.80, 48.62, 35.30] },
  { id: 'kamianske', name: "Кам'янське", bbox: [48.40, 34.45, 48.62, 34.80] },
  { id: 'kryvyi-rih', name: 'Кривий Ріг', bbox: [47.80, 33.20, 48.12, 33.65] },
  { id: 'nikopol', name: 'Нікополь', bbox: [47.50, 34.30, 47.62, 34.50] },
  { id: 'pavlohrad', name: 'Павлоград', bbox: [48.48, 35.80, 48.60, 36.00] },
  { id: 'khmelnytskyi', name: 'Хмельницький', bbox: [49.34, 26.90, 49.52, 27.12] },
  { id: 'odesa', name: 'Одеса', bbox: [46.33, 30.55, 46.60, 30.90] },
  { id: 'izmail', name: 'Ізмаїл', bbox: [45.31, 28.78, 45.40, 28.92] },
  { id: 'chornomorsk', name: 'Чорноморськ', bbox: [46.27, 30.60, 46.36, 30.72] },
  { id: 'bilhorod-dnistrovskyi', name: 'Білгород-Дністровський', bbox: [46.15, 30.28, 46.23, 30.40] },
  { id: 'podilsk', name: 'Подільськ', bbox: [47.72, 29.50, 47.80, 29.60] }
];

const FILTER = '["highway"]["name"][~"^old_name"~"."]';

export function overpassQuery(area, timeout = 180) {
  const head = `[out:json][timeout:${timeout}];`;
  const tail = 'out tags center;';
  if (area.relation) return `${head}area(id:${3600000000 + area.relation})->.a;way(area.a)${FILTER};${tail}`;
  return `${head}way(${area.bbox.join(',')})${FILTER};${tail}`;
}

/**
 * Why this body is not a complete answer, or null. Overpass reports a query that ran out of time
 * or memory with a 200 and a `remark`, and the elements it did manage to return — a partial
 * answer that looks like a small city. That must never be saved as a download.
 */
export function checkOverpassAnswer(buf) {
  let json;
  try { json = JSON.parse(decodeBody(buf)); } catch { return `not JSON (${buf.subarray(0, 60).toString('utf8').replace(/\s+/g, ' ')})`; }
  if (!Array.isArray(json.elements)) return 'no elements array';
  if (json.remark && /runtime error|timed out|out of memory|too many|rate_limit/i.test(json.remark)) return `remark: ${json.remark}`;
  if (!json.osm3s?.timestamp_osm_base) return 'no timestamp_osm_base';
  return null;
}

/** "N slots available now." → 0; "Slot available after: …, in 12 seconds." → 12 (a wait in seconds). */
export function parseSlotWait(statusText) {
  if (/slots? available now/i.test(statusText)) return 0;
  const m = /in (\d+) seconds?/i.exec(statusText);
  return m ? Number(m[1]) : 0;
}

export async function run(outDir, { resume = false, only = null, pauseMs = 8000, servers = OVERPASS, client = createClient({ minDelayMs: 2000, jitterMs: 1000, baseBackoffMs: 30000, maxBackoffMs: 120000, timeoutMs: 200000, maxAttempts: 4 }) } = {}) {
  const folder = await openRawFolder(outDir, { source: 'osm', tool: 'fetch-osm.mjs', resume });
  const areas = OSM_AREAS.filter((a) => !only || only.includes(a.id));
  let first = true;
  for (const area of areas) {
    const rel = `${area.id}.json`;
    if (resume && (await folder.has(rel))) continue;
    if (!first) await sleep(pauseMs);
    first = false;
    const query = overpassQuery(area);
    let saved = false;
    let lastError = '';
    for (const server of servers) {
      const status = await client.get(server.replace(/interpreter$/, 'status'), { attempts: 2, backoffBase: 5000 }).then((r) => r.body.toString('utf8'), () => '');
      const wait = parseSlotWait(status);
      if (wait) { process.stderr.write(`  no free slot on ${new URL(server).host}; waiting ${wait}s\n`); await sleep((wait + 1) * 1000); }
      try {
        const res = await client.get(server, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          validate: checkOverpassAnswer
        });
        const json = JSON.parse(res.body.toString('utf8'));
        const entry = await folder.save(rel, res.body, {
          url: server, status: res.status, attempts: res.attempts, query, name: area.name,
          ways: json.elements.length, osmBase: json.osm3s.timestamp_osm_base
        });
        process.stderr.write(`ok ${rel} ${entry.bytes} bytes, ${entry.ways} ways, OSM base ${entry.osmBase} (${new URL(server).host})\n`);
        saved = true;
        break;
      } catch (err) {
        lastError = err.message;
        process.stderr.write(`  ${area.id} on ${new URL(server).host}: ${err.message}\n`);
      }
    }
    if (!saved) {
      await folder.fail(rel, servers[0], lastError);
      process.stderr.write(`FAILED ${rel}\n`);
    }
  }
  return folder.finish();
}

if (isMain(import.meta.url)) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.list) { for (const a of OSM_AREAS) console.log(a.id, a.relation ?? a.bbox.join(','), a.name); process.exit(0); }
  if (!positional[0]) { process.stderr.write('usage: fetch-osm.mjs <outDir> [--resume] [--only=id,id] [--list]\n'); process.exit(64); }
  run(positional[0], { resume: !!flags.resume, only: flags.only ? String(flags.only).split(',') : null })
    .then((m) => process.exit(reportRun(m)))
    .catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
