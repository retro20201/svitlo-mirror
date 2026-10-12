/**
 * The join: reviewed source rows (old name → new name, in a town) against the operator's lists, into
 * the entries of every `aliases.json`. Pure: it reads nothing from disk except through its arguments,
 * so the tests can feed it fixtures. `tools/addr/build-aliases.mjs` is the program around it.
 *
 * The rules, in the order they run:
 *
 *  1. A source row is a PAIR: old name → new name in one scope. Rows that restate each other (the same
 *     pair in Wikipedia, OSM and a council act) are merged and keep every source code. Names are
 *     compared as token sets, so «Бандери Степана» is «Степана Бандери».
 *  2. The NEW name is joined to the operator's rows, in tiers, and the first tier that answers wins:
 *       T1  the same kind and the same token set. The operator's rows of that key are ONE street:
 *           «просп. Яворницького Дмитра» and «просп. Дмитра Яворницького» are both targets, flag `twin`
 *       T2  a short form or initials («Скоропадського» for «Скоропадського Павла Гетьмана»), accepted
 *           only when exactly one street fits
 *       T3  manual/joins.tsv
 *     Another kind with the same name is accepted only when it is the only candidate, and adds
 *     `retype`. A name the councils renamed twice follows the chain to the name the operator lists.
 *  3. Direction. New name listed → a forward entry: key = old name, a FORMER name of the target. New
 *     name not listed but the OLD name is → a reverse entry (`is: current`): the operator still lists
 *     the old name. Neither → nothing is published; the pair goes to the report.
 *  4. Never guessed. A key with several targets lists all of them, each with its district. A key that
 *     is also a current street, a partial or merged rename, a twin, a retype stays a suggestion and
 *     is never `sure`. Neither is a key that the sources also give to another street, listed or not.
 *
 *  `sure` (the app may pick the street without asking) needs ALL of:
 *     - one target without a flag, joined by an exact name (T1 or T3) and with a kind;
 *     - evidence for EVERY hop of the rename, not for the chain as a whole: each hop is an official source
 *       (vr, loc, cad) or Wikipedia and OpenStreetMap together; a hop that only corrects a spelling is no evidence;
 *     - the key is not the name of ANY row of the operator's list (a village «Володарка» next to a town
 *       «Володарка»), nor a longer or shorter spelling of one, nor a current name in the council's own list;
 *     - no other pair gives the same old name to another street (forward), and, for a current-name entry,
 *       no other unlisted name competes for the operator's old row;
 *     - the pair is not half of a swap (A→B and B→A the same year), and a village row is not claimed by two
 *       old names from different districts.
 *  A later decision that undoes an earlier one (Dnipro: 26.07.2024 by the oblast administration, 18.12.2024 by the
 *  council) replaces it: only the later pair is used.
 */
import { parseName, nameKey, fold, tidyName, isJunkName, letterCount, isCyrillicName, isPlausibleKey, trailingKind, actDate, isRespelling, editDistance } from './text.mjs';
import { derivableRussian, russianKey, loose, ukrainianEndings } from './fold.mjs';
import { settlementsOf, parseScope } from './scopes.mjs';
import { GIVEN_NAMES } from './operator.mjs';

