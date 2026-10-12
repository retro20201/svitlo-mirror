/**
 * The alias builder and its gate: the join rules on small invented lists, the gate's every refusal on
 * invented files, and a set of golden cases on the COMMITTED files (the ones the app downloads).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readList, readRow } from './aliases/operator.mjs';
import { buildAliases, joinName, serializeFile, collectRussian, displayKey, MIN_YEAR, NO_PLACE } from './aliases/build-core.mjs';
import { checkAliases, MAX_FILE_BYTES } from './check-aliases.mjs';
import { row } from './aliases/rows.mjs';
import { parseName } from './aliases/text.mjs';

// ---- helpers ---------------------------------------------------------------------------------

/** An operator with one flat region (`kyiv`) and one nested region (`dnipro`, city 0 = «м. Дніпро»). */
function operator({ kyiv = [], streets = [], settlements = [] } = {}) {
  return new Map([
    ['kyiv', { id: 'kyiv', dir: 'kyiv', shape: 'flat', streets: readList(kyiv, 'street'), cities: new Map() }],
    ['dnipro', {
      id: 'dnipro', dir: 'dnipro', shape: 'nested',
      settlements: readList(['м. Дніпро', ...settlements], 'settlement'),
      cities: new Map([[0, readList(streets, 'street')]])
    }]
  ]);
}

const src = (scope, oldName, newName, extra = {}) => row({
  list: 'streets', scope, old_type: 'вул.', old_name: oldName, new_type: 'вул.', new_name: newName, src: 'wp', year: '2022', ...extra
});
const st = (oldName, newName, extra) => src('dnipro/dnipro', oldName, newName, extra);
const houses = async (dir, i) => 10 + i;

async function build(op, rows, extra = {}) {
  const result = await buildAliases({ operator: op, rows, houses, ...extra });
  const byId = Object.fromEntries(result.outputs.map((o) => [o.id, o]));
  return { ...result, byId, city: byId['dnipro/city/0'], kyiv: byId['kyiv/kyiv'], settlements: byId['dnipro/settlements'] };
}
const entryOf = (out, key, ty) => out?.entries.find((e) => e.entry.k === key && (ty === undefined || e.entry.ty === ty))?.entry;

// ---- joining ---------------------------------------------------------------------------------

test('T1: the same kind and the same words, in any order; rows of one key are one street (twins)', async () => {
  const op = operator({ streets: ['просп. Яворницького Дмитра', 'просп. Дмитра Яворницького', 'вул. Яворницького'] });
  const r = await build(op, [src('dnipro/dnipro', 'Карла Маркса', 'Дмитра Яворницького', { old_type: 'просп.', new_type: 'просп.' })]);
  const e = entryOf(r.city, 'Карла Маркса');
  assert.deepEqual(e.t.map((t) => t.i), [1, 0]); // by houses, then index: 11 then 10
  assert.deepEqual(e.t.map((t) => t.f), [['twin'], ['twin']]);
  assert.equal(e.sure, undefined);
  assert.ok(e.t.every((t) => t.d === NO_PLACE)); // two targets: each says where, or that the source does not
});

test('T1 respects the kind: просп. Південне is not вул. Південне; a lone other kind is accepted as a retype', async () => {
  const op = operator({ streets: ['просп. Науки', 'вул. Південна', 'пров. Південна'] });
  const r = await build(op, [
    st('Гагаріна', 'Науки'), // the source says вул., the operator has only просп.: the only candidate, flagged retype
    st('Радянська', 'Південна') // two Південна rows of other kinds... but вул. is there: exact
  ]);
  assert.deepEqual(entryOf(r.city, 'Гагаріна').t[0].f, ['retype']);
  assert.deepEqual(entryOf(r.city, 'Радянська').t.map((t) => t.i), [1]);
});

