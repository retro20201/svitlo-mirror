/**
 * The COMMITTED alias files (the ones the app downloads), against the gate and against the cases the
 * design names. They fail when a rebuild loses one of them, and when the lists move under them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAliases, checkCorpus, findAliasFiles, CORPUS, DEFAULT_ADDR } from './check-aliases.mjs';
import { readTsv } from './aliases/tsv.mjs';
import { SOURCE_COLUMNS } from './aliases/rows.mjs';

// ---- the committed files ---------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const live = async () => {
  const load = async (rel) => JSON.parse(await readFile(join(DEFAULT_ADDR, rel), 'utf8'));
  return { load };
};
const normalize = (s) => String(s).replace(/[\s ]+/g, ' ').trim();

test('the committed files pass the gate, including the permanence of every target against git', async () => {
  const { errors, stats } = await checkAliases({});
  assert.deepEqual(errors, []);
  assert.ok(stats.files >= 100 && stats.entries >= 5000, JSON.stringify(stats));
  assert.ok(stats.bytes < 2 * 1024 * 1024);
});

test('corpus: every renamed-name query of the audit finds its street, and with the audit\'s own labels 88 to 97 of 103 did', async () => {
  const files = await findAliasFiles(DEFAULT_ADDR);
  const corrected = await checkCorpus({ addr: DEFAULT_ADDR, corpus: CORPUS, files });
  assert.deepEqual(corrected.errors, []);
  assert.equal(corrected.summary.cases, 103);
  assert.equal(corrected.summary.rescued, 103);

  // The same queries against the labels as the audit wrote them: the six doubtful ones were wrong.
  const cases = await readTsv(CORPUS);
  const corrections = cases.filter((c) => c.was);
  assert.deepEqual(corrections.map((c) => c.id), ['K-108', 'IR-344', 'IR-345', 'IR-346', 'DN-418', 'DN-427']);
  const original = join(await mkdtemp(join(tmpdir(), 'corpus-')), 'original.tsv');
  const text = ['id\tlist\tquery\texpected\twas\tnote', ...cases.map((c) => [c.id, c.list, c.query, c.was || c.expected, '', ''].join('\t'))].join('\n');
  await writeFile(original, text);
  try {
    const asLabelled = await checkCorpus({ addr: DEFAULT_ADDR, corpus: original, files });
    assert.ok(asLabelled.summary.rescued >= 88 && asLabelled.summary.rescued <= 97, `${asLabelled.summary.rescued} of 103`);
    assert.deepEqual(asLabelled.summary.missed.sort(), corrections.map((c) => c.id).sort());
  } finally { await rm(dirname(original), { recursive: true, force: true }); }
});

test('golden: Kyiv — Горького lists its streets with districts; Щорса has several; Толстого is a namesake and not sure', async () => {
  const { load } = await live();
  const aliases = await load('kyiv/aliases.json');
  const streets = await load('kyiv/streets.json');
  const find = (k, ty) => aliases.a.find((e) => e.k === k && e.ty === ty && !e.is);
  const gorky = find('Горького', 'вул.');
  assert.ok(gorky.t.length >= 5);
  assert.ok(gorky.t.every((t) => t.d && t.y));
  assert.deepEqual(gorky.t.slice(0, 2).map((t) => normalize(streets[t.i])), ['вул. Антоновича', 'вул. Осьмачки Тодося']);
  assert.ok(gorky.t[0].d.includes('Голосіївський'));
  assert.ok(find('Щорса', 'вул.').t.length >= 4);
  assert.deepEqual(find('Щорса', 'вул.').t.map((t) => normalize(streets[t.i])).slice(0, 4).sort(), ['вул. Ейхельмана Професора', 'вул. Князів Острозьких', 'вул. Коновальця Євгена', 'вул. Модзалевського Вадима']);
  const tolstoy = find('Толстого', 'вул.');
  assert.equal(tolstoy.sure, undefined);
  assert.ok(tolstoy.t.every((t) => t.f.includes('both')));
});

test('golden: Kyiv — Перемоги keeps the avenue, the square and the street that is still current apart', async () => {
  const { load } = await live();
  const aliases = await load('kyiv/aliases.json');
  const streets = await load('kyiv/streets.json');
  const pick = (ty) => aliases.a.filter((e) => e.k === 'Перемоги' && e.ty === ty && !e.is);
  assert.deepEqual(pick('просп.').map((e) => normalize(streets[e.t[0].i])), ['просп. Берестейський']);
  assert.deepEqual(pick('пл.').map((e) => normalize(streets[e.t[0].i])), ['пл. Галицька']);
  assert.equal(pick('вул.').length, 0); // вул. Перемоги is a current street, not a former name of anything
  assert.ok(streets.map(normalize).includes('вул. Перемоги'));
});

test('golden: Kyiv — spellings fold (Ґедройця/Гедройця, Лук’яненка/Лук\'яненка) and Скоропадського keeps both records', async () => {
  const { load } = await live();
  const aliases = await load('kyiv/aliases.json');
  const streets = (await load('kyiv/streets.json')).map(normalize);
  const tver = aliases.a.find((e) => e.k === 'Тверська');
  assert.deepEqual(tver.t.map((t) => streets[t.i]), ['вул. Гедройця Єжи']);
  const tymoshenko = aliases.a.find((e) => e.k === 'Тимошенка Маршала');
  assert.deepEqual(tymoshenko.t.map((t) => streets[t.i]).sort(), ['вул. Левка Лук\'яненка', 'вул. Лук’яненка Левка']); // two spellings of one street
  assert.ok(tymoshenko.t.every((t) => t.f.includes('twin')));
  const tolstoy = aliases.a.find((e) => e.k === 'Толстого' && e.ty === 'вул.');
  assert.deepEqual(tolstoy.t.map((t) => streets[t.i]).filter((s) => /Скоропадського/.test(s)).sort(), ['вул. Скоропадського', 'вул. Скоропадського Павла Гетьмана']);
});

test('golden: Kyiv — the operator still lists the old name, so the current name is the key (is: current)', async () => {
  const { load } = await live();
  const aliases = await load('kyiv/aliases.json');
  const streets = (await load('kyiv/streets.json')).map(normalize);
  const e = aliases.a.find((x) => x.k === 'Українських Героїв' && x.is === 'current');
  assert.deepEqual(e.t.map((t) => streets[t.i]), ['пл. Льва Толстого']);
});

test('golden: Kyiv — a street that was never renamed has no alias, and a 19th-century name is not one', async () => {
  const { load } = await live();
  const aliases = await load('kyiv/aliases.json');
  assert.equal(aliases.a.some((e) => e.k === 'Хрещатик'), false);
  // Шевченка was the name of several streets renamed since 2017: they are suggestions below the real street, never sure.
  for (const e of aliases.a.filter((x) => x.k === 'Шевченка')) {
    assert.equal(e.sure, undefined);
    assert.ok(e.t.every((t) => t.f?.includes('both')));
  }
});

test('golden: Dnipro — «ріг» corner records are never targets; Яворницького keeps both records', async () => {
  const { load } = await live();
  const aliases = await load('dnipro/c/45/aliases.json');
  const streets = (await load('dnipro/c/45/streets.json')).map(normalize);
  for (const e of aliases.a) for (const t of e.t) assert.doesNotMatch(streets[t.i], /^ріг /);
  const marx = aliases.a.find((e) => e.k === 'Карла Маркса' && e.ty === 'просп.');
  assert.deepEqual(marx.t.map((t) => streets[t.i]).sort(), ['просп. Дмитра Яворницького', 'просп. Яворницького Дмитра']);
  assert.ok(marx.t.every((t) => t.f.includes('twin')));
  assert.equal(marx.sure, undefined);
});

test('golden: Odesa region — м. Південне is not с. Південне; Захарівка lists both records', async () => {
  const { load } = await live();
  const aliases = await load('odesa/aliases.json');
  const settlements = (await load('odesa/settlements.json')).map(normalize);
  const south = aliases.a.find((e) => e.k === 'Южне');
  assert.deepEqual(south.t.map((t) => settlements[t.i]), ['м. Південне']);
  assert.equal(south.sure, true);
  const frunze = aliases.a.find((e) => e.k === 'Фрунзівка');
  assert.deepEqual(frunze.t.map((t) => settlements[t.i]).sort(), ['с-ще Захарівка', 'смт Захарівка']);
  assert.ok(frunze.t.every((t) => t.f.includes('twin')));
});

test('golden: Kyiv oblast — Макаренка (Boryspil) and Металургів (Brovary) resolve the other way round', async () => {
  const { load } = await live();
  for (const [city, current, listed] of [[60, 'Олега Антонова', 'вул. Макаренка'], [62, '136-го батальйону', 'вул. Металургів']]) {
    const aliases = await load(`kyiv-region/c/${city}/aliases.json`);
    const streets = (await load(`kyiv-region/c/${city}/streets.json`)).map(normalize);
    const e = aliases.a.find((x) => x.k === current && x.is === 'current');
    assert.deepEqual(e.t.map((t) => streets[t.i]), [listed]);
    assert.equal(e.sure, undefined); // OSM alone
  }
});

test('golden: every file lists only streets it has, and every Kyiv-oblast village file is listed in cities', async () => {
  const files = await findAliasFiles(DEFAULT_ADDR);
  const byRegion = new Map();
  for (const f of files) if (f.c !== undefined) byRegion.set(f.region, [...(byRegion.get(f.region) ?? []), f.c]);
  for (const [region, cs] of byRegion) {
    const data = JSON.parse(await readFile(join(DEFAULT_ADDR, region, 'aliases.json'), 'utf8'));
    assert.deepEqual([...data.cities].sort((a, b) => a - b), cs.sort((a, b) => a - b), region);
  }
});

test('the source tables are the form the builder reads: columns, sorted, every row with a code', async () => {
  const dir = join(here, 'aliases', 'sources');
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.tsv'))) {
    const text = await readFile(join(dir, f), 'utf8');
    const header = text.split('\n').find((l) => l && !l.startsWith('#'));
    assert.equal(header, SOURCE_COLUMNS.join('\t'), f);
    for (const r of await readTsv(join(dir, f))) {
      assert.ok(['vr', 'loc', 'wp', 'osm', 'rdp', 'man'].includes(r.src), `${f}: ${r.src}`);
      assert.ok(r.url && r.fetched, `${f}: a row without provenance`);
    }
  }
});

test('two queries the audit filed as «absent» are found now: Тарутино → Бессарабське and Екатерининская → Європейська', async () => {
  const { load } = await live();
  const settlements = (await load('odesa/settlements.json')).map(normalize);
  const regional = await load('odesa/aliases.json');
  const tarutyne = regional.a.find((e) => e.k === 'Тарутине');
  assert.deepEqual(tarutyne.t.map((t) => settlements[t.i]), ['с-ще Бессарабське']);
  assert.deepEqual(tarutyne.ru, ['Тарутино']);
  const odesa = (await load('odesa/settlements.json')).findIndex((s) => normalize(s) === 'м. Одеса');
  const streets = (await load(`odesa/c/${odesa}/streets.json`)).map(normalize);
  const aliases = await load(`odesa/c/${odesa}/aliases.json`);
  const katerynynska = aliases.a.find((e) => e.k === 'Катерининська' && e.ty === 'пл.');
  assert.deepEqual(katerynynska.t.map((t) => streets[t.i]), ['пл. Європейська']);
});

test('a hand-written pair joins like any other: Проскурів is Хмельницький', async () => {
  const { load } = await live();
  const settlements = (await load('khmelnytskyi/settlements.json')).map(normalize);
  const e = (await load('khmelnytskyi/aliases.json')).a.find((x) => x.k === 'Проскурів');
  assert.deepEqual(e.t.map((t) => [settlements[t.i], t.s]), [['Хмельницький', ['man']]]);
  assert.equal(e.sure, undefined);
});