export const MIN_YEAR = 1991;
export const MAX_TARGETS = 12;
export const SOURCE_ORDER = ['vr', 'loc', 'cad', 'wp', 'osm', 'rdp', 'man'];
export const SOURCE_LEGEND = {
  vr: 'Верховна Рада (текст акта)',
  loc: 'рішення міськради / ОДА (текст акта)',
  cad: 'кадастр Києва',
  wp: 'uk/ru.wikipedia, CC BY-SA 4.0',
  osm: 'OpenStreetMap, ODbL',
  rdp: 'rename.dp.ua',
  man: 'вручну'
};
const OFFICIAL = new Set(['vr', 'loc', 'cad']);
const KIND_OF_LIST = { streets: 'street', settlements: 'settlement' };
const APOS_CANON = /['ʼ`´ʹ′‘]/g;
const FLAG_ORDER = ['part', 'merge', 'twin', 'both', 'retype'];

/** The display spelling of a key: typographic apostrophe, first letter capital. */
export function displayKey(name) {
  const text = tidyName(name).replace(APOS_CANON, '’');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const rankOf = (code) => SOURCE_ORDER.indexOf(code);

/**
 * Where a pair is: the districts of the best source that says (an act's old raion beats a wiki table's wording of it).
 * rename.dp.ua is a cross-check with no licence: it never supplies a place. `canon` (see districtCanon) turns the
 * wording of the tables into the town's real districts and drops what is not one.
 */
function bestDistricts(pair, canon) {
  for (const code of SOURCE_ORDER) {
    if (code === 'rdp') continue;
    const found = pair.districtsBySrc.get(code);
    if (!found?.size) continue;
    const mapped = [...new Set([...found].map((d) => canon(pair.scope, d)).filter(Boolean))];
    if (mapped.length) return mapped;
  }
  return [];
}

/** Spellings of a district that are the same district: «АНД», «Амур» are Амур-Нижньодніпровський. */
const DISTRICT_ABBREVIATIONS = new Map([['анд', 'Амур-Нижньодніпровський'], ['амур', 'Амур-Нижньодніпровський']]);
/** A town needs this many district-bearing pairs before its labels are checked against each other. */
const DISTRICT_CHECK_FROM = 100;
const DISTRICT_MIN_COUNT = 5;

/**
 * The wording of a district in the wiki tables is the editors': «Індустріальній» (11 times next to «Індустріальний»
 * 56 times), «Шевченківський. Середмістя», and cells that hold a street («Гагаріна», «Калнишевського»). For a town
 * with many labelled pairs a label counts only if it occurs at least DISTRICT_MIN_COUNT times; a rarer one within two
 * letters of a frequent one is that one misspelt; any other rare one is not a district and is dropped. A town with few
 * labelled pairs (a village, a small town) keeps what its source says.
 * Returns `canon(scope, label)` → the label to print, or '' for none.
 */
export function districtCanon(pairs) {
  const counts = new Map(); // scope → Map(label → pairs)
  for (const p of pairs) {
    for (const [code, set] of p.districtsBySrc) {
      if (code === 'rdp') continue;
      for (const raw of set) {
        const label = normaliseDistrict(raw);
        if (!label) continue;
        if (!counts.has(p.scope)) counts.set(p.scope, new Map());
        const m = counts.get(p.scope);
        m.set(label, (m.get(label) ?? 0) + 1);
      }
    }
  }
  const tables = new Map();
  for (const [scope, m] of counts) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const table = new Map();
    if (total < DISTRICT_CHECK_FROM) { for (const label of m.keys()) table.set(label, label); tables.set(scope, table); continue; }
    const canonical = [];
    for (const [label, n] of [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
      const near = canonical.find((c) => [...c].length >= 6 && editDistance(fold(c), fold(label), 2) <= 2);
      if (near) table.set(label, near);
      else if (n >= DISTRICT_MIN_COUNT) { canonical.push(label); table.set(label, label); }
    }
    tables.set(scope, table);
  }
  return (scope, raw) => {
    const label = normaliseDistrict(raw);
    return label ? (tables.get(scope)?.get(label) ?? '') : '';
  };
}

function normaliseDistrict(raw) {
  const first = String(raw ?? '').split(/\.\s+/)[0].trim();
  if (!first || /^місце не вказано$/i.test(first)) return '';
  return DISTRICT_ABBREVIATIONS.get(fold(first)) ?? first;
}
const sortedCodes = (set) => [...set].sort((a, b) => rankOf(a) - rankOf(b));

function mostCommon(counter) {
  let best = null;
  for (const [value, n] of counter) if (!best || n > best[1] || (n === best[1] && value < best[0])) best = [value, n];
  return best?.[0] ?? '';
}

// ---- 1. pairs -----------------------------------------------------------------------------

/**
 * Source rows → merged pairs; a row that falls out goes to `drop(reason, row)`. Besides the pairs it returns
 * the `ruonly` rows (the Russian form of a pair known from elsewhere) and the `census` rows: current names a
 * council's own list gives, which are no rename but tell that a key is somebody's current name.
 */
export function makePairs(rows, { vetoes = [], minYear = MIN_YEAR, drop }) {
  const vetoed = new Set();
  for (const v of vetoes) {
    const kind = v.scope.includes('/') || v.scope === 'kyiv' ? 'street' : 'settlement';
    const oldKey = nameKey(parseName(v.old_name, kind).tokens);
    vetoed.add([v.scope, oldKey, v.new_name ? nameKey(parseName(v.new_name, kind).tokens) : '*'].join('|'));
  }
  const pairs = new Map();
  const ruRows = [];
  const census = [];
  for (const r of rows) {
    const kind = KIND_OF_LIST[r.list];
    if (!kind) { drop('unknown-list', r); continue; }
    if (/(^|,)ruonly(,|$)/.test(r.flags)) { ruRows.push(r); continue; }
    if (/(^|,)census(,|$)/.test(r.flags)) { census.push(r); continue; }
    let old = parseName(r.old_name, kind);
    const next = parseName(r.new_name, kind);
    // «Дарницьке шосе» is a highway whatever the row says the new street is: the old name carries its own kind, so
    // it does not take the kind of the street it became («вул. Дарницьке шосе» would print a kind it never had).
    // When the row's type column says the same thing («проїзд» + «Білоруський проїзд»), the word is said twice.
    const trailing = kind === 'street' ? trailingKind(old) : null;
    const statedType = r.old_type || old.type;
    if (trailing && statedType === trailing.type) old = { ...parseName(trailing.name, kind), type: trailing.type, part: old.part };
    const kindInName = !!trailing && !statedType;
    const oldName = displayKey(old.name);
    const oldType = r.old_type || old.type;
    const newType = r.new_type || next.type;
    if (!old.tokens.length || !next.tokens.length) { drop('empty-name', r); continue; }
    if (old.junk || isJunkName(old.name)) { drop('junk-key', r); continue; }
    if (!isCyrillicName(oldName)) { drop('non-cyrillic', r); continue; }
    if (letterCount(oldName) < 3) { drop('short-key', r); continue; }
    if (!isPlausibleKey(oldName)) { drop('implausible-key', r); continue; }
    if (nameKey(old.tokens) === nameKey(next.tokens) && (!oldType || !newType || oldType === newType)) { drop('same-name', r); continue; }
    const year = /^\d{4}$/.test(r.year) ? Number(r.year) : 0;
    if (year && year < minYear) { drop(`before-${minYear}`, r); continue; }
    const vk = [r.scope, nameKey(old.tokens), nameKey(next.tokens)].join('|');
    if (vetoed.has(vk) || vetoed.has(`${r.scope}|${nameKey(old.tokens)}|*`)) { drop('veto', r); continue; }
    const effOld = kindInName ? '' : oldType || newType;
    const key = [r.list, r.scope, effOld, nameKey(old.tokens), newType, nameKey(next.tokens)].join('\u0001');
    let p = pairs.get(key);
    if (!p) {
      p = {
        key, list: r.list, kind, scope: r.scope,
        oldClass: effOld, oldExplicit: !!oldType, oldTokens: old.tokens, oldNames: new Map(),
        newClass: newType, newTokens: next.tokens, newNames: new Map(),
        districtsBySrc: new Map(), years: [], dates: [], acts: new Set(), srcs: new Set(), flags: new Set(), ru: new Set(), rows: []
      };
      pairs.set(key, p);
    }
    if (oldType) p.oldExplicit = true;
    p.oldNames.set(oldName, (p.oldNames.get(oldName) ?? 0) + 1);
    const newName = displayKey(next.name);
    p.newNames.set(newName, (p.newNames.get(newName) ?? 0) + 1);
    if (r.district) {
      if (!p.districtsBySrc.has(r.src)) p.districtsBySrc.set(r.src, new Set());
      for (const d of r.district.split(/\s*,\s*/)) if (d) p.districtsBySrc.get(r.src).add(d);
    }
    if (year) p.years.push(year);
    if (r.act) {
      p.acts.add(r.act);
      const date = actDate(r.act);
      if (date) p.dates.push(date);
    }
    p.srcs.add(r.src);
    for (const f of r.flags.split(',').filter(Boolean)) p.flags.add(f);
    if (old.part) p.flags.add('part');
    if (r.ru) p.ru.add(r.ru);
    p.rows.push(r);
  }
  const list = [...pairs.values()];
  for (const p of list) {
    p.date = p.dates.sort().at(-1) ?? '';
    // «Короленко» → «Короленка»: the spelling corrected, nothing renamed.
    p.respelling = classesAgree(p.oldClass, p.newClass) && isRespelling(p.oldTokens, p.newTokens);
  }
  return { pairs: list, ruRows, census };
}

/** Compares when two pairs were decided: >0 when `a` is later, <0 when `b` is, 0 when the sources do not say. */
export function laterOf(a, b) {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ya = Math.max(0, ...a.years), yb = Math.max(0, ...b.years);
  if (ya && yb && ya !== yb) return ya < yb ? -1 : 1;
  return 0;
}

const classesAgree = (x, y) => !x || !y || x === y;

/**
 * A decision that is undone by a later one: the oblast administration renamed 20 Dnipro streets on 26.07.2024 and the
 * council gave their names back on 18.12.2024, so both A→B and B→A are in the sources. When the dates tell which is
 * later, only the later pair is kept (the operator may still list the old B: then A is the current name of that row);
 * when they do not (a swap of two squares in one year, OpenStreetMap saying both), both stay but neither may be `sure`.
 * Returns the pairs that stay; the rows of the others go to `drop('superseded', row)`.
 */
export function resolveReverts(pairs, { drop }) {
  const byOld = new Map();
  for (const p of pairs) {
    const k = `${p.list}|${p.scope}|${nameKey(p.oldTokens)}`;
    if (!byOld.has(k)) byOld.set(k, []);
    byOld.get(k).push(p);
  }
  const gone = new Set();
  for (const p of pairs) {
    for (const q of byOld.get(`${p.list}|${p.scope}|${nameKey(p.newTokens)}`) ?? []) {
      if (q === p || nameKey(q.newTokens) !== nameKey(p.oldTokens)) continue;
      if (!classesAgree(p.oldClass, q.newClass) || !classesAgree(p.newClass, q.oldClass)) continue;
      const order = laterOf(p, q);
      if (order === 0) { p.cycle = true; q.cycle = true; continue; }
      gone.add(order > 0 ? q : p);
    }
  }
  for (const p of gone) for (const r of p.rows) drop('superseded', r);
  return pairs.filter((p) => !gone.has(p));
}

// ---- 2. joining ---------------------------------------------------------------------------

/** An index from each longish token to the record keys holding it, for the short-form join. */
function tokenIndex(list) {
  if (list.tokenIndex) return list.tokenIndex;
  const index = new Map();
  for (const [key, rows] of list.records) {
    for (const t of new Set(rows[0].parsed.tokens)) {
      if (t.length < 4) continue;
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(key);
    }
  }
  list.tokenIndex = index;
  return index;
}

/**
 * Finds the operator rows for a name in one list: `{ rows: [[row…]…], mode, flags }` with one inner
 * array per record (twins are the rows of one record), or `rows: []` with `mode` `none` or `ambiguous`.
 * `manual(cls, key)` answers the T3 table.
 */
export function joinName(list, cls, tokens, { manual = null, allowShort = true } = {}) {
  const key = nameKey(tokens);
  if (list.typeless) {
    const hits = list.byTokens.get(key) ?? [];
    if (hits.length === 1) return { rows: hits, mode: 't1', flags: [] };
    return hits.length > 1 ? { rows: [], mode: 'ambiguous', candidates: hits } : { rows: [], mode: 'none' };
  }
  if (cls) {
    const exact = list.records.get(`${cls}|${key}`);
    if (exact) return { rows: [exact], mode: 't1', flags: [] };
  }
  if (manual) {
    const m = manual(cls, key);
    if (m) return m;
  }
  const sameName = list.byTokens.get(key) ?? [];
  // Another kind with the same name is the only candidate (a retype); no kind at all is the only candidate by name
  // alone: both are suggestions, never `sure` (a park or a square of that name would do as well).
  if (sameName.length === 1) return { rows: sameName, mode: cls ? 'relaxed' : 'untyped', flags: cls ? ['retype'] : [] };
  if (sameName.length > 1) return { rows: [], mode: 'ambiguous', candidates: sameName };
  if (!allowShort || !cls) return { rows: [], mode: 'none' };

  // T2: one name is the other with extra words (a first name, initials, a title).
  const significant = tokens.filter((t) => !/^\d+$/.test(t));
  const rarest = significant.filter((t) => t.length >= 4).sort((a, b) => (tokenIndex(list).get(a)?.length ?? 0) - (tokenIndex(list).get(b)?.length ?? 0))[0];
  if (!rarest) return { rows: [], mode: 'none' };
  const found = [];
  for (const k of tokenIndex(list).get(rarest) ?? []) {
    if (!k.startsWith(`${cls}|`)) continue;
    const rows = list.records.get(k);
    const other = rows[0].parsed.tokens;
    const [shorter, longer] = tokens.length <= other.length ? [tokens, other] : [other, tokens];
    if (!shorter.every((t) => longer.includes(t))) continue;
    const extra = longer.filter((t) => !shorter.includes(t));
    // The extra words are a first name or a title («Леонтовича» for «Миколи Леонтовича»); a number («Садова 154»)
    // or a noun («Хутірська» for «Микільсько-Хутірська») makes another street, not a longer name for this one.
    if (!extra.length || extra.length > 2 || !extra.every((t) => GIVEN_NAMES.has(t)) || !shorter.some((t) => t.length >= 4)) continue;
    found.push(rows);
  }
  if (found.length === 1) return { rows: found, mode: 't2', flags: [] };
  if (found.length > 1) return { rows: [], mode: 'ambiguous', candidates: found.flat() };
  return { rows: [], mode: 'none' };
}

/** The rows of the matched records, and of the records that are the same street under a longer or shorter spelling. */
function withShortForms(list, records) {
  const out = [];
  const seen = new Set();
  const add = (rows) => { for (const r of rows) if (!seen.has(r.index)) { seen.add(r.index); out.push(r); } };
  for (const rows of records) {
    add(rows);
    for (const key of list.shortForms?.get(rows[0].key) ?? []) add(list.records.get(key));
  }
  return out;
}

/** Whether the operator lists a row with these words, of ANY kind (a village «Володарка» next to a town «Володарка»). */
function anyRowNamed(list, tokens) {
  return (list.byTokens.get(nameKey(tokens)) ?? []).length > 0;
}

/**
 * Rows of the same kind whose words are the key's words plus one or two more, or the key's words less one or two
 * («Лумумби» and «Лумумби Патріса»): the operator lists the street under a longer or shorter spelling, so the key is
 * not unknown to it. `strict` takes only extra words that are first names or titles (the T2 rule).
 */
export function nearRows(list, cls, tokens, { strict = false } = {}) {
  if (list.typeless || !cls) return [];
  const rarest = tokens.filter((t) => !/^\d+$/.test(t) && t.length >= 4).sort((a, b) => (tokenIndex(list).get(a)?.length ?? 0) - (tokenIndex(list).get(b)?.length ?? 0))[0];
  if (!rarest) return [];
  const out = [];
  for (const k of tokenIndex(list).get(rarest) ?? []) {
    if (!k.startsWith(`${cls}|`)) continue;
    const rows = list.records.get(k);
    const other = rows[0].parsed.tokens;
    if (nameKey(other) === nameKey(tokens)) continue;
    const [shorter, longer] = tokens.length <= other.length ? [tokens, other] : [other, tokens];
    if (!shorter.every((t) => longer.includes(t))) continue;
    const extra = longer.filter((t) => !shorter.includes(t));
    if (!extra.length || extra.length > 2 || extra.some((t) => /\d/.test(t))) continue;
    if (strict && !extra.every((t) => GIVEN_NAMES.has(t))) continue;
    out.push(...rows);
  }
  return out;
}

/** Every hop is official, or Wikipedia and OpenStreetMap agree: a hop that only corrects a spelling is no evidence. */
function hopsPass(hops) {
  const real = hops.filter((h) => !h.respelling);
  return real.length > 0 && real.every((h) => [...h.srcs].some((c) => OFFICIAL.has(c)) || (h.srcs.has('wp') && h.srcs.has('osm')));
}

// ---- 3. the build -------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {Map} args.operator           loadOperator()
 * @param {object[]} args.rows          source rows (sources/*.tsv and manual/extra.tsv)
 * @param {object[]} [args.joins]       manual/joins.tsv   { scope, side, type, name, title }
 * @param {object[]} [args.vetoes]      manual/vetoes.tsv  { scope, old_name, new_name }
 * @param {object[]} [args.russian]     manual/ru.tsv      { kind: 'name'|'word', uk, ru }
 * @param {(dir:string, i:number)=>Promise<number>} args.houses
 */
export async function buildAliases({ operator, rows, joins = [], vetoes = [], russian = [], houses, minYear = MIN_YEAR }) {
  const report = { input: rows.length, used: 0, dropped: {}, droppedRows: [], unmatched: [], ambiguous: [], joinedShort: [], notes: [], perSource: {} };
  const drop = (reason, r, detail = '') => {
    report.dropped[reason] = (report.dropped[reason] ?? 0) + 1;
    report.droppedRows.push({ reason, scope: r.scope, old: `${r.old_type} ${r.old_name}`.trim(), new: `${r.new_type} ${r.new_name}`.trim(), src: r.src, detail });
  };
  for (const r of rows) report.perSource[r.src] = (report.perSource[r.src] ?? 0) + 1;
  const made = makePairs(rows, { vetoes, minYear, drop });
  const { ruRows, census } = made;
  const pairs = resolveReverts(made.pairs, { drop });
  const canon = districtCanon(pairs);

  // The councils' own lists of current names: a key that is one of them is somebody's name today.
  const censusKeys = new Map(); // scope → Set of token sets
  for (const r of census) {
    const tokens = parseName(r.new_name, 'street').tokens;
    if (!tokens.length) continue;
    if (!censusKeys.has(r.scope)) censusKeys.set(r.scope, new Set());
    censusKeys.get(r.scope).add(nameKey(tokens));
  }
  report.used += census.length;

  // Every pair that gives the same old name (in one scope and kind) to some new name: a key that two streets have
  // been called is never `sure`, and neither is a current name that two unlisted names compete for.
  const claims = new Map();
  for (const p of pairs) {
    const k = [p.scope, p.oldClass, nameKey(p.oldTokens)].join('|');
    if (!claims.has(k)) claims.set(k, []);
    claims.get(k).push(p);
  }
  const rivalPairs = (p) => (claims.get([p.scope, p.oldClass, nameKey(p.oldTokens)].join('|')) ?? []).filter((q) => `${q.newClass}|${nameKey(q.newTokens)}` !== `${p.newClass}|${nameKey(p.newTokens)}`);

  // rename.dp.ua states no licence: a pair only it knows is evidence that a name is shared, never an alias.
  const publishable = [];
  for (const p of pairs) {
    if ([...p.srcs].every((code) => code === 'rdp')) { for (const r of p.rows) drop('rdp-only', r); continue; }
    publishable.push(p);
  }

  const byScope = new Map();
  for (const p of publishable) {
    if (!byScope.has(p.scope)) byScope.set(p.scope, []);
    byScope.get(p.scope).push(p);
  }

  const files = new Map(); // id → { id, region, kind: 'kyiv'|'settlements'|'city', c, entries: Map }
  const fileFor = (region, kind, c) => {
    const id = `${region}/${kind}${c === undefined ? '' : `/${c}`}`;
    if (!files.has(id)) files.set(id, { id, region, kind, c, entries: new Map() });
    return files.get(id);
  };

  const dropPairs = (list, reason, detail = '') => { for (const p of list) for (const r of p.rows) drop(reason, r, detail); };

  for (const [scope, scopePairs] of byScope) {
    const sp = parseScope(scope);
    const region = operator.get(sp.region);
    if (!region) { dropPairs(scopePairs, 'unknown-region'); continue; }

    // The lists these pairs are joined against.
    const targets = [];
    if (sp.kind === 'kyiv' && region.shape === 'flat') targets.push({ list: region.streets, file: fileFor('kyiv', 'kyiv'), dir: region.dir });
    else if (sp.kind === 'settlements' && region.shape === 'nested') targets.push({ list: region.settlements, file: fileFor(sp.region, 'settlements'), dir: region.dir });
    else if ((sp.kind === 'town' || sp.kind === 'village') && region.shape === 'nested') {
      const { indices, ambiguous, candidates } = settlementsOf(scope, region);
      if (!indices.length) { dropPairs(scopePairs, ambiguous ? 'village-ambiguous' : 'village-not-listed', ambiguous ? `${candidates} settlements read ${scope}` : ''); continue; }
      for (const c of indices) {
        const list = region.cities.get(c);
        if (list) targets.push({ list, file: fileFor(sp.region, 'city', c), dir: `${region.dir}/c/${c}` });
      }
      if (!targets.length) { dropPairs(scopePairs, 'no-street-list'); continue; }
    } else { dropPairs(scopePairs, 'unknown-scope'); continue; }

    const manualMap = new Map();
    for (const j of joins) {
      if (j.scope !== scope) continue;
      const kind = scope === 'kyiv' || scope.includes('/') ? 'street' : 'settlement';
      manualMap.set(`${j.side}|${j.type}|${nameKey(parseName(j.name, kind).tokens)}`, j.title);
    }

    const byOld = new Map();
    for (const p of scopePairs) {
      const k = `${p.oldClass}|${nameKey(p.oldTokens)}`;
      if (!byOld.has(k)) byOld.set(k, []);
      byOld.get(k).push(p);
    }
    const nextPairs = (p, seen) => (byOld.get(`${p.newClass}|${nameKey(p.newTokens)}`) ?? []).filter((q) => !seen.has(q.key));

    for (const p of scopePairs) {
      let contributed = false;
      let reason = 'unmatched';
      for (const { list, file } of targets) {
        const manual = (side) => (cls, key) => {
          const title = manualMap.get(`${side}|${cls}|${key}`) ?? manualMap.get(`${side}||${key}`);
          if (!title) return null;
          const row = list.rows.find((r) => r.title.trim() === title.trim());
          return row ? { rows: [list.records.get(row.key) ?? [row]], mode: 't3', flags: [] } : null;
        };

        // The new name; a name renamed again follows the chain to the name the operator lists.
        let newJoin = joinName(list, p.newClass, p.newTokens, { manual: manual('new') });
        const chain = [];
        if (!newJoin.rows.length && newJoin.mode !== 'ambiguous') {
          const seen = new Set([p.key]);
          let at = p;
          for (let step = 0; step < 4 && !newJoin.rows.length; step++) {
            const nexts = nextPairs(at, seen);
            if (nexts.length !== 1) break;
            at = nexts[0];
            seen.add(at.key);
            chain.push(at);
            newJoin = joinName(list, at.newClass, at.newTokens, { manual: manual('new') });
          }
          if (!newJoin.rows.length) chain.length = 0;
        }
        // The old name as the operator lists it (the same kind only).
        const oldJoin = joinName(list, p.oldClass, p.oldTokens, { allowShort: false, manual: manual('old') });
        const oldRows = oldJoin.mode === 't1' || oldJoin.mode === 't3' || oldJoin.mode === 'untyped' ? oldJoin.rows.flat() : [];

        if (newJoin.rows.length) {
          const rowsOf = withShortForms(list, newJoin.rows);
          const flags = [...(newJoin.flags ?? [])];
          if (rowsOf.length > 1) flags.push('twin');
          // The operator lists the old name too: as written, or as the longer or shorter spelling of the same street
          // («Лумумби» for «Лумумби Патріса»).
          const targetRows = new Set(rowsOf.map((r) => r.index));
          if (oldRows.length || nearRows(list, p.oldClass, p.oldTokens, { strict: true }).some((r) => !targetRows.has(r.index))) flags.push('both');
          if (newJoin.mode === 't2') report.joinedShort.push({ scope, new: `${p.newClass} ${[...p.newNames.keys()][0]}`, row: rowsOf.map((r) => r.title).join(' | ') });
          addContribution(file, { direction: 'former', pair: p, chain, name: mostCommon(p.oldNames), cls: p.oldClass, tokens: p.oldTokens, rows: rowsOf, flags, mode: newJoin.mode });
          contributed = true;
        } else if (oldRows.length) {
          // The operator still lists the old name: the current name is the key.
          const end = chainEnd(p, nextPairs);
          const reverseRows = withShortForms(list, oldJoin.rows);
          const flags = reverseRows.length > 1 ? ['twin'] : [];
          const currentName = mostCommon(end.pair.newNames);
          if (isPlausibleKey(currentName)) {
            addContribution(file, { direction: 'current', pair: p, chain: end.chain, name: currentName, cls: end.pair.newClass || p.newClass, tokens: end.pair.newTokens, rows: reverseRows, flags, mode: oldJoin.mode === 'untyped' ? 'untyped' : 'reverse' });
            contributed = true;
          } else reason = 'implausible-key';
        } else if (newJoin.mode === 'ambiguous') {
          reason = 'ambiguous';
          report.ambiguous.push({ scope, old: `${p.oldClass} ${mostCommon(p.oldNames)}`, new: `${p.newClass} ${mostCommon(p.newNames)}`, candidates: (newJoin.candidates ?? []).flat().map((r) => r.title).join(' | ') });
        }
      }
      if (contributed) report.used += p.rows.length;
      else {
        dropPairs([p], reason);
        report.unmatched.push({ scope, old: `${p.oldClass} ${mostCommon(p.oldNames)}`, new: `${p.newClass} ${mostCommon(p.newNames)}`, src: sortedCodes(p.srcs).join(','), reason });
      }
    }
  }

  function addContribution(file, c) {
    const mapKey = [c.direction, c.cls, nameKey(c.tokens)].join('\u0001');
    let entry = file.entries.get(mapKey);
    if (!entry) {
      entry = { direction: c.direction, ty: c.cls, tokens: c.tokens, names: new Map(), targets: new Map(), ru: new Set(), pairs: new Set(), rivals: new Set(), scope: c.pair.scope };
      file.entries.set(mapKey, entry);
    }
    entry.names.set(c.name, (entry.names.get(c.name) ?? 0) + 1);
    const evidence = [c.pair, ...c.chain];
    for (const p of evidence) entry.pairs.add(p);
    // The Russian form belongs to the OLD name of the pair; a current-name entry is keyed by the new one.
    if (c.direction === 'former') for (const r of c.pair.ru) entry.ru.add(r);
    else for (const q of rivalPairs(c.pair)) entry.rivals.add(q);
    const pass = hopsPass(evidence);
    for (const row of c.rows) {
      let t = entry.targets.get(row.index);
      if (!t) {
        t = { index: row.index, row, districts: new Set(), years: [], srcs: new Set(), flags: new Set(), modes: new Set(), pass: false };
        entry.targets.set(row.index, t);
      }
      // Some way of getting to this row must be proved at every step.
      t.pass = t.pass || pass;
      for (const p of evidence) {
        for (const d of bestDistricts(p, canon)) t.districts.add(d);
        for (const y of p.years) t.years.push(y);
        for (const s of p.srcs) t.srcs.add(s);
        for (const f of p.flags) if (f === 'part' || f === 'merge') t.flags.add(f);
      }
      for (const f of c.flags) t.flags.add(f);
      // The kind of the thing changed with the name (бульвар Перова → просп. Воскресенський).
      if (c.direction === 'former' && c.pair.oldExplicit && c.pair.newClass && c.pair.oldClass !== c.pair.newClass) t.flags.add('retype');
      t.modes.add(c.mode);
    }
  }

  // ---- entries, files -------------------------------------------------------------------
  const isListed = (list, cls, tokens) => (list.typeless || !cls ? (list.byTokens.get(nameKey(tokens)) ?? []).length > 0 : list.records.has(`${cls}|${nameKey(tokens)}`));
  const outputs = [];
  for (const file of files.values()) {
    const region = operator.get(file.region);
    const list = file.kind === 'kyiv' ? region.streets : file.kind === 'settlements' ? region.settlements : region.cities.get(file.c);
    const dir = file.kind === 'city' ? `${region.dir}/c/${file.c}` : region.dir;
    const entries = [];
    for (const e of file.entries.values()) {
      const name = mostCommon(e.names);
      const targets = [];
      for (const t of e.targets.values()) {
        // Never a corner record, and never an alias of itself.
        if (!t.row.eligible) continue;
        if (nameKey(t.row.parsed.tokens) === nameKey(e.tokens) && (t.row.parsed.type === e.ty || !e.ty)) continue;
        const target = { i: t.index };
        let d = [...t.districts].sort().join(', ');
        // A row the operator itself qualifies («вул. Весняна (Голосіївський р-н.)», «вул. Нижній Вал (Бортничі)») is
        // not the unqualified street next to it: a district the source names that contradicts the qualifier rules the
        // row out, and any other qualifier is the place to print, not the source's district.
        const where = t.row.parsed.locality;
        if (where) {
          if (/р-н|район/i.test(where)) { if (d && !districtMatches(where, t.districts)) continue; }
          else if (d) d = where;
        }
        if (d) target.d = d;
        const y = Math.max(0, ...t.years);
        if (y) target.y = y;
        if (file.kind !== 'settlements') target.h = await houses(dir, t.index);
        const f = FLAG_ORDER.filter((x) => t.flags.has(x));
        if (f.length) target.f = f;
        target.s = sortedCodes(t.srcs);
        targets.push({ target, modes: [...t.modes], locality: where, pass: t.pass });
      }
      if (!targets.length) continue;
      targets.sort((a, b) => (b.target.h ?? 0) - (a.target.h ?? 0) || a.target.i - b.target.i);
      if (targets.length > MAX_TARGETS) report.notes.push(`${file.id}: «${name}» has ${targets.length} targets, ${MAX_TARGETS} kept`);
      const kept = targets.slice(0, MAX_TARGETS);
      // Where the sources do not say, the qualifier the operator prints is the best place there is; otherwise
      // the target has no `d` (the app shows the title and the year).
      if (kept.length > 1) for (const t of kept) if (!t.target.d && t.locality) t.target.d = t.locality;
      for (const x of kept) x.target = Object.fromEntries(['i', 'd', 'y', 'h', 'f', 's'].filter((k) => x.target[k] !== undefined).map((k) => [k, x.target[k]]));
      const first = kept[0];
      const keptRows = new Set(kept.map((x) => x.target.i));

      // `both`: the operator lists the old name, as written or as a longer or shorter spelling of the same street.
      // Only the strict spelling (a first name or a title as the extra words) is told to the app as a flag.
      const nearLoose = nearRows(list, e.ty, e.tokens).some((r) => !keptRows.has(r.index));
      // The key is the name of some row of the operator's list, of any kind; or the council's own list of current names.
      const namesake = anyRowNamed(list, e.tokens);
      const inCensus = censusKeys.get(e.scope)?.has(nameKey(e.tokens)) ?? false;
      let rivalCount = 0;
      if (e.direction === 'former') {
        rivalCount = new Set((claims.get([e.scope, e.ty, nameKey(e.tokens)].join('|')) ?? []).map((q) => `${q.newClass}|${nameKey(q.newTokens)}`)).size - 1;
      } else {
        // The operator's old row: names the sources also give it that the operator does not list compete for it.
        rivalCount = new Set([...e.rivals].filter((q) => !isListed(list, q.newClass, q.newTokens)).map((q) => `${q.newClass}|${nameKey(q.newTokens)}`)).size;
      }
      const swapped = [...e.pairs].some((p) => p.cycle);
      // Every reason the entry is not `sure`, for the report (build-report/blockers.tsv): a person reads it to see
      // what the rules did, and the tests read it to see which rule did it.
      const blockers = [];
      if (kept.length !== 1) blockers.push('several-targets');
      if (!first.pass) blockers.push('hop-evidence');
      if (first.target.f?.length) blockers.push(`flag:${first.target.f.join('+')}`);
      if (namesake) blockers.push('namesake');
      if (nearLoose) blockers.push('near-row');
      if (inCensus) blockers.push('census');
      if (rivalCount > 0) blockers.push(e.direction === 'former' ? 'rival-old-name' : 'rival-current-name');
      if (swapped) blockers.push('swap');
      if (!e.ty && !list.typeless) blockers.push('no-kind');
      if (!first.modes.every((m) => m === 't1' || m === 't3' || m === 'reverse')) blockers.push(`join:${first.modes.filter((m) => !['t1', 't3', 'reverse'].includes(m)).join('+')}`);
      const sure = blockers.length === 0;
      const entry = { k: name };
      if (e.ty) entry.ty = e.ty;
      const ru = collectRussian(name, e.ru, russian);
      if (ru.length) entry.ru = ru;
      if (e.direction === 'current') entry.is = 'current';
      if (sure) entry.sure = true;
      entry.t = kept.map((x) => x.target);
      entries.push({ entry, tokens: e.tokens, direction: e.direction, namesake, rivals: Math.max(0, rivalCount), modes: first.modes, blockers, pairs: [...e.pairs] });
    }
    // Two old names of different districts that end on one village row: the row is one of the villages that
    // were renamed to that name, and nothing says which, so neither old name may pick it.
    if (file.kind === 'settlements') {
      const byRow = new Map();
      for (const x of entries) for (const t of x.entry.t) { if (!byRow.has(t.i)) byRow.set(t.i, []); byRow.get(t.i).push(x); }
      for (const x of entries) {
        if (!x.entry.sure) continue;
        const mine = x.entry.t[0];
        const clash = byRow.get(mine.i).some((y) => y !== x && (!mine.d || (y.entry.t.find((t) => t.i === mine.i)?.d ?? '') !== mine.d));
        if (clash) { delete x.entry.sure; x.blockers.push('row-claimed-by-another-old-name'); }
      }
    }
    // A file with nothing in it is not published (the program that writes files removes a stale one).
    if (entries.length) outputs.push({ id: file.id, region: file.region, kind: file.kind, c: file.c, list, entries });
  }

  // ---- Russian forms of pairs known from elsewhere (ru.wikipedia for Odesa; OSM ways with a Russian old name only) ----
  // Only to the files of the row's own town.
  const inScope = new Map();
  const outputOfScope = (out, scope) => {
    if (!inScope.has(scope)) {
      const sp = parseScope(scope);
      const region = operator.get(sp.region);
      inScope.set(scope, sp.kind === 'kyiv' ? { kyiv: true } : region?.shape === 'nested' && (sp.kind === 'town' || sp.kind === 'village') ? { region: sp.region, cities: new Set(settlementsOf(scope, region).indices) } : {});
    }
    const w = inScope.get(scope);
    return w.kyiv ? out.kind === 'kyiv' : !!w.cities && out.kind === 'city' && out.region === w.region && w.cities.has(out.c);
  };
  let ruAttached = 0;
  const asKey = (tokens) => tokens.map((t) => { const l = loose(t); return russianKey(ukrainianEndings(l)[0] ?? l); }).sort().join(' ');
  for (const r of ruRows) {
    const kind = 'street';
    const oldTokens = parseName(r.old_name, kind).tokens;
    const newTokens = parseName(r.new_name, kind).tokens;
    const oldKey = asKey(oldTokens);
    const newKey = asKey(newTokens);
    let attached = false;
    for (const out of outputs) {
      if (!outputOfScope(out, r.scope)) continue;
      for (const e of out.entries) {
        if (e.entry.is === 'current' || asKey(e.tokens) !== oldKey) continue;
        const hit = e.entry.t.some((t) => asKey(out.list.rows[t.i].parsed.tokens) === newKey);
        if (!hit) continue;
        const form = tidyName(parseName(r.ru || r.old_name).name);
        if (!form || derivableRussian(e.entry.k, form)) { attached = true; continue; }
        e.entry.ru = [...new Set([...(e.entry.ru ?? []), form])].sort().slice(0, 4);
        attached = true;
        ruAttached++;
      }
    }
    if (attached) report.used += 1; else drop('ru-without-pair', r);
  }
  report.ruAttached = ruAttached;

  return { outputs, report, pairs };
}

/** Whether a row's qualifier «Голосіївський р-н.» (or an abbreviation: «Поділ. р-н») names one of the districts a source gave. */
function districtMatches(qualifier, districts) {
  const stem = (text) => fold(text).replace(/р-н\.?|район|[^а-яіїєґ]/g, '');
  const q = stem(qualifier);
  if (q.length < 3) return true;
  return [...districts].some((d) => { const s = stem(d); return s.startsWith(q) || q.startsWith(s); });
}

function chainEnd(p, nextPairs) {
  const seen = new Set([p.key]);
  let at = p;
  const chain = [];
  for (let step = 0; step < 4; step++) {
    const nexts = nextPairs(at, seen);
    if (nexts.length !== 1) break;
    at = nexts[0];
    seen.add(at.key);
    chain.push(at);
  }
  return { pair: at, chain };
}

// ---- Russian forms ------------------------------------------------------------------------

/** The Russian forms an entry carries: OSM and ru.wikipedia, ru.tsv by name and by word; never what the app's folding derives. */
export function collectRussian(name, fromSources, russian) {
  const out = new Map();
  const add = (form) => {
    const clean = tidyName(form);
    if (!clean || !/[а-яё]/i.test(clean) || derivableRussian(name, clean)) return;
    out.set(fold(clean).replace(/\s+/g, ' '), clean);
  };
  for (const r of fromSources) add(r);
  const key = nameKey(parseName(name).tokens);
  for (const row of russian) {
    if (row.kind === 'name' && nameKey(parseName(row.uk).tokens) === key) for (const form of row.ru.split(/\s*[;|]\s*/)) add(form);
  }
  // Word by word, for the Soviet vocabulary the folding cannot guess: Червоноармійська → Красноармейская.
  const words = tidyName(name).split(/\s+/);
  const wordMap = new Map(russian.filter((r) => r.kind === 'word').map((r) => [fold(r.uk), r.ru]));
  // «25-річчя Жовтня» → «25-летия Октября»: the number keeps its place, only the word changes.
  const russianWord = (w) => wordMap.get(fold(w)) ?? w.replace(/^(\d+)-річчя$/i, '$1-летия');
  const translated = words.map(russianWord);
  // A form is stored only when every word of it is Russian: translated, a number, or a name that reads the same
  // in both languages (a capital letter, and the app folds і/и and є/е). «Красных козаків» is half Ukrainian: the
  // word a Russian types, «казаков», is not the word the app has, so the half-translation helps nobody.
  const whole = translated.every((w, i) => w !== words[i] || /^\d/.test(w) || /^[А-ЯІЇЄҐ]/.test(w) || words.length === 1);
  if (whole && words.some((w, i) => translated[i] !== w)) add(translated.join(' '));
  return [...out.values()].sort().slice(0, 4);
}

// ---- Output -------------------------------------------------------------------------------

/** One file's JSON text: header, then one entry per line, so a rebuild shows as a readable diff. */
export function serializeFile({ list, entries, built, cities = null }) {
  const sorted = [...entries].sort((a, b) => {
    const ka = fold(a.k), kb = fold(b.k);
    return ka < kb ? -1 : ka > kb ? 1 : (a.ty ?? '') < (b.ty ?? '') ? -1 : (a.ty ?? '') > (b.ty ?? '') ? 1 : (a.is ?? '') < (b.is ?? '') ? -1 : 1;
  });
  const codes = new Set();
  for (const e of sorted) for (const t of e.t) for (const s of t.s) codes.add(s);
  const src = Object.fromEntries(SOURCE_ORDER.filter((c) => codes.has(c)).map((c) => [c, SOURCE_LEGEND[c]]));
  const head = { v: 1, list: list.kind === 'settlement' ? 'settlements' : 'streets', n: list.titles.length, built };
  if (cities) head.cities = cities;
  head.src = src;
  const headText = JSON.stringify(head).slice(0, -1);
  return `${headText},"a":[\n${sorted.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`;
}
