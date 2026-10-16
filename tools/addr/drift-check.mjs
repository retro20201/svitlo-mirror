/**
 * How stale is the published address dictionary? A small, polite probe of the operators' own address
 * services against the committed files: DTEK moves addresses between queues without notice (Kyiv:
 * 42% of the houses in two weeks, autumn 2026), and an address a person finds in the app then gives
 * the wrong queue. Run weekly; it sends ~100 requests, two seconds apart, and changes nothing.
 *
 *   node tools/addr/drift-check.mjs [--streets=25] [--out=<dir>] [--region=kyiv,odesa]
 *
 * Per region it draws `--streets` street files (a different draw each ISO week), asks the operator
 * for the same streets and counts the houses whose first line differs. The first line is the queue
 * the app saves. Prints one line per region and writes <out>/<yyyy-mm-dd>.json. Exit code 0 always:
 * a stale dictionary is a report, not a failure; the line says STALE above the threshold.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { launch } from './chrome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = join(ROOT, 'firebase', 'public', 'v1', 'addr');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const PER_REGION = Number(args.streets || 25);
const OUT = args.out || join(homedir(), 'Library', 'Logs', 'SvitloDrift');

const REGIONS = {
  kyiv: { host: 'https://www.dtek-kem.com.ua', shape: 'flat', stale: 10 },
  'kyiv-region': { host: 'https://www.dtek-krem.com.ua', shape: 'nested', stale: 10 },
  dnipro: { host: 'https://www.dtek-dnem.com.ua', shape: 'nested', stale: 10 },
  odesa: { host: 'https://www.dtek-oem.com.ua', shape: 'nested', stale: 10 }
};
const wanted = String(args.region || Object.keys(REGIONS).join(',')).split(',');

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const today = new Date();
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const n = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - n);
  return t.getUTCFullYear() * 100 + Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
};
let seed = isoWeek(today);
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const draw = (items, n) => { const pool = [...items]; const out = []; while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]); return out; };

const PAGE_AJAX = `window.__ajax = async function (body) { const tok = document.querySelector('meta[name=csrf-token]').content;
  const r = await fetch('/ua/ajax', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': tok, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body }); return r.json(); }; return true;`;

/** Every (settlement index | null, street index, file dir) the committed dictionary can answer for. */
function candidates(dir, shape) {
  if (shape === 'flat') {
    const streets = json(join(dir, 'streets.json'));
    return streets.map((name, i) => ({ ci: null, si: i, city: null, street: name, s: join(dir, 's', `${i}.json`), x: join(dir, 'x', `${i}.json`) }))
      .filter((c) => existsSync(c.s));
  }
  const settlements = json(join(dir, 'settlements.json'));
  const out = [];
  for (let ci = 0; ci < settlements.length; ci++) {
    const sf = join(dir, 'c', String(ci), 'streets.json');
    if (!existsSync(sf)) continue;
    json(sf).forEach((name, si) => {
      const s = join(dir, 'c', String(ci), 's', `${si}.json`);
      if (existsSync(s)) out.push({ ci, si, city: settlements[ci], street: name, s, x: join(dir, 'c', String(ci), 'x', `${si}.json`) });
    });
  }
  return out;
}

const q = (name, value, i) => `data%5B${i}%5D%5Bname%5D=${name}&data%5B${i}%5D%5Bvalue%5D=${encodeURIComponent(value)}`;
const body = (c) => 'method=getHomeNum&' + (c.city === null ? q('street', c.street, 0) : `${q('city', c.city, 0)}&${q('street', c.street, 1)}`);

const report = { date: today.toISOString().slice(0, 10), week: isoWeek(today), perRegion: PER_REGION, regions: {} };
for (const id of wanted) {
  const region = REGIONS[id];
  const dir = join(BASE, id);
  if (!region || !existsSync(dir)) { console.log(`${id}: skipped (not published here)`); continue; }
  const sample = draw(candidates(dir, region.shape), PER_REGION);
  let browser;
  const tally = { streets: 0, houses: 0, same: 0, firstDiffers: 0, setDiffers: 0, onlyNow: 0, onlyOurs: 0, failed: 0 };
  const examples = [];
  try {
    browser = await launch({ headless: true });
    const page = await browser.open(`${region.host}/ua/shutdowns`);
    await page.waitForSelector('meta[name=csrf-token]', 90000);
    await page.evaluate(PAGE_AJAX);
    for (const c of sample) {
      let got = null;
      for (let attempt = 0; attempt < 2 && !got; attempt++) {
        try {
          got = await page.evaluate(`
            const j = await window.__ajax(${JSON.stringify(body(c))});
            const out = {}; for (const h in (j.data || {})) out[h] = [...new Set((j.data[h].sub_type_reason || []).filter(Boolean))];
            return { ok: !!j.data, houses: out };`);
        } catch { await new Promise((r) => setTimeout(r, 3000)); }
      }
      if (!got || !got.ok) { tally.failed++; await new Promise((r) => setTimeout(r, 2000)); continue; }
      tally.streets++;
      const s = json(c.s);
      const x = existsSync(c.x) ? json(c.x) : {};
      for (const h of Object.keys(got.houses)) {
        const now = got.houses[h];
        if (!now.length) continue;
        if (!(h in s)) { tally.onlyNow++; continue; }
        tally.houses++;
        const ours = x[h] || [s[h]];
        if (ours[0] === now[0]) {
          if (JSON.stringify([...ours].sort()) === JSON.stringify([...now].sort())) tally.same++; else tally.setDiffers++;
        } else {
          tally.firstDiffers++;
          if (examples.length < 3) examples.push({ street: c.street, city: c.city, house: h, ours, now });
        }
      }
      for (const h of Object.keys(s)) if (!(h in got.houses) || !got.houses[h].length) tally.onlyOurs++;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) {
    tally.error = String(e.message || e).slice(0, 200);
  } finally {
    if (browser) await browser.close();
  }
  const pct = tally.houses ? Math.round((1000 * tally.firstDiffers) / tally.houses) / 10 : null;
  report.regions[id] = { ...tally, firstDiffersPct: pct, stale: pct !== null && pct > region.stale, examples };
  const flag = tally.error ? `ERROR ${tally.error}` : pct === null ? 'NO DATA' : pct > region.stale ? 'STALE' : 'ok';
  console.log(`${id}: ${tally.firstDiffers} of ${tally.houses} houses changed queue (${pct ?? '?'}%), ${tally.setDiffers} changed their set of lines, ${tally.streets}/${sample.length} streets read — ${flag}`);
  await new Promise((r) => setTimeout(r, 5000));
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${report.date}.json`), JSON.stringify(report, null, 1));
console.log(`report: ${join(OUT, `${report.date}.json`)}`);