test('T2: a short form is accepted only when exactly one street fits; two fitting streets are a report line', async () => {
  const one = operator({ streets: ['вул. Скоропадського Павла Гетьмана', 'вул. Лісова'] });
  const a = await build(one, [st('Толстого', 'Скоропадського')]);
  assert.deepEqual(entryOf(a.city, 'Толстого').t.map((t) => t.i), [0]);
  assert.equal(entryOf(a.city, 'Толстого').sure, undefined); // a short-form join never auto-picks
  assert.equal(a.report.joinedShort.length, 1);

  const two = operator({ streets: ['вул. Шевченка Тараса', 'вул. Шевченка Миколи'] });
  const b = await build(two, [st('Горького', 'Шевченка')]);
  assert.equal(b.city, undefined);
  assert.equal(b.report.ambiguous.length, 1);
  assert.match(b.report.ambiguous[0].candidates, /Шевченка Тараса.*Шевченка Миколи|Шевченка Миколи.*Шевченка Тараса/);
});

test('T2 never takes a number for a longer name: «Садова» is not «Садова 154»', () => {
  const list = readList(['вул. Садова 154', 'вул. Садова 155'], 'street');
  assert.equal(joinName(list, 'вул.', parseName('Садова').tokens).rows.length, 0);
});

test('T3: manual/joins.tsv names the row', async () => {
  const op = operator({ streets: ['вул. Глибока Балка', 'вул. Якась'] });
  const r = await build(op, [st('Горького', 'Глибока')], { joins: [{ scope: 'dnipro/dnipro', side: 'new', type: 'вул.', name: 'Глибока', title: 'вул. Якась' }] });
  assert.deepEqual(entryOf(r.city, 'Горького').t.map((t) => t.i), [1]);
});

test('a corner record is never a target, and a row without a type is not a street', async () => {
  const op = operator({ streets: ['ріг вул. Леваневського/пр. Калініна', 'Дарницький р-н, вул. Лугова', 'Нова', 'вул. Лугова'] });
  const r = await build(op, [st('Калініна', 'Лугова')]);
  assert.deepEqual(entryOf(r.city, 'Калініна').t.map((t) => t.i), [3]);
  assert.equal(readRow('ріг вул. А/пр. Б', 0, 'street').eligible, false);
  assert.equal(readRow('Дарницький р-н, вул. Лугова', 0, 'street').eligible, false);
  assert.equal(readRow('с-т Весна', 0, 'street').eligible, false);
});

test('a short and a long spelling of one street are both targets; a plain noun is not a long form', async () => {
  const op = operator({ streets: ['вул. Гоголя', 'вул. Гоголя Миколи', 'вул. Лугова', 'вул. Лугова Балка'] });
  const r = await build(op, [st('Леніна', 'Гоголя Миколи'), st('Кірова', 'Лугова')]);
  assert.deepEqual(entryOf(r.city, 'Леніна').t.map((t) => [t.i, t.f]), [[1, ['twin']], [0, ['twin']]]);
  assert.deepEqual(entryOf(r.city, 'Кірова').t.map((t) => t.i), [2]);
});

// ---- direction -------------------------------------------------------------------------------

test('forward: the new name is listed → the old name is a former name of it', async () => {
  const op = operator({ streets: ['вул. Велика Васильківська'] });
  const r = await build(op, [st('Червоноармійська', 'Велика Васильківська')]);
  const e = entryOf(r.city, 'Червоноармійська');
  assert.equal(e.is, undefined);
  assert.equal(e.ty, 'вул.');
});

test('reverse: only the old name is listed → the current name is the key, marked is: current', async () => {
  const op = operator({ streets: ['вул. Макаренка'] });
  const r = await build(op, [st('Макаренка', 'Олега Антонова', { src: 'osm' })]);
  const e = entryOf(r.city, 'Олега Антонова');
  assert.equal(e.is, 'current');
  assert.deepEqual(e.t.map((t) => t.i), [0]);
  assert.equal(entryOf(r.city, 'Макаренка'), undefined);
});

test('both listed: the old name keeps being a row of its own; the alias says so and is never sure', async () => {
  const op = operator({ streets: ['просп. Науки', 'просп. Гагаріна'] });
  const r = await build(op, [st('Гагаріна', 'Науки', { old_type: 'просп.', new_type: 'просп.', src: 'vr' })]);
  const e = entryOf(r.city, 'Гагаріна');
  assert.deepEqual(e.t[0].f, ['both']);
  assert.equal(e.sure, undefined);
});

