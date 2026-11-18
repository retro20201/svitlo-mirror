#!/usr/bin/env node
/**
 * «Зарядки»: the public chargers of TOKA whose address the address dictionary can put on a черга — `v1/ev/toka.json`.
 *
 * What nobody else shows about a charger is WHEN it will have power: the networks' own apps say whether a station is up
 * right now, and only the schedule says what the next hours hold. A station's address gives its черга (v1/addr, the same
 * dictionary the app finds a person's own queue with), and the app works the rest out on the phone from the region's
 * table — nothing here is read every cycle, and nothing of it changes when the schedule does.
 *
 * Where it comes from:
 *   GET https://toka.energy/map/stations        → [{ id, lat, lng, is_public, is_worked, rating }]   one request
 *   GET https://toka.energy/map/stations/{id}   → { name, address, ports[] }                           one per station
 * the two addresses TOKA's own web map reads, with no key. Details change rarely, so they are kept (`--cache`) and only
 * stations not seen before are asked for — ONE AT A TIME with a pause: six at once got HTTP 429 on half of them.
 *
 * How an address becomes a черга. By the rules the charger map of «Бензин Поруч» already uses — BenzUA's
 * tools/fetch/outage-queue.mjs, passed as `--resolver`, so the two never disagree about a charger. It refuses to guess:
 * a street whose type disagrees, a house that is not in the operator's list, a settlement named in another oblast all
 * come back with no queue, and such a station is left out. One thing is added here: a house the operator feeds by
 * several lines (`x/`) is left out too — which of its queues the charger hangs on nobody can say.
 *
 * A manual job, like the address harvest, and for the same reason: run it after the dictionary is rebuilt.
 *
 *   node tools/ev/build-toka.mjs --resolver ../BenzUA/tools/fetch/outage-queue.mjs [--seed ../BenzUA/tools/fetch/out/toka-details.json]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ADDR = join(ROOT, 'firebase', 'public', 'v1', 'addr');
const OUT = join(ROOT, 'firebase', 'public', 'v1', 'ev', 'toka.json');
const ADDR_URL = 'https://koly-svitlo.web.app/v1/addr';

export const LIST_URL = 'https://toka.energy/map/stations';
const HEADERS = { 'User-Agent': 'koly-svitlo-mirror (+https://koly-svitlo.web.app)', Accept: 'application/json', 'Accept-Language': 'uk-UA,uk;q=0.9' };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The dictionary as the resolver asks for it, answered from the files in this tree: no request leaves the machine. */
export function localAddrFetch(root = ADDR, base = ADDR_URL) {
  return async (url) => {
    const address = String(url);
    if (!address.startsWith(`${base}/`)) return new Response('', { status: 404 });
    try {
      const body = await readFile(join(root, decodeURIComponent(address.slice(base.length + 1).split('?')[0])), 'utf8');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      return new Response('', { status: 404 });
    }
  };
}

/** The strongest port and whether any of them is a fast one: what a driver chooses a station by. */
export function powerOf(detail) {
  const powers = (detail?.ports ?? []).map((port) => Number(port.power)).filter((kw) => Number.isFinite(kw) && kw > 0);
  const kw = powers.length ? Math.max(...powers) : null;
  return { kw, dc: kw !== null && kw >= 40 };
}

/**
 * A station a passing driver cannot use: TOKA lists them as public and says so only in the name — «[тільки для мешканців]»,
 * «[доступ обмежено]», «[доступ за перепускою]» (33 of the 273 on a queue, 18 November 2026).
 */
export const isRestricted = (name) => /\[[^\]]*(?:тільки для|доступ|обмежен)[^\]]*\]/iu.test(String(name ?? ''));

/** A station as the app reads it; null without the things it cannot do without. */
export function entryOf(row, detail, outage) {
  const address = String(detail?.address ?? '').trim();
  if (!outage?.region || !outage?.queue || !address) return null;
  if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lng)) return null;
  return {
    id: row.id,
    name: String(detail?.name ?? '').trim() || `TOKA #${row.id}`,
    address,
    lat: Math.round(row.lat * 1e5) / 1e5,
    lng: Math.round(row.lng * 1e5) / 1e5,
    region: outage.region,
    queue: outage.queue,
    ...powerOf(detail)
  };
}

