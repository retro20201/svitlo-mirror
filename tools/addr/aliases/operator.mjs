/**
 * The operator's lists as they sit on disk (`firebase/public/v1/addr`), read for joining names to rows.
 * Nothing here writes: the lists are published and their indices are permanent (tools/addr/README.md,
 * «Indices are permanent»), so an alias file may point at them by index and nothing may change them.
 *
 *   kyiv/streets.json                      flat: one list of streets
 *   <region>/settlements.json              nested: settlements, each with
 *   <region>/c/<c>/streets.json            …its own streets
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseName, recordKey, fold } from './text.mjs';

export const REGION_IDS = ['kyiv', 'kyiv-region', 'dnipro', 'odesa', 'khmelnytskyi'];

const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path) => !!(await stat(path).catch(() => null));

/**
 * Genitive first names and titles that follow a surname in the operator's titles («Гоголя Миколи»,
 * «Павлова Академіка»). A row «вул. Гоголя» next to «вул. Гоголя Миколи» is the same street under
 * two spellings; the builder lists both as targets, flagged `twin`. Nothing else is taken as the
 * long form of a name: «Героїв» is not «Героїв Крут», «Лугова» is not «Лугова Набережна».
 */
export const GIVEN_NAMES = new Set(`івана миколи олександра михайла володимира василя тараса петра сергія павла григорія дмитра леоніда юрія
євгена андрія степана олега максима бориса ігоря романа віталія віктора остапа панаса пилипа олексія валерія анатолія данила данили семена
ярослава якова федора яна левка вадима дениса олекси костя святослава ганни ніни катерини марії олени ольги лесі ліни соломії оксани наталії
надії христини софії ірини марусі кирила адама антона геннадія руслана назарія мирослава станіслава любомира всеволода костянтина георгія
владислава йосипа гната казимира януша юхима ігнатія мартіна давида гавриїла аркадія в’ячеслава вячеслава іллі лева леся марка валентина
віри раїси галини тетяни юлії людмили зої єлизавети ярослави мирона орест ореста тимофія захара кузьми трохима євгенія микити стефана
академіка генерала професора архітектора полковника маршала героя гетьмана князя митрополита космонавта адмірала капітана лікаря сержанта
єфрейтора отамана`.split(/\s+/).map((w) => w.replace(/['’ʼ`]/g, '')));

/** First words of rows that are not streets: corner records, garden societies, housing estates, parks … */
const NOT_STREETS = new Set(['ріг', 'без', 'урочище', 'земельна', 'ст', 'с-т', 'ск', 'ок', 'ктп', 'го', 'жбк', 'ж/м', 'жм', 'мікр', 'масив', 'мас', 'комплекс', 'кооператив', 'парк', 'сквер', 'в/ч', 'автодорога', 'траса', 'військове', 'садове', 'садовий', 'ст.', 'балка', 'ділянка', 'дорога']);

/**
 * One row of an operator list, read once. `eligible` says whether it may be the target of an alias:
 * a street (or settlement) with a name and a kind. Corner records («ріг вул. А/пр. Б»), garden
 * societies, housing estates, district-prefixed rows («Дарницький р-н, вул. Садова 3») and rows
 * without a type are not.
 */
export function readRow(title, index, kind) {
  const parsed = parseName(title, kind);
  const text = String(title).replace(/[\s ]+/g, ' ').trim();
  let eligible = !!parsed.type && parsed.tokens.length > 0;
  const first = fold(text.split(' ')[0]).replace(/\.+$/, '');
  if (NOT_STREETS.has(first) || /[,;]/.test(text.replace(/\([^)]*\)/g, ''))) eligible = false;
  if (/(^|\s)р-н(\s|,|$)/i.test(text)) eligible = false;
  // The kind itself must be one of the plain ones.
  if (kind === 'street' && !['вул.', 'просп.', 'бул.', 'пров.', 'пл.', 'узвіз', 'проїзд', 'тупик', 'шосе', 'наб.', 'алея', 'майдан', 'лінія'].includes(parsed.type)) eligible = false;
  if (kind === 'settlement' && !['м.', 'смт', 'с.', 'хут.'].includes(parsed.type)) eligible = false;
  return { index, title, parsed, eligible, key: recordKey(parsed.type, parsed.tokens) };
}

/** Rows of a list, with the records they group into: rows of one class and one token set are one street. */
export function readList(titles, kind) {
  let rows = titles.map((t, i) => readRow(t, i, kind));
  // Хмельницька's settlements carry no type at all («Андріївка», «Хмельницький»): then the name alone is the key.
  const typeless = kind === 'settlement' && rows.length > 0 && rows.filter((r) => r.parsed.type).length / rows.length < 0.05;
  if (typeless) {
    rows = titles.map((t, i) => {
      const row = readRow(t, i, kind);
      return { ...row, eligible: row.parsed.tokens.length > 0 && !/[,;]/.test(String(t)), key: `|${row.parsed.tokens.join(' ')}` };
    });
  }
  const records = new Map();
  for (const row of rows) {
    if (!row.eligible) continue;
    if (!records.has(row.key)) records.set(row.key, []);
    records.get(row.key).push(row);
  }
  // Rows by token set alone, for the type-relaxed join.
  const byTokens = new Map();
  for (const [key, rowsOf] of records) {
    const tokens = key.slice(key.indexOf('|') + 1);
    if (!byTokens.has(tokens)) byTokens.set(tokens, []);
    byTokens.get(tokens).push(rowsOf);
  }
  return { kind, titles, rows, records, byTokens, typeless, shortForms: shortForms(records) };
}

/** Every region on disk: its settlements (nested) or its streets (flat), and the street lists of its cities. */
export async function loadOperator(addrDir, regions = REGION_IDS) {
  const out = new Map();
  for (const id of regions) {
    const dir = join(addrDir, id);
    if (await exists(join(dir, 'streets.json'))) {
      out.set(id, { id, dir, shape: 'flat', streets: readList(await readJSON(join(dir, 'streets.json')), 'street'), cities: new Map() });
    } else if (await exists(join(dir, 'settlements.json'))) {
      const settlements = readList(await readJSON(join(dir, 'settlements.json')), 'settlement');
      const cities = new Map();
      for (const c of await readdir(join(dir, 'c')).catch(() => [])) {
        const file = join(dir, 'c', c, 'streets.json');
        if (!(await exists(file))) continue;
        cities.set(Number(c), readList(await readJSON(file), 'street'));
      }
      out.set(id, { id, dir, shape: 'nested', settlements, cities });
    }
  }
  return out;
}

/** The files a rebuild must never touch, hashed: every list, `s/` and `x/` file. */
export async function hashLists(addrDir, regions = REGION_IDS) {
  const hash = createHash('sha256');
  let files = 0;
  const walk = async (dir, rel) => {
    for (const name of (await readdir(dir).catch(() => [])).sort()) {
      const path = join(dir, name);
      const info = await stat(path);
      if (info.isDirectory()) {
        await walk(path, `${rel}/${name}`);
      } else if (name.endsWith('.json') && name !== 'aliases.json') {
        hash.update(`${rel}/${name}\n`);
        hash.update(await readFile(path));
        files++;
      }
    }
  };
  for (const id of regions) await walk(join(addrDir, id), id);
  return { sha256: hash.digest('hex'), files };
}

/** Houses on a street: keys of `s/<i>.json` and `x/<i>.json`. */
export async function countHouses(streetsDir, index) {
  const keys = new Set();
  for (const sub of ['s', 'x']) {
    const data = await readJSON(join(streetsDir, sub, `${index}.json`)).catch(() => null);
    if (data) for (const k of Object.keys(data)) keys.add(k);
  }
  return keys.size;
}

/** An apostrophe-insensitive, case-insensitive comparison of two titles. */
export const sameTitle = (a, b) => fold(a).replace(/\s+/g, ' ').trim() === fold(b).replace(/\s+/g, ' ').trim();

/**
 * Record key → keys of the records that are the same street under a longer or shorter spelling:
 * the same kind, and one name is the other followed by one or two first names or titles.
 */
function shortForms(records) {
  const byFirst = new Map();
  for (const [key, rows] of records) {
    const ordered = rows[0].parsed.ordered;
    if (!ordered.length) continue;
    const id = `${key.slice(0, key.indexOf('|'))}|${ordered[0]}`;
    if (!byFirst.has(id)) byFirst.set(id, []);
    byFirst.get(id).push(key);
  }
  const related = new Map();
  const link = (a, b) => {
    if (!related.has(a)) related.set(a, new Set());
    related.get(a).add(b);
  };
  for (const keys of byFirst.values()) {
    if (keys.length < 2) continue;
    for (const shortKey of keys) {
      const short = records.get(shortKey)[0].parsed.ordered;
      for (const longKey of keys) {
        if (longKey === shortKey) continue;
        const long = records.get(longKey)[0].parsed.ordered;
        if (long.length <= short.length || long.length > short.length + 2) continue;
        if (!short.every((t, i) => long[i] === t)) continue;
        if (!long.slice(short.length).every((t) => GIVEN_NAMES.has(t))) continue;
        link(shortKey, longKey);
        link(longKey, shortKey);
      }
    }
  }
  return related;
}