test('neither listed: nothing is published and the pair is in the report', async () => {
  const op = operator({ streets: ['вул. Лісова'] });
  const r = await build(op, [st('Гагаріна', 'Науки')]);
  assert.equal(r.city, undefined);
  assert.equal(r.report.unmatched.length, 1);
  assert.equal(r.report.dropped.unmatched, 1);
});

test('a name renamed twice points at the row the operator lists; the middle name is an alias too', async () => {
  const op = operator({ streets: ['вул. Білодідівка'] });
  const r = await build(op, [st('Робоча', 'Робітнича', { year: '2015' }), st('Робітнича', 'Білодідівка', { year: '2022', src: 'loc' })]);
  assert.deepEqual(entryOf(r.city, 'Робоча').t.map((t) => [t.i, t.s]), [[0, ['loc', 'wp']]]);
  assert.deepEqual(entryOf(r.city, 'Робітнича').t.map((t) => t.i), [0]);
});

test('a rename back to the old name (a cycle) is not an alias of itself', async () => {
  const op = operator({ streets: ['вул. Московська'] });
  const r = await build(op, [st('Московська', 'Московська', { year: '2022' })]);
  assert.equal(r.city, undefined);
  assert.equal(r.report.dropped['same-name'], 1);
});

// ---- settlements -----------------------------------------------------------------------------

test('settlements: the kind separates м. Південне from с. Південне; смт and с-ще are one kind and both listed', async () => {
  const op = operator({ settlements: ['м. Південне', 'с. Південне', 'с-ще Захарівка', 'смт Захарівка'] });
  const rows = [
    row({ list: 'settlements', scope: 'dnipro', old_type: 'м.', old_name: 'Южне', new_type: 'м.', new_name: 'Південне', district: 'Одеський р-н', year: '2024', src: 'vr' }),
    row({ list: 'settlements', scope: 'dnipro', old_type: 'смт', old_name: 'Фрунзівка', new_type: 'смт', new_name: 'Захарівка', district: 'Фрунзівський р-н', year: '2016', src: 'vr' })
  ];
  const r = await build(op, rows);
  const south = entryOf(r.settlements, 'Южне');
  assert.deepEqual(south.t.map((t) => t.i), [1]);
  assert.equal(south.sure, true);
  const frunze = entryOf(r.settlements, 'Фрунзівка');
  assert.deepEqual(frunze.t.map((t) => [t.i, t.d, t.f]), [[3, 'Фрунзівський р-н', ['twin']], [4, 'Фрунзівський р-н', ['twin']]]);
  assert.equal(frunze.sure, undefined);
});

test('a village a council table names is joined to its own streets, and only if exactly one settlement has that name', async () => {
  const op = operator({ settlements: ['с. Глибоке', 'с. Іванків', 'с. Іванків'] });
  op.get('dnipro').cities.set(1, readList(['вул. Козацька'], 'street'));
  op.get('dnipro').cities.set(2, readList(['вул. Козацька'], 'street'));
  op.get('dnipro').cities.set(3, readList(['вул. Козацька'], 'street'));
  const rows = [st('Суворова', 'Козацька', { scope: 'dnipro/~с. Глибоке' }), st('Кутузова', 'Козацька', { scope: 'dnipro/~с. Іванків' })];
  const r = await build(op, rows);
  assert.ok(r.byId['dnipro/city/1']);
  assert.equal(r.byId['dnipro/city/2'], undefined);
  assert.equal(r.report.dropped['village-ambiguous'], 1);
});

// ---- sure ------------------------------------------------------------------------------------

test('sure: one unflagged target, an official source or Wikipedia and OSM together, an exact join', async () => {
  const op = operator({ streets: ['вул. А-перша', 'вул. Б-друга', 'вул. В-третя'] });
  const r = await build(op, [
    st('Стара-один', 'А-перша', { src: 'vr' }),
    st('Стара-два', 'Б-друга', { src: 'wp' }),
    st('Стара-три', 'В-третя', { src: 'wp' }), st('Стара-три', 'В-третя', { src: 'osm' })
  ]);
  assert.equal(entryOf(r.city, 'Стара-один').sure, true);
  assert.equal(entryOf(r.city, 'Стара-два').sure, undefined);
  assert.equal(entryOf(r.city, 'Стара-три').sure, true);
});