const readJSON = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

/** Whether the operator feeds the house the resolver matched by several lines (`x/<street>.json`). */
export async function onSeveralLines(trace, root = ADDR) {
  if (!trace?.region || !trace.street || !trace.key) return false;
  let dir = join(root, trace.region);
  if (trace.settlement) {
    const settlements = await readJSON(join(dir, 'settlements.json'));
    const at = Array.isArray(settlements) ? settlements.indexOf(trace.settlement) : -1;
    if (at < 0) return false;
    dir = join(dir, 'c', String(at));
  }
  const streets = await readJSON(join(dir, 'streets.json'));
  const index = Array.isArray(streets) ? streets.indexOf(trace.street) : -1;
  if (index < 0) return false;
  const several = await readJSON(join(dir, 'x', `${index}.json`));
  return Boolean(several && Object.hasOwn(several, trace.key));
}

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : null;
}

async function main() {
  const resolverPath = option('resolver');
  if (!resolverPath) throw new Error('--resolver <path to BenzUA/tools/fetch/outage-queue.mjs> is required');
  const { resolveOutage, createDictionary } = await import(pathToFileURL(resolve(resolverPath)).href);
  const cacheDir = resolve(option('cache') ?? join(HERE, '.cache'));
  await mkdir(cacheDir, { recursive: true });
  const detailsFile = join(cacheDir, 'toka-details.json');
  const details = (await readJSON(detailsFile)) ?? {};
  // Another harvest's details — the charger map's own cache — to start from, so stations it has seen are not asked for again.
  const seed = option('seed') ? await readJSON(resolve(option('seed'))) : null;
  for (const [id, record] of Object.entries(seed ?? {})) details[id] ??= record;

  const response = await fetch(LIST_URL, { headers: HEADERS });
  if (!response.ok) throw new Error(`toka list HTTP ${response.status}`);
  const list = (await response.json()).filter((row) => Number.isFinite(row?.id) && row.is_public !== false);
  const unseen = list.filter((row) => !details[row.id]?.detail);
  console.log(`toka: ${list.length} public stations, ${unseen.length} without details`);
  const pause = Number(option('delay') ?? 800);
  for (const [done, row] of unseen.entries()) {
    const answer = await fetch(`${LIST_URL}/${row.id}`, { headers: HEADERS });
    if (answer.status === 429) { console.log(`toka: 429 at station ${row.id} after ${done} — the rest waits for the next run`); break; }
    if (answer.ok) details[row.id] = { fetchedAt: Date.now(), detail: await answer.json() };
    if ((done + 1) % 25 === 0) { console.log(`toka: ${done + 1}/${unseen.length}`); await writeFile(detailsFile, JSON.stringify(details), 'utf8'); }
    await sleep(pause);
  }
  await writeFile(detailsFile, JSON.stringify(details), 'utf8');

  const dictionary = createDictionary({ cacheDir: join(cacheDir, 'addr'), fetchImpl: localAddrFetch(), baseURL: ADDR_URL, delayMs: 0 });
  const stations = [];
  const reasons = {};
  const count = (reason) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  for (const row of list) {
    const detail = details[row.id]?.detail;
    if (!detail?.address) { count('no address'); continue; }
    if (isRestricted(detail.name)) { count('restricted access'); continue; }
    const found = await resolveOutage(String(detail.address), row.lat, row.lng, dictionary);
    if (!found.outage) { count(found.reason ?? 'no queue'); continue; }
    if (await onSeveralLines(found.trace?.[0])) { count('house on several lines'); continue; }
    const entry = entryOf(row, detail, found.outage);
    if (entry) stations.push(entry); else count('incomplete');
  }
  stations.sort((a, b) => a.region.localeCompare(b.region) || a.id - b.id);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ source: 'toka', updatedAt: new Date().toISOString(), stations }), 'utf8');

  const byRegion = {};
  for (const station of stations) byRegion[station.region] = (byRegion[station.region] ?? 0) + 1;
  console.log(`toka: ${stations.length} of ${list.length} on a queue`, byRegion);
  console.log('left out:', reasons);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
