import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getJSON, USER_AGENT } from './http.mjs';

/**
 * «Погода»: the temperature and the sky over each region's main city, `v1/weather.json`, for the line at the top of «Сьогодні»
 * («Пт, 13 листопада · ☁ +6° · хмарно»).
 *
 * The source is the Norwegian Meteorological Institute's open forecast (api.met.no, Yr): no key, free for commercial use with
 * the source named — the app says «Yr / Норвезький метеоінститут» — and asked to be called from a server, once per place, with an
 * honest user agent and no more often than the answer's own `Expires` (about half an hour). So the phones never call it, and
 * nothing of theirs — no coordinates, no address — reaches it: the weather is the region's city's, not the person's street's.
 *
 * Written as the reading of a moment: the whole number of degrees and one word for the sky (`clear`, `partly`, `cloudy`, `fog`,
 * `rain`, `sleet`, `snow`, `thunder`), and whether it is night there, for the moon. The words are the app's, in its languages.
 *
 * A region that cannot be read keeps its last reading for `KEEP_MS`, then is left out (the line is not drawn without a reading).
 * Nothing is written when nothing could be read and nothing is kept.
 *
 * The server's checkout is cleaned at the start of every cycle (vps/run.sh), so the file of the cycle before is not there: the
 * one being served is fetched and put back into the tree first — it is what says when the weather was last renewed, and a full
 * deploy of the tree would otherwise take the file off the site. The source is asked at most once in `RENEW_AFTER_MS`, counted
 * two ways: by the file's own stamp, and by when the source was last asked (`stateFile`, kept outside the tree) — so a source
 * that is down, or is turning this server away, is not asked again every two minutes either.
 */

/** The main city of each region the app has: where the weather is taken. Occupied regions have none. */
export const PLACES = {
  kyiv: [50.45, 30.52],
  'kyiv-region': [50.1, 30.3],
  dnipro: [48.46, 35.04],
  cek: [48.46, 35.04],
  odesa: [46.48, 30.72],
  mykolaiv: [46.98, 31.99],
  lviv: [49.84, 24.03],
  kirovohrad: [48.51, 32.26],
  zhytomyr: [50.25, 28.66],
  sumy: [50.91, 34.8],
  rivne: [50.62, 26.25],
  vinnytsia: [49.23, 28.47],
  volyn: [50.75, 25.33],
  'ivano-frankivsk': [48.92, 24.71],
  ternopil: [49.55, 25.59],
  kharkiv: [49.99, 36.23],
  chernivtsi: [48.29, 25.94],
  chernihiv: [51.5, 31.29],
  zakarpattia: [48.62, 22.29],
  khmelnytskyi: [49.42, 26.99],
  cherkasy: [49.44, 32.06],
  zaporizhzhia: [47.84, 35.14],
  poltava: [49.59, 34.55],
  kherson: [46.64, 32.62]
};

/** The file is renewed when it is older than this: the source asks for no more than one reading of a place per half hour. */
export const RENEW_AFTER_MS = 30 * 60 * 1000;
/** A reading that could not be renewed is still shown this long. */
export const KEEP_MS = 3 * 60 * 60 * 1000;
const FORECAST = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const SERVED = 'https://koly-svitlo.web.app/v1/weather.json';

/** The file as the site serves it: its text, or null when there is none yet (a 404). Anything else is an error. */
async function servedCopy() {
  const response = await fetch(SERVED, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** met.no's `symbol_code` («lightrainshowers_day», «partlycloudy_night») as one of the eight skies, and whether it is night. */
export function skyOf(symbolCode) {
  const code = String(symbolCode ?? '');
  const night = /_night$/.test(code);
  const base = code.replace(/_(?:day|night|polartwilight)$/, '');
  let sky;
  if (base.includes('thunder')) sky = 'thunder';
  else if (base.includes('sleet')) sky = 'sleet';
  else if (base.includes('snow')) sky = 'snow';
  else if (base.includes('rain') || base.includes('showers')) sky = 'rain';
  else if (base === 'fog') sky = 'fog';
  else if (base === 'clearsky' || base === 'fair') sky = 'clear';
  else if (base === 'partlycloudy') sky = 'partly';
  else if (base === 'cloudy') sky = 'cloudy';
  else return null;
  return { sky, night };
}

/** The reading for now out of a met.no answer, or null if it has none that can be told. */
export function readingOf(answer, { now = new Date() } = {}) {
  const series = answer?.properties?.timeseries;
  if (!Array.isArray(series) || !series.length) return null;
  // The entry nearest to now, not after it by more than an hour: the first one is usually the current hour.
  const entry = series.find((e) => Date.parse(e.time) >= now.getTime() - 60 * 60 * 1000) ?? series[0];
  const temperature = entry?.data?.instant?.details?.air_temperature;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) return null;
  const symbol = entry.data.next_1_hours?.summary?.symbol_code ?? entry.data.next_6_hours?.summary?.symbol_code;
  const sky = skyOf(symbol);
  if (!sky) return null;
  // `-0` is not a temperature people read.
  return { t: Math.round(temperature) || 0, sky: sky.sky, night: sky.night };
}

export async function publishWeather({
  outDir, now = new Date(), places = PLACES, force = false,
  read = (url) => getJSON(url, { retries: 1, timeoutMs: 15000 }),
  readServed = servedCopy, stateFile = process.env.WEATHER_STATE_FILE
} = {}) {
  const file = join(outDir, 'weather.json');
  const idle = { written: false, asked: false, read: 0, failed: 0 };

  // What there is to start from: the file in the tree, or — the tree being clean — the one the site serves, put back as it is.
  let text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    try {
      text = await readServed();
    } catch (error) {
      // Not knowing what is served is not «nothing is served»: the source is not asked on a guess.
      console.warn(`[weather] the served copy was not read: ${error.message}`);
      return idle;
    }
    if (text !== null) await writeFile(file, text, 'utf8');
  }
  let previous = null;
  try { previous = text ? JSON.parse(text) : null; } catch { previous = null; }

  const within = (at) => Number.isFinite(at) && Math.abs(now.getTime() - at) < RENEW_AFTER_MS;
  const askedAt = stateFile ? Number(await readFile(stateFile, 'utf8').catch(() => 'never')) : NaN;
  if (!force && (within(Date.parse(previous?.updatedAt ?? '')) || within(askedAt))) return idle;
  if (stateFile) await writeFile(stateFile, String(now.getTime()), 'utf8').catch(() => {});

  const regions = {};
  let answered = 0;
  let failed = 0;
  for (const [id, [lat, lon]] of Object.entries(places)) {
    try {
      const reading = readingOf(await read(`${FORECAST}?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`), { now });
      if (!reading) throw new Error('no reading in the answer');
      regions[id] = { ...reading, at: now.toISOString() };
      answered++;
    } catch (error) {
      failed++;
      console.warn(`[weather] ${id} not read: ${error.message}`);
      const kept = previous?.regions?.[id];
      if (kept && now.getTime() - Date.parse(kept.at) < KEEP_MS) regions[id] = kept;
    }
  }
  // Nothing answered: what is in the tree stays as it is (its readings run out by their own age in the app).
  if (!answered) return { written: false, asked: true, read: 0, failed };
  await writeFile(file, JSON.stringify({ updatedAt: now.toISOString(), regions }), 'utf8');
  return { written: true, asked: true, read: answered, failed };
}
