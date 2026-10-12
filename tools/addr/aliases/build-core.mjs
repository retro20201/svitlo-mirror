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
 */
import { parseName, nameKey, fold, tidyName, isJunkName, letterCount, isCyrillicName, isPlausibleKey } from './text.mjs';
import { derivableRussian, russianKey, loose, ukrainianEndings } from './fold.mjs';
import { settlementsOf, parseScope } from './scopes.mjs';
import { GIVEN_NAMES } from './operator.mjs';

export const MIN_YEAR = 1991;
/** What `d` says when a multi-target entry's source gives no place for a target (OpenStreetMap and most council tables do not). */
export const NO_PLACE = 'місце не вказано';
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

/** Where a pair is: the districts of the best source that says (an act's old raion beats a wiki table's wording of it). */
function bestDistricts(pair) {
  for (const code of SOURCE_ORDER) if (pair.districtsBySrc.get(code)?.size) return pair.districtsBySrc.get(code);
  return [];
}
const sortedCodes = (set) => [...set].sort((a, b) => rankOf(a) - rankOf(b));

function mostCommon(counter) {
  let best = null;
  for (const [value, n] of counter) if (!best || n > best[1] || (n === best[1] && value < best[0])) best = [value, n];
  return best?.[0] ?? '';
}

// ---- 1. pairs -----------------------------------------------------------------------------