test('sure is withheld for a name that is also a current street, and for a name the sources give to another street', async () => {
  const op = operator({ streets: ['вул. Толстого', 'вул. Скоропадського', 'вул. Коновальця'] });
  const r = await build(op, [
    st('Толстого', 'Скоропадського', { src: 'loc' }),
    st('Щорса', 'Коновальця', { src: 'loc' }),
    st('Щорса', 'Кринична', { src: 'loc' }) // not in the operator's list, but the name is shared
  ]);
  assert.equal(entryOf(r.city, 'Толстого').sure, undefined);
  assert.equal(entryOf(r.city, 'Щорса').sure, undefined);
  assert.equal(entryOf(r.city, 'Щорса').t.length, 1); // only the listed street is a target
});

test('rename.dp.ua is never the only witness; with another source it is just a code', async () => {
  const op = operator({ streets: ['вул. Нова-а', 'вул. Нова-б'] });
  const r = await build(op, [st('Одна', 'Нова-а', { src: 'rdp' }), st('Друга', 'Нова-б', { src: 'rdp' }), st('Друга', 'Нова-б', { src: 'wp' })]);
  assert.equal(entryOf(r.city, 'Одна'), undefined);
  assert.equal(r.report.dropped['rdp-only'], 1);
  assert.deepEqual(entryOf(r.city, 'Друга').t[0].s, ['wp', 'rdp']);
});

// ---- policy ----------------------------------------------------------------------------------

test('rows from before 1991, vetoed pairs, placeholders and non-Cyrillic keys never get in; every row is accounted for', async () => {
  const op = operator({ streets: ['вул. Нова-а', 'вул. Нова-б', 'вул. Нова-в'] });
  const rows = [
    st('Давня', 'Нова-а', { year: '1955' }),
    st('Вето', 'Нова-б'),
    st('Нова 400-та', 'Нова-в'),
    st('Pushkina', 'Нова-в'),
    st('До 2014 — Калініна', 'Нова-в'),
    st('Добра', 'Нова-в', { year: '2022' })
  ];
  const r = await build(op, rows, { vetoes: [{ scope: 'dnipro/dnipro', old_name: 'Вето', new_name: 'Нова-б' }] });
  assert.deepEqual(r.city.entries.map((e) => e.entry.k), ['Добра']);
  assert.equal(r.report.dropped[`before-${MIN_YEAR}`], 1);
  assert.equal(r.report.dropped.veto, 1);
  assert.equal(r.report.dropped['junk-key'], 1);
  assert.equal(r.report.dropped['non-cyrillic'], 1);
  assert.equal(r.report.dropped['implausible-key'], 1);
  const dropped = Object.values(r.report.dropped).reduce((a, b) => a + b, 0);
  assert.equal(r.report.used + dropped, r.report.input);
});

test('the same pair in two sources is one pair with both codes; districts come from the best source', async () => {
  const op = operator({ streets: ['вул. Нова-а'] });
  const r = await build(op, [
    st('Стара', 'Нова-а', { src: 'wp', district: 'Центральний' }),
    st('Стара', 'Нова-а', { src: 'osm' }),
    st('Стара', 'Нова-а', { src: 'loc', district: 'Соборний' })
  ]);
  const e = entryOf(r.city, 'Стара');
  assert.deepEqual(e.t[0].s, ['loc', 'wp', 'osm']);
  assert.equal(e.t[0].d, 'Соборний');
  assert.equal(e.sure, true);
});

test('keys are shown with a capital letter and the typographic apostrophe', () => {
  assert.equal(displayKey("жуковського"), 'Жуковського');
  assert.equal(displayKey("Лук'яненка"), 'Лук’яненка');
});

// ---- Russian forms ---------------------------------------------------------------------------

test('ru: only what the app\'s folding cannot derive is stored; the Soviet vocabulary comes from ru.tsv', () => {
  const russian = [{ kind: 'word', uk: 'Червоноармійська', ru: 'Красноармейская' }, { kind: 'name', uk: 'Іллічівськ', ru: 'Ильичевск; Ильичёвск' }];
  assert.deepEqual(collectRussian('Червоноармійська', new Set(), russian), ['Красноармейская']);
  assert.deepEqual(collectRussian('Іллічівськ', new Set(), russian), ['Ильичёвск']); // Е and Ё are one word to the app
  assert.deepEqual(collectRussian('Московський', new Set(['Московский']), russian), []); // derivable
  assert.deepEqual(collectRussian('Ватутіна', new Set(['Ватутина', 'Ватутін']), russian), ['Ватутін']);
  assert.deepEqual(collectRussian('25-річчя Жовтня', new Set(), [{ kind: 'word', uk: 'Жовтня', ru: 'Октября' }]), ['25-летия Октября']);
});

