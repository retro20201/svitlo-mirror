#!/usr/bin/env node
/**
 * Watches the regions we cannot serve yet and reports when one becomes implementable.
 *
 * Most operators outside ДТЕК publish a queue×hour table **only while restrictions are in force**.
 * Out of season their pages are address-lookup forms with nothing on them to parse, so an adapter
 * written today could not be tested against anything real — and a schedule parser that has never
 * seen real input is a guess. In an app where a wrong schedule is worse than no schedule, that is
 * not a trade worth making.
 *
 * So instead of guessing, this runs on the mirror's cron and looks for the signals a real ГПВ
 * table leaves behind. When one lights up, that region is ready for an adapter — and the report
 * says which signals fired, so the work starts with evidence rather than a blank page.
 *
 * It reads pages. It never publishes anything the app consumes.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONS } from './regions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, 'probe-report.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Splits a page into the two things the signals need: the markup (for structure) and the visible
 * text (for wording and numbers).
 *
 * Matching numbers against raw markup does not work. `1.125em` in a stylesheet, `4/3` in an
 * aspect-ratio, and above all inline SVG path data — `d="M60.4,78.9c-2.2,4.1..."` — all read as
 * queue labels to a regex. That had Рівне scoring 5 of 6 on a page with no table on it at all.
 * A watchdog that cries wolf gets ignored, so the numeric signals only ever see real text.
 */
function extract(html) {
  const markup = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const text = markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  return { markup, text };
}

/**
 * What a published hourly schedule looks like, regardless of whose CMS rendered it.
 * Individually each signal is weak — "черга" appears in unrelated copy, a `<table>` might be a
 * tariff list — so a region is only called ready when several fire together.
 */
const SIGNALS = [
  {
    name: 'hour-ranges',
    weight: 3,
    on: 'text',
    test: (text) => (text.match(/\b(0\d|1\d|2[0-3])\s*[-–]\s*(0\d|1\d|2[0-4])\b/g) ?? []).length >= 12
  },
  {
    name: 'national-queues',
    weight: 3,
    on: 'text',
    test: (text) => new Set(text.match(/\b[1-6]\.[12]\b/g) ?? []).size >= 6
  },
  {
    name: 'queue-wording',
    weight: 1,
    on: 'text',
    test: (text) => /черг[аиуі]|підчерг/i.test(text)
  },
  {
    name: 'wide-table',
    weight: 2,
    on: 'markup',
    test: (markup) => {
      // A schedule row carries ~24 cells; nothing else on these sites is that wide.
      const rows = markup.match(/<tr[\s\S]{0,6000}?<\/tr>/gi) ?? [];
      return rows.some((row) => (row.match(/<t[dh][\s>]/gi) ?? []).length >= 20);
    }
  },
  {
    name: 'state-vocabulary',
    weight: 2,
    on: 'text',
    test: (text) => /світла\s+не\s+буде|світло\s+є|можлив[еі]\s+відключення|погодинн[іи]х?\s+відключень/i.test(text)
  }
];

const READY_SCORE = 6;

async function probe(region) {
  const result = { id: region.id, url: region.probe, status: region.status, signals: [], score: 0 };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(region.probe, {
      signal: controller.signal,
      headers: { 'user-agent': UA, 'accept-language': 'uk-UA,uk;q=0.9' }
    }).finally(() => clearTimeout(timer));

    result.http = response.status;
    if (!response.ok) return result;

    const sources = extract(await response.text());
    result.bytes = sources.text.length;
    for (const signal of SIGNALS) {
      if (signal.test(sources[signal.on])) {
        result.signals.push(signal.name);
        result.score += signal.weight;
      }
    }
    result.ready = result.score >= READY_SCORE;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

/**
 * Proves the detector can still see.
 *
 * A watchdog that has quietly stopped matching anything looks exactly like a watchdog reporting
 * "nothing yet" — and this one is expected to report nothing for months at a time. So it renders a
 * page from real ДТЕК data in the markup an operator would use, and asserts the signals fire.
 */
async function selfTest() {
  const url = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json';
  const payload = await (await fetch(url, { headers: { 'user-agent': UA } })).json();
  const preset = payload.preset;
  const queues = Object.keys(preset.data).slice(0, 12);
  const hours = Object.keys(preset.time_zone).sort((a, b) => Number(a) - Number(b));

  const header = `<tr><th>Черга</th>${hours.map((h) => `<th>${preset.time_zone[h][0]}</th>`).join('')}</tr>`;
  const rows = queues.map((queue) => {
    const day = preset.data[queue]['3'] ?? {};
    const cells = hours.map((h) => `<td>${preset.time_type[day[h]] ?? ''}</td>`).join('');
    return `<tr><th>${preset.sch_names[queue] ?? queue}</th>${cells}</tr>`;
  }).join('');
  const html = `<html><body><h1>Графік погодинних відключень</h1><table>${header}${rows}</table></body></html>`;

  const sources = extract(html);
  let score = 0;
  const fired = [];
  for (const signal of SIGNALS) {
    if (signal.test(sources[signal.on])) { fired.push(signal.name); score += signal.weight; }
  }
  const ok = score >= READY_SCORE;
  console.log(`selftest: score=${score} (threshold ${READY_SCORE}) signals=${fired.join(',')}`);
  console.log(ok ? 'selftest PASSED — the detector still recognises a real schedule.'
                 : 'selftest FAILED — the signals no longer match real ДТЕК markup.');
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--selftest')) return selfTest();
  const targets = REGIONS.filter((region) => region.probe);
  const results = [];
  for (const region of targets) {
    const result = await probe(region);
    results.push(result);
    const flag = result.ready ? 'READY' : result.error ? 'ERROR' : 'quiet';
    console.log(
      `[${flag.padEnd(5)}] ${region.id.padEnd(12)} http=${result.http ?? '—'} ` +
      `score=${result.score} ${result.signals.join(',') || (result.error ?? '')}`
    );
  }

  let previous = null;
  try { previous = JSON.parse(await readFile(REPORT, 'utf8')); } catch { /* first run */ }

  const newlyReady = results.filter((result) => {
    const before = previous?.results?.find((r) => r.id === result.id);
    return result.ready && !before?.ready;
  });

  await writeFile(REPORT, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));

  if (newlyReady.length) {
    console.log(`\n>>> now publishing a schedule: ${newlyReady.map((r) => r.id).join(', ')}`);
    console.log('>>> these regions are ready for an adapter — the markup exists to parse and test against.');
  } else {
    console.log('\nno change: none of the watched regions is publishing a schedule yet.');
  }
}

main();