/** Source rows → merged pairs; a row that falls out goes to `drop(reason, row)`. */
export function makePairs(rows, { vetoes = [], minYear = MIN_YEAR, drop }) {
  const vetoed = new Set();
  for (const v of vetoes) {
    const kind = v.scope.includes('/') || v.scope === 'kyiv' ? 'street' : 'settlement';
    const oldKey = nameKey(parseName(v.old_name, kind).tokens);
    vetoed.add([v.scope, oldKey, v.new_name ? nameKey(parseName(v.new_name, kind).tokens) : '*'].join('|'));
  }
  const pairs = new Map();
  const ruRows = [];
  for (const r of rows) {
    const kind = KIND_OF_LIST[r.list];
    if (!kind) { drop('unknown-list', r); continue; }
    if (/(^|,)ruonly(,|$)/.test(r.flags)) { ruRows.push(r); continue; }
    const old = parseName(r.old_name, kind);
    const next = parseName(r.new_name, kind);
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
    const effOld = oldType || newType;
    const key = [r.list, r.scope, effOld, nameKey(old.tokens), newType, nameKey(next.tokens)].join('\u0001');
    let p = pairs.get(key);
    if (!p) {
      p = {
        key, list: r.list, kind, scope: r.scope,
        oldClass: effOld, oldExplicit: !!oldType, oldTokens: old.tokens, oldNames: new Map(),
        newClass: newType, newTokens: next.tokens, newNames: new Map(),
        districtsBySrc: new Map(), years: [], acts: new Set(), srcs: new Set(), flags: new Set(), ru: new Set(), rows: []
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
    if (r.act) p.acts.add(r.act);
    p.srcs.add(r.src);
    for (const f of r.flags.split(',').filter(Boolean)) p.flags.add(f);
    if (old.part) p.flags.add('part');
    if (r.ru) p.ru.add(r.ru);
    p.rows.push(r);
  }
  return { pairs: [...pairs.values()], ruRows };
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
  if (sameName.length === 1) return { rows: sameName, mode: cls ? 'relaxed' : 't1', flags: cls ? ['retype'] : [] };
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

function hasCurrentRow(list, cls, tokens) {
  const key = nameKey(tokens);
  if (list.typeless) return (list.byTokens.get(key) ?? []).length > 0;
  if (cls) return list.records.has(`${cls}|${key}`);
  return (list.byTokens.get(key) ?? []).length > 0;
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
  const { pairs, ruRows } = makePairs(rows, { vetoes, minYear, drop });

  // Other old keys' new names per scope, listed or not: a key that two streets have been called is never `sure`.
  const rivals = new Map();
  for (const p of pairs) {
    const k = [p.scope, p.oldClass, nameKey(p.oldTokens)].join('|');
    if (!rivals.has(k)) rivals.set(k, new Set());
    rivals.get(k).add(`${p.newClass}|${nameKey(p.newTokens)}`);
  }

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
        const oldRows = oldJoin.mode === 't1' || oldJoin.mode === 't3' ? oldJoin.rows.flat() : [];

        if (newJoin.rows.length) {
          const rowsOf = withShortForms(list, newJoin.rows);
          const flags = [...(newJoin.flags ?? [])];
          if (rowsOf.length > 1) flags.push('twin');
          if (oldRows.length) flags.push('both');
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
            addContribution(file, { direction: 'current', pair: p, chain: end.chain, name: currentName, cls: end.pair.newClass || p.newClass, tokens: end.pair.newTokens, rows: reverseRows, flags, mode: 'reverse' });
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
      entry = { direction: c.direction, ty: c.cls, tokens: c.tokens, names: new Map(), targets: new Map(), ru: new Set(), pairs: new Set(), scope: c.pair.scope };
      file.entries.set(mapKey, entry);
    }
    entry.names.set(c.name, (entry.names.get(c.name) ?? 0) + 1);
    const evidence = [c.pair, ...c.chain];
    for (const p of evidence) entry.pairs.add(p);
    for (const r of c.pair.ru) entry.ru.add(r);
    for (const row of c.rows) {
      let t = entry.targets.get(row.index);
      if (!t) {
        t = { index: row.index, row, districts: new Set(), years: [], srcs: new Set(), flags: new Set(), modes: new Set() };
        entry.targets.set(row.index, t);
      }
      for (const p of evidence) {
        for (const d of bestDistricts(p)) t.districts.add(d);
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
        const d = [...t.districts].sort().join(', ');
        if (d) target.d = d;
        const y = Math.max(0, ...t.years);
        if (y) target.y = y;
        if (file.kind !== 'settlements') target.h = await houses(dir, t.index);
        const f = FLAG_ORDER.filter((x) => t.flags.has(x));
        if (f.length) target.f = f;
        target.s = sortedCodes(t.srcs);
        targets.push({ target, modes: [...t.modes], locality: t.row.parsed.locality });
      }
      if (!targets.length) continue;
      targets.sort((a, b) => (b.target.h ?? 0) - (a.target.h ?? 0) || a.target.i - b.target.i);
      if (targets.length > MAX_TARGETS) report.notes.push(`${file.id}: «${name}» has ${targets.length} targets, ${MAX_TARGETS} kept`);
      const kept = targets.slice(0, MAX_TARGETS);
      // A target of a multi-target entry always says where it is, or that its sources do not say.
      if (kept.length > 1) {
        for (const t of kept) if (!t.target.d) t.target.d = t.locality || NO_PLACE;
      }
      const first = kept[0];
      const official = first.target.s.some((s) => OFFICIAL.has(s)) || (first.target.s.includes('wp') && first.target.s.includes('osm'));
      const namesake = e.direction === 'former' && hasCurrentRow(list, e.ty, e.tokens);
      const everyRival = e.direction === 'former' ? Math.max(0, (rivals.get([e.scope, e.ty, nameKey(e.tokens)].join('|'))?.size ?? 1) - 1) : 0;
      const sure = kept.length === 1 && official && !first.target.f?.length && !namesake && everyRival === 0
        && first.modes.every((m) => m === 't1' || m === 't3' || m === 'reverse');
      const entry = { k: name };
      if (e.ty) entry.ty = e.ty;
      const ru = collectRussian(name, e.ru, russian);
      if (ru.length) entry.ru = ru;
      if (e.direction === 'current') entry.is = 'current';
      if (sure) entry.sure = true;
      entry.t = kept.map((x) => x.target);
      entries.push({ entry, tokens: e.tokens, direction: e.direction, namesake, rivals: everyRival, modes: first.modes });
    }
    // A file with nothing in it is not published (the program that writes files removes a stale one).
    if (entries.length) outputs.push({ id: file.id, region: file.region, kind: file.kind, c: file.c, list, entries });
  }

  // ---- Russian forms from ru.wikipedia (Odesa) ------------------------------------------------
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
      if (out.kind !== 'city' || r.scope !== 'odesa/odesa' || out.region !== 'odesa') continue;
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
  if (words.some((w) => russianWord(w) !== w)) add(words.map(russianWord).join(' '));
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
