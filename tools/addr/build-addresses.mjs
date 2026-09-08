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
 * One small file per street keeps the phone's download to ~1 KB at onboarding instead of megabytes.
 *
 * Run manually (or monthly); the output is committed. Not part of the 10-minute mirror.
 *   node tools/addr/build-addresses.mjs --region=kyiv [--limit=20] [--headful]
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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

async function main() {
  const outDir = join(ROOT, 'firebase', 'public', 'v1', 'addr', regionId);
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

    /** One street: fetch its houses, retrying, and write the file. Returns true if it had data. */
    const fetchStreet = async (street, city, file) => {
      const cityParam = city
        ? `data%5B0%5D%5Bname%5D=city&data%5B0%5D%5Bvalue%5D=' + encodeURIComponent(${JSON.stringify(city)}) + '&data%5B1%5D`
        : `data%5B0%5D`;
      let houses = null;
      for (let attempt = 0; attempt < 3 && houses === null; attempt++) {
        try {
          houses = await page.evaluate(`
            const j = await window.__ajax('method=getHomeNum&${cityParam}%5Bname%5D=street&${city ? 'data%5B1%5D' : 'data%5B0%5D'}%5Bvalue%5D=' + encodeURIComponent(${JSON.stringify(street)}));
            const out = {};
            for (const h in (j.data || {})) {
              const q = j.data[h].sub_type_reason;
              if (q && q[0]) out[h] = q[0];
            }
            return out;
          `);
        } catch (err) {
          if (attempt === 2) throw new Error(`"${city || ''} ${street}": ${err.message}`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      await writeFile(file, JSON.stringify(houses), 'utf8');
      await new Promise((r) => setTimeout(r, 180));
      return Object.keys(houses).length > 0;
    };

    let done = 0, skipped = 0, empty = 0, expected = 0;
    const startedAt = Date.now();
    // Prints often enough that a healthy run never looks hung: a cold Chrome start plus a sparse
    // progress line is indistinguishable from a hang, which is exactly how the first run read.
    const tick = () => {
      const n = done + skipped;
      if (n % 100) return;
      const rate = done ? (Date.now() - startedAt) / done : 0;
      const left = expected ? Math.max(0, expected - n) : 0;
      const eta = rate && left ? `, ~${Math.round((left * rate) / 60000)} min left` : '';
      const pct = expected ? ` (${Math.round((n / expected) * 100)}%)` : '';
      console.log(`  ${n}/${expected || '?'}${pct} — ${done} fetched, ${skipped} skipped, ${empty} without queues${eta}`);
    };

    if (region.shape === 'flat') {
      const streets = raw;
      console.log(`${regionId}: ${streets.length} streets`);
      expected = Math.min(streets.length, limit === Infinity ? streets.length : limit);
      await writeFile(join(outDir, 'streets.json'), JSON.stringify(streets), 'utf8');
      const streetDir = join(outDir, 's');
      await mkdir(streetDir, { recursive: true });
      const have = new Set((await readdir(streetDir).catch(() => [])).map((f) => f.replace('.json', '')));
      for (let i = 0; i < streets.length && done < limit; i++) {
        if (have.has(String(i))) { skipped++; tick(); continue; }
        if (!(await fetchStreet(streets[i], null, join(streetDir, `${i}.json`)))) empty++;
        done++; tick();
      }
    } else {
      // Settlement list stays a separate small file: the phone downloads it once to offer a picker,
      // and only then pulls the one settlement's streets. Shipping the whole nested map would be
      // hundreds of kilobytes for a single lookup.
      const settlements = Object.keys(raw).sort();
      const totalStreets = settlements.reduce((n, c) => n + (raw[c] || []).length, 0);
      console.log(`${regionId}: ${settlements.length} settlements, ${totalStreets} streets`);
      expected = Math.min(totalStreets, limit === Infinity ? totalStreets : limit);
      await writeFile(join(outDir, 'settlements.json'), JSON.stringify(settlements), 'utf8');

      for (let ci = 0; ci < settlements.length && done < limit; ci++) {
        const city = settlements[ci];
        const streets = raw[city] || [];
        if (!streets.length) continue;
        const cityDir = join(outDir, 'c', String(ci));
        const streetDir = join(cityDir, 's');
        await mkdir(streetDir, { recursive: true });
        await writeFile(join(cityDir, 'streets.json'), JSON.stringify(streets), 'utf8');
        const have = new Set((await readdir(streetDir).catch(() => [])).map((f) => f.replace('.json', '')));
        for (let si = 0; si < streets.length && done < limit; si++) {
          if (have.has(String(si))) { skipped++; tick(); continue; }
          if (!(await fetchStreet(streets[si], city, join(streetDir, `${si}.json`)))) empty++;
          done++; tick();
        }
      }
    }
    console.log(`done: ${done} fetched, ${skipped} skipped, ${empty} streets with no queue data`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