// ---- output ----------------------------------------------------------------------------------

test('a file is one entry per line, with only the codes it uses in src, and a rebuild is byte-identical', async () => {
  const op = operator({ streets: ['вул. Нова-а'] });
  const rows = [st('Бета-стара', 'Нова-а'), st('Альфа-стара', 'Нова-а', { src: 'osm' })];
  const a = await build(op, rows);
  const text = serializeFile({ list: a.city.list, entries: a.city.entries.map((e) => e.entry), built: '2026-10-12' });
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 4); // header, two entries, close
  assert.deepEqual(Object.keys(JSON.parse(text).src), ['wp', 'osm']);
  assert.deepEqual(JSON.parse(text).a.map((e) => e.k), ['Альфа-стара', 'Бета-стара']);
  const b = await build(op, rows.slice().reverse());
  assert.equal(serializeFile({ list: b.city.list, entries: b.city.entries.map((e) => e.entry), built: '2026-10-12' }), text);
});

// ---- the gate --------------------------------------------------------------------------------

/** A tiny addr dir: kyiv with 4 streets and an aliases.json built by `mutate`. */
async function gateFixture(mutate = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aliases-gate-'));
  const streets = ['вул. Велика Васильківська', 'вул. Заплавна', 'вул. Толстого', 'ріг вул. А/пр. Б'];
  await mkdir(join(dir, 'kyiv'), { recursive: true });
  await writeFile(join(dir, 'kyiv', 'streets.json'), JSON.stringify(streets));
  const file = {
    v: 1, list: 'streets', n: 4, built: '2026-10-12', src: { wp: 'x', osm: 'y', rdp: 'z' },
    a: [
      { k: 'Червоноармійська', ty: 'вул.', t: [{ i: 0, d: 'Печерський', h: 5, s: ['wp'] }, { i: 1, d: 'Дарницький', h: 3, s: ['wp'] }] },
      { k: 'Горького', ty: 'вул.', sure: true, t: [{ i: 0, s: ['wp', 'osm'] }] }
    ]
  };
  mutate(file);
  await writeFile(join(dir, 'kyiv', 'aliases.json'), JSON.stringify(file));
  await writeFile(join(dir, 'index.json'), JSON.stringify({ kyiv: { shape: 'flat', streets: 4, built: 4, addresses: 0, aliases: true, aliasKeys: file.a.length } }));
  return dir;
}

const problems = async (mutate, extra = {}) => {
  const dir = await gateFixture(mutate);
  try { return (await checkAliases({ addr: dir, useGit: false, corpus: '/nonexistent', ...extra })).errors; } finally { await rm(dir, { recursive: true, force: true }); }
};

test('gate: a sound file passes', async () => {
  assert.deepEqual(await problems(() => {}), []);
});

test('gate: schema — version, list, n against the list, codes, dates', async () => {
  assert.match((await problems((f) => { f.v = 2; })).join(), /v is 2/);
  assert.match((await problems((f) => { f.list = 'settlements'; })).join(), /list is "settlements"/);
  assert.match((await problems((f) => { f.n = 5; })).join(), /n is 5, the list has 4 rows/);
  assert.match((await problems((f) => { f.built = 'yesterday'; })).join(), /built is/);
  assert.match((await problems((f) => { f.a[0].t[0].s = ['zzz']; })).join(), /code "zzz" is not in src/);
});

