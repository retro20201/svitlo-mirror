/**
 * Builds the address→черга dictionary that lets the app work out a user's queue from their address,
 * instead of asking them to know it. ДТЕК exposes this on its own outage page:
 *
 *   POST /ua/ajax  method=getStreets                          -> every street (city) or {settlement: [streets]}
 *   POST /ua/ajax  method=getHomeNum&data[0][name]=street...  -> EVERY house on that street + its черга
 *
 * The second call is per *street*, not per address, so a whole city costs one request per street.
 * Both work out of season, when no schedule is published yet.
 *
 * Output shape, published next to the schedules:
 *   v1/addr/<region>/streets.json   ["вул. Абрикосова", ...]      index i -> file i
 *   v1/addr/<region>/s/<i>.json     {"12": "GPV19.1", "12А": ...}
 *   v1/addr/<region>/x/<i>.json     {"95": ["GPV5.1", "GPV3.1"]}   only streets that need it
 * One small file per street keeps the phone's download to ~1 KB at onboarding instead of megabytes.
 *
 * `sub_type_reason` is a list, not a value: a building fed by two or three lines gets one черга per
 * line (12% of Kyiv houses in the 2026-10-01 harvest, up to four lines; ДТЕК/Yasno say outright
 * that one address can carry two schedules). `s/` keeps only the first, which is the contract app
 * 1.0.2 and earlier decode as `[String: String]` and must keep working. The full list goes to
 * `x/`, written only for streets where some house has more than one line, so newer apps fetch it
 * and a 404 means "single line".
 *
 * `--fresh` rebuilds into `<region>.new/` and swaps it in only once every listed street is there,
 * so a re-harvest that dies never touches the published region. It resumes a `.new/` only when
 * that is the same harvest (see claimNew); anything else needs `--resume` to be kept.
 *
 * Run manually (or monthly); the output is committed. Not part of the 10-minute mirror.
 *   node tools/addr/build-addresses.mjs --region=kyiv [--limit=20] [--headful] [--fresh [--resume]]
 */
import { mkdir, writeFile, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './chrome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REGIONS = {
  // Kyiv city: getStreets returns a flat array, and getHomeNum needs only the street.
  kyiv: { host: 'https://www.dtek-kem.com.ua', shape: 'flat' },
  // Oblast operators return {settlement: [streets]}, and getHomeNum needs a `city` entry alongside
  // `street` (verified against dtek-oem: the settlement parameter really is named "city").
  'kyiv-region': { host: 'https://www.dtek-krem.com.ua', shape: 'nested' },
  dnipro: { host: 'https://www.dtek-dnem.com.ua', shape: 'nested' },
  odesa: { host: 'https://www.dtek-oem.com.ua', shape: 'nested' }
};

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = true] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const regionId = args.region || 'kyiv';
const region = REGIONS[regionId];
if (!region) {
  console.error(`unknown region "${regionId}"; known: ${Object.keys(REGIONS).join(', ')}`);
  process.exit(1);
}
const limit = args.limit ? Number(args.limit) : Infinity;

/** Everything below runs inside the page: only there do the WAF cookies and the CSRF token exist. */
const PAGE_AJAX = `
  window.__ajax = async function (body) {
    const tok = document.querySelector('meta[name=csrf-token]').content;
    const r = await fetch('/ua/ajax', {
      method: 'POST', credentials: 'include',
      headers: {
        'X-CSRF-Token': tok,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body
    });
    return r.json();
  };
  return true;
`;

/**
 * Writes a file whole or not at all: into a dot-file beside it, then renamed over it. A plain
 * write truncates first, so a kill mid-write leaves a cut-off list, or a cut-off street file that
 * a resume then skips as done. Hosting skips dot-files, so a temp file left by a kill is never
 * published.
 */