test('gate: targets — in range, a real street, not the key itself, a district when there are several, sources', async () => {
  assert.match((await problems((f) => { f.a[0].t[1].i = 9; })).join(), /target 9 is outside 0\.\.3/);
  assert.match((await problems((f) => { f.a[0].t[1].i = 3; })).join(), /not a street/);
  assert.match((await problems((f) => { delete f.a[0].t[1].d; })).join(), /has no d among 2/);
  assert.match((await problems((f) => { f.a[0].t[0].s = []; })).join(), /no source codes/);
  assert.match((await problems((f) => { f.a[0].t[0].s = ['rdp']; })).join(), /rename\.dp\.ua alone/);
  assert.match((await problems((f) => { f.a.push({ k: 'Толстого', ty: 'вул.', t: [{ i: 2, s: ['wp'] }] }); })).join(), /the key itself/);
  assert.match((await problems((f) => { f.a[0].t = Array.from({ length: 13 }, (_, i) => ({ i: i % 3, d: String(i), s: ['wp'] })); })).join(), /13 targets/);
});

test('gate: keys — Cyrillic, long enough, not a placeholder, not twice', async () => {
  assert.match((await problems((f) => { f.a[0].k = 'Pushkina'; })).join(), /3 Cyrillic letters/);
  assert.match((await problems((f) => { f.a[0].k = 'Нова 400-та'; })).join(), /placeholder/);
  assert.match((await problems((f) => { f.a[0].k = 'Арсенальна, Назва походить від слова'; })).join(), /a sentence, a list or a note/);
  assert.match((await problems((f) => { f.a.push({ ...f.a[1], sure: undefined }); })).join(), /twice/);
});

test('gate: sure — one target, no flag, an official source or two community ones, not a namesake', async () => {
  assert.match((await problems((f) => { f.a[1].t.push({ i: 1, d: 'x', s: ['wp', 'osm'] }); })).join(), /sure needs exactly one target/);
  assert.match((await problems((f) => { f.a[1].t[0].f = ['both']; })).join(), /sure with a flagged target/);
  assert.match((await problems((f) => { f.a[1].t[0].s = ['wp']; })).join(), /sure without an official source/);
  assert.match((await problems((f) => { f.a.push({ k: 'Толстого', ty: 'вул.', sure: true, t: [{ i: 1, s: ['wp', 'osm'] }] }); })).join(), /sure on a name that is a current street/);
  assert.deepEqual(await problems((f) => { f.a[1].t[0].s = ['loc']; f.src.loc = 'x'; }), []); // an official source alone is enough
});

test('gate: size and index.json', async () => {
  assert.match((await problems((f) => { f.a[0].ru = ['Красноармейская'.repeat(Math.ceil(MAX_FILE_BYTES / 15))]; })).join(), /over the/);
  const dir = await gateFixture();
  try {
    await writeFile(join(dir, 'index.json'), JSON.stringify({ kyiv: { shape: 'flat', streets: 4, built: 4, addresses: 0 }, odesa: { aliases: true, aliasKeys: 3 } }));
    const errors = (await checkAliases({ addr: dir, useGit: false, corpus: '/nonexistent' })).errors.join('\n');
    assert.match(errors, /kyiv has aliases files but no "aliases": true/);
    assert.match(errors, /odesa has no aliases files but carries aliases fields/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('gate: cities and the region file belong together', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aliases-gate-'));
  try {
    await mkdir(join(dir, 'dnipro', 'c', '0'), { recursive: true });
    await writeFile(join(dir, 'dnipro', 'settlements.json'), JSON.stringify(['м. Дніпро', 'м. Кривий Ріг']));
    await writeFile(join(dir, 'dnipro', 'c', '0', 'streets.json'), JSON.stringify(['вул. Нова-а']));
    await writeFile(join(dir, 'dnipro', 'c', '0', 'aliases.json'), JSON.stringify({ v: 1, list: 'streets', n: 1, built: '2026-10-12', src: { wp: 'x' }, a: [{ k: 'Стара', ty: 'вул.', t: [{ i: 0, s: ['wp'] }] }] }));
    await writeFile(join(dir, 'dnipro', 'aliases.json'), JSON.stringify({ v: 1, list: 'settlements', n: 2, built: '2026-10-12', cities: [1], src: {}, a: [] }));
    const errors = (await checkAliases({ addr: dir, useGit: false, corpus: '/nonexistent' })).errors.join('\n');
    assert.match(errors, /city 1 has no c\/1\/aliases\.json/);
    assert.match(errors, /c\/0\/aliases\.json exists but city 0 is not in cities/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