async function writeWhole(file, text) {
  const temp = join(dirname(file), `.${basename(file)}.tmp`);
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

/** Every published list of a region, hashed: what a `.new/` was built on. */
async function listsHash(dir) {
  const hash = createHash('sha1');
  const add = async (rel) => hash.update(`${rel}\n${await readFile(join(dir, rel), 'utf8').catch(() => '')}\n`);
  await add('streets.json');
  await add('settlements.json');
  for (const c of (await readdir(join(dir, 'c')).catch(() => [])).sort()) await add(join('c', c, 'streets.json'));
  return hash.digest('hex');
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Starts a `--fresh` run's `.new/`, or resumes it only if it is the same harvest.
 *
 * Every street already in `.new/` is skipped and then swapped in as current, so resuming is right
 * only for the interrupted run it was started by. `.harvest.json` (a dot-file, so never deployed)
 * records when that was, whether it was a `--limit` test, and which published lists it built on.
 * A `.new/` with no record, a test's `.new/` under a full run, one more than a day old, or one
 * whose published lists have changed since (a git pull, a plain run) would swap in streets from
 * two harvests as one, so it is refused unless `--resume` says to keep it.
 */
async function claimNew(finalDir, outDir) {
  const marker = join(outDir, '.harvest.json');
  const base = await listsHash(finalDir);
  if (await stat(outDir).catch(() => null)) {
    const record = await readFile(marker, 'utf8').then(JSON.parse).catch(() => null);
    const why = !record ? 'nothing records when it was started'
      : record.limit && limit === Infinity ? 'it holds a --limit test'
      : Date.now() - Date.parse(record.started) > DAY ? `it was started ${record.started}`
      : record.base !== base ? `${basename(finalDir)}/ has changed since it was started`
      : null;
    if (!why || args.resume) return;
    throw new Error(`${basename(outDir)}/ is left from an earlier run and ${why}; resuming it would swap in ` +
      'streets from two harvests as one. Delete it to start clean, or pass --resume to keep it.');
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(marker, JSON.stringify({ started: new Date().toISOString(), limit: limit !== Infinity, base }), 'utf8');
}

async function main() {
  const finalDir = join(ROOT, 'firebase', 'public', 'v1', 'addr', regionId);
  const outDir = args.fresh ? `${finalDir}.new` : finalDir;
  if (args.fresh) await claimNew(finalDir, outDir);
  await mkdir(outDir, { recursive: true });

  const browser = await launch({ headless: !args.headful });
  try {
    const page = await browser.open(`${region.host}/ua/shutdowns`);
    // The WAF answers with a JS challenge first; the real page only appears once it resolves.
    // A cold Chrome start plus that challenge can take the better part of a minute, so this waits
    // far longer than a normal page load would need.
    await page.waitForSelector('meta[name=csrf-token]', 90000);
    await page.evaluate(PAGE_AJAX);

    const raw = await page.evaluate(`return (await window.__ajax('method=getStreets')).streets;`);
    if (!raw) throw new Error('getStreets returned nothing');

    /**
     * One street: fetch its houses, retrying, and write its files. Returns true if it had data.
     * `s/` gets the first line of every house; `x/` the full list, for houses with more than one.
     */
    const fetchStreet = async (street, city, file) => {
      const cityParam = city
        ? `data%5B0%5D%5Bname%5D=city&data%5B0%5D%5Bvalue%5D=' + encodeURIComponent(${JSON.stringify(city)}) + '&data%5B1%5D`
        : `data%5B0%5D`;
      let result = null;
      for (let attempt = 0; attempt < 3 && result === null; attempt++) {
        try {
          result = await page.evaluate(`
            const j = await window.__ajax('method=getHomeNum&${cityParam}%5Bname%5D=street&${city ? 'data%5B1%5D' : 'data%5B0%5D'}%5Bvalue%5D=' + encodeURIComponent(${JSON.stringify(street)}));
            const first = {}, lines = {};
            for (const h in (j.data || {})) {
              const q = [...new Set((j.data[h].sub_type_reason || []).filter(Boolean))];
              if (!q.length) continue;
              first[h] = q[0];
              if (q.length > 1) lines[h] = q;
            }
            return { first, lines, failed: !j.data };
          `);
        } catch (err) {
          if (attempt === 2) throw new Error(`"${city || ''} ${street}": ${err.message}`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      const { first, lines } = result;
      // ДТЕК answers some errors with HTTP 200 and `{"result": false}`; counted, and caught before a
      // swap by the emptied-street check, rather than retried: two Kyiv streets always answer so.
      if (result.failed) failed++;
      // `x/` before `s/`: resumability keys off `s/`, so a crash between the two writes refetches
      // the street instead of leaving an `s/` file whose extra lines were never saved.
      const lineFile = join(dirname(dirname(file)), 'x', basename(file));
      if (Object.keys(lines).length) {
        await mkdir(dirname(lineFile), { recursive: true });
        await writeWhole(lineFile, JSON.stringify(lines));
      } else {
        await rm(lineFile, { force: true });
      }
      await writeWhole(file, JSON.stringify(first));
      multi += Object.keys(lines).length;
      await new Promise((r) => setTimeout(r, 180));
      return Object.keys(first).length > 0;
    };

    let done = 0, skipped = 0, kept = 0, empty = 0, failed = 0, expected = 0, multi = 0;
    const liveFiles = [];
    const startedAt = Date.now();
    // Prints often enough that a healthy run never looks hung: a cold Chrome start plus a sparse
    // progress line is indistinguishable from a hang, which is exactly how the first run read.
    const tick = () => {
      const n = done + skipped + kept;
      if (n % 100) return;
      const rate = done ? (Date.now() - startedAt) / done : 0;
      const left = expected ? Math.max(0, expected - n) : 0;
      const eta = rate && left ? `, ~${Math.round((left * rate) / 60000)} min left` : '';
      const pct = expected ? ` (${Math.round((n / expected) * 100)}%)` : '';
      console.log(`  ${n}/${expected || '?'}${pct} — ${done} fetched, ${skipped} skipped, ${empty} without queues${eta}`);
    };

    /**
     * The phone addresses a street by its INDEX in the published list, and caches that list for a
     * day. If a re-harvest reorders it — ДТЕК adds or drops a street and everything after shifts —
     * a cached list paired with a fresh `s/<i>.json` shows another street's houses, in every app
     * version already installed. So indices are permanent: the previous list is kept as is, new
     * names are appended, and a name the operator does not list right now keeps its slot (see keep).
     */
    const prevDir = args.fresh ? finalDir : null;
    // Only a missing list means "none yet". One that does not parse — cut short by a kill, or left
    // with merge markers — stops the run: rebuilt from [] it would renumber every street in it.
    const readList = async (file) => {
      if (!file) return null;
      const text = await readFile(file, 'utf8').catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${file} does not parse; restore it from git before rebuilding`);
      }
    };
    const stable = async (rel, current) => {
      const base = (await readList(join(outDir, rel))) ?? (await readList(prevDir && join(prevDir, rel))) ?? [];
      const known = new Set(base);
      const live = new Set(current);
      return {
        list: [...base, ...current.filter((name) => !known.has(name))],
        live,
        added: current.filter((name) => !known.has(name)).length,
        gone: base.filter((name) => !live.has(name)).length
      };
    };
    /**
     * A street the operator does not list right now keeps its slot AND its last data. ДТЕК's street
     * list flickers: on 2026-10-01 Kyiv's gave 2667 names at 09:07 and 2674 at 11:00, with two of
     * the "missing" ones back. So a name absent from one harvest is far more often a blip than a
     * rename, and emptying it would turn a real street into "not found" until the next harvest,
     * while houses rarely change group (0 of 50 177 Kyiv houses did between 2026-09-07 and 10-01).
     * `x/` goes first, as in fetchStreet; an `x/` the previous harvest did not have is removed, so
     * a dead run of this `.new/` cannot leave one behind.
     */
    const keep = async (relDir, name) => {
      for (const sub of ['x', 's']) {
        const target = join(outDir, relDir, sub, name);
        const data = prevDir ? await readFile(join(prevDir, relDir, sub, name), 'utf8').catch(() => null) : null;
        if (data === null && sub === 'x') { await rm(target, { force: true }); continue; }
        await mkdir(join(outDir, relDir, sub), { recursive: true });
        await writeWhole(target, data ?? '{}');
      }
      kept++;
    };
    const filesIn = async (dir) => new Set((await readdir(dir).catch(() => [])).map((f) => f.replace('.json', '')));

    if (region.shape === 'flat') {
      const { list: streets, live, added, gone } = await stable('streets.json', raw);
      console.log(`${regionId}: ${raw.length} streets listed, ${streets.length} published (${added} new, ${gone} no longer listed)`);
      expected = Math.min(streets.length, limit === Infinity ? streets.length : limit);
      await writeWhole(join(outDir, 'streets.json'), JSON.stringify(streets));
      const streetDir = join(outDir, 's');
      await mkdir(streetDir, { recursive: true });
      const have = await filesIn(streetDir);
      for (let i = 0; i < streets.length && done + kept < limit; i++) {
        if (live.has(streets[i])) liveFiles.push(join('s', `${i}.json`));
        if (have.has(String(i))) { skipped++; tick(); continue; }
        if (!live.has(streets[i])) { await keep('', `${i}.json`); tick(); continue; }
        if (!(await fetchStreet(streets[i], null, join(streetDir, `${i}.json`)))) empty++;
        done++; tick();
      }
    } else {
      // Settlement list stays a separate small file: the phone downloads it once to offer a picker,
      // and only then pulls the one settlement's streets. Shipping the whole nested map would be
      // hundreds of kilobytes for a single lookup.
      const { list: settlements, live: liveSettlements, added, gone } =
        await stable('settlements.json', Object.keys(raw).sort());
      const plans = [];
      for (let ci = 0; ci < settlements.length; ci++) {
        const city = settlements[ci];
        const current = liveSettlements.has(city) ? raw[city] || [] : [];
        plans.push({ city, ...(await stable(join('c', String(ci), 'streets.json'), current)) });
      }
      const totalStreets = plans.reduce((n, plan) => n + plan.list.length, 0);
      console.log(`${regionId}: ${settlements.length} settlements (${added} new, ${gone} no longer listed), ${totalStreets} streets`);
      expected = Math.min(totalStreets, limit === Infinity ? totalStreets : limit);
      await writeWhole(join(outDir, 'settlements.json'), JSON.stringify(settlements));

      for (let ci = 0; ci < plans.length && done + kept < limit; ci++) {
        const { city, list: streets, live } = plans[ci];
        if (!streets.length) continue;
        const rel = join('c', String(ci));
        const streetDir = join(outDir, rel, 's');
        await mkdir(streetDir, { recursive: true });
        await writeWhole(join(outDir, rel, 'streets.json'), JSON.stringify(streets));
        const have = await filesIn(streetDir);
        for (let si = 0; si < streets.length && done + kept < limit; si++) {
          if (live.has(streets[si])) liveFiles.push(join(rel, 's', `${si}.json`));
          if (have.has(String(si))) { skipped++; tick(); continue; }
          if (!live.has(streets[si])) { await keep(rel, `${si}.json`); tick(); continue; }
          if (!(await fetchStreet(streets[si], city, join(streetDir, `${si}.json`)))) empty++;
          done++; tick();
        }
      }
    }
    console.log(`done: ${done} fetched, ${skipped} skipped, ${kept} not listed right now (kept from the last harvest), ${empty} streets with no queue data (${failed} answered with an error), ${multi} multi-line houses this run`);

    // Swap only a complete rebuild: a partial one stays in `.new/` and the next run resumes it.
    if (args.fresh && limit === Infinity && done + skipped + kept === expected) {
      // A street that had houses and came back with none is ДТЕК's data a handful of times; many
      // of them is a run that started getting error answers part-way, and swapping it in would
      // replace a good region with an empty one. Checked over all of `.new/`, so a resume counts.
      const lost = [];
      for (const rel of liveFiles) {
        const now = JSON.parse(await readFile(join(outDir, rel), 'utf8'));
        if (Object.keys(now).length) continue;
        const before = await readFile(join(finalDir, rel), 'utf8').then(JSON.parse).catch(() => ({}));
        if (Object.keys(before).length) lost.push(rel);
      }
      if (lost.length > Math.max(5, expected / 100) && !args['allow-emptied']) {
        throw new Error(`not swapped: ${lost.length} streets had houses and now have none (${lost.slice(0, 5).join(', ')}, …). ` +
          `Delete their s/ files in ${regionId}.new/ and rerun to fetch them again, or pass --allow-emptied if ДТЕК really emptied them.`);
      }
      const old = `${finalDir}.old`;
      await rm(old, { recursive: true, force: true });
      await rm(join(outDir, '.harvest.json'), { force: true });
      if (await stat(finalDir).catch(() => null)) await rename(finalDir, old);
      await rename(outDir, finalDir);
      console.log(`swapped ${regionId}.new into place${lost.length ? ` (${lost.length} streets emptied)` : ''}; previous copy kept at ${regionId}.old until checked`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
