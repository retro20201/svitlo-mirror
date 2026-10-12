/**
 * The alias builder and its gate: the join rules on small invented lists, the gate's every refusal on
 * invented files, and a set of golden cases on the COMMITTED files (the ones the app downloads).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readList, readRow } from './aliases/operator.mjs';
import { buildAliases, joinName, serializeFile, collectRussian, displayKey, MIN_YEAR } from './aliases/build-core.mjs';
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
  assert.ok(e.t.every((t) => t.d === undefined)); // the source gives no place: nothing is printed in its stead
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
  // A street of a garden society, named in the brackets, is not a street of the town; a place or a district is no society.
  assert.equal(readRow('вул. Центральна (СТ "Дружба"-2)', 0, 'street').eligible, false);
  assert.equal(readRow('вул. Щаслива (СТСтадне)', 0, 'street').eligible, false);
  assert.equal(readRow('вул. Нижній Вал (Бортничі)', 0, 'street').eligible, true);
  assert.equal(readRow('вул. Весняна (Голосіївський р-н.)', 0, 'street').eligible, true);
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

// ---- sure: the rules the review of 2026-10-12 added ------------------------------------------

test('sure needs every hop proved: a Wikipedia-only first hop sinks a chain whose last hop is official', async () => {
  const op = operator({ streets: ['вул. Остання'] });
  const r = await build(op, [
    st('Перша', 'Середня', { src: 'wp', year: '2005' }),
    st('Середня', 'Остання', { src: 'loc', year: '2024' }), st('Середня', 'Остання', { src: 'osm' })
  ]);
  assert.deepEqual(entryOf(r.city, 'Перша').t.map((t) => t.i), [0]);
  assert.equal(entryOf(r.city, 'Перша').sure, undefined);
  assert.equal(entryOf(r.city, 'Середня').sure, true);
  const both = await build(op, [
    st('Перша', 'Середня', { src: 'wp' }), st('Перша', 'Середня', { src: 'osm' }),
    st('Середня', 'Остання', { src: 'loc' })
  ]);
  assert.equal(entryOf(both.city, 'Перша').sure, true);
});

test('a hop that only corrects a spelling is no evidence, and not a refusal either', async () => {
  const op = operator({ streets: ['вул. Кирилівська'] });
  const r = await build(op, [
    st('Короленко', 'Короленка', { src: 'wp' }),
    st('Короленка', 'Кирилівська', { src: 'osm' })
  ]);
  assert.equal(entryOf(r.city, 'Короленко').sure, undefined); // OSM alone says it
  const ok = await build(op, [
    st('Короленко', 'Короленка', { src: 'wp' }),
    st('Короленка', 'Кирилівська', { src: 'wp' }), st('Короленка', 'Кирилівська', { src: 'osm' })
  ]);
  assert.equal(entryOf(ok.city, 'Короленко').sure, true);
});

test('a current-name entry is not sure while another name the sources give the operator\'s old row is not listed', async () => {
  // Act 3984-IX: four villages were «Перше Травня»; the operator already lists two of the new names and has ONE row left.
  const op = operator({ settlements: ['с. Перше Травня', 'с. Гудимове', 'с. Димівка'] });
  const village = (name, d) => row({ list: 'settlements', scope: 'dnipro', old_type: 'с.', old_name: 'Перше Травня', new_type: 'с.', new_name: name, district: d, year: '2024', src: 'vr' });
  const two = await build(op, [village('Княже', 'Бориспільський р-н'), village('Роська', 'Білоцерківський р-н'), village('Гудимове', 'Обухівський р-н'), village('Димівка', 'Броварський р-н')]);
  assert.equal(entryOf(two.settlements, 'Княже').is, 'current');
  assert.equal(entryOf(two.settlements, 'Княже').sure, undefined);
  assert.equal(entryOf(two.settlements, 'Роська').sure, undefined);
  // Only one unlisted name left: the row is its.
  const one = await build(op, [village('Княже', 'Бориспільський р-н'), village('Гудимове', 'Обухівський р-н'), village('Димівка', 'Броварський р-н')]);
  assert.equal(entryOf(one.settlements, 'Княже').sure, true);
});

test('the operator lists the old name as a longer spelling: both is set and nothing is sure', async () => {
  const op = operator({ streets: ['вул. Гоголя Миколи', 'вул. Гірська', 'вул. Лумумби Патріса', 'вул. Лісова'] });
  const r = await build(op, [st('Гоголя', 'Гірська', { src: 'loc' }), st('Лумумби', 'Лісова', { src: 'loc' })]);
  assert.deepEqual(entryOf(r.city, 'Гоголя').t[0].f, ['both']);
  assert.equal(entryOf(r.city, 'Гоголя').sure, undefined);
  // «Патріса» is no first name the join knows, so no flag, but the key is not unknown to the operator either.
  assert.equal(entryOf(r.city, 'Лумумби').sure, undefined);
});

test('sure is withheld for a key that names a row of ANY kind, and for one the council lists as a current street', async () => {
  const op = operator({ settlements: ['смт Володарка', 'с. Левковичі', 'с. Інше'] });
  const r = await build(op, [row({ list: 'settlements', scope: 'dnipro', old_type: 'с.', old_name: 'Володарка', new_type: 'с.', new_name: 'Левковичі', district: 'Поліський р-н', year: '2024', src: 'vr' })]);
  assert.equal(entryOf(r.settlements, 'Володарка').sure, undefined);

  const streets = operator({ streets: ['вул. Амосова', 'вул. Інша'] });
  const rows = [st('Лесі Українки', 'Амосова', { src: 'loc' }), row({ list: 'streets', scope: 'dnipro/dnipro', new_type: 'вул.', new_name: 'Лесі Українки', src: 'loc', flags: 'census', url: 'u', fetched: 'f' })];
  const c = await build(streets, rows);
  assert.equal(entryOf(c.city, 'Лесі Українки').sure, undefined);
  const dropped = Object.values(c.report.dropped).reduce((a, b) => a + b, 0);
  assert.equal(c.report.used + dropped, c.report.input);
});

test('a decision undone by a later one is replaced: only the later pair is used', async () => {
  const op = operator({ streets: ['вул. Веделя Артема', 'вул. Друга'] });
  const r = await build(op, [
    st('Братська', 'Веделя Артема', { src: 'wp', act: 'Розпорядження ОДА від 26 липня 2024 року' }),
    st('Веделя Артема', 'Братська', { src: 'wp', act: 'Рішення міської ради від 18 грудня 2024 року' }),
    st('Веделя Артема', 'Братська', { src: 'osm' })
  ]);
  assert.equal(r.report.dropped.superseded, 1);
  const e = entryOf(r.city, 'Братська');
  assert.equal(e.is, 'current'); // the council gave the old name back; the operator still lists the July one
  assert.equal(e.sure, true);
  assert.equal(r.city.entries.filter((x) => x.entry.k === 'Братська').length, 1);
});

test('two pairs that undo each other with no dates between them stay, and neither is sure', async () => {
  const op = operator({ streets: ['пл. Незалежності', 'пл. Дерев’янка'], });
  const swap = (a, b) => st(a, b, { old_type: 'пл.', new_type: 'пл.', year: '2012' });
  const r = await build(op, [swap('Незалежності', 'Дерев’янка'), swap('Дерев’янка', 'Незалежності'), st('Незалежності', 'Дерев’янка', { old_type: 'пл.', new_type: 'пл.', src: 'osm', year: '2012' })]);
  for (const e of r.city.entries) assert.equal(e.entry.sure, undefined);
});

test('a row the operator qualifies with a district is not the street the source puts in another district', async () => {
  const op = operator({ streets: ['вул. Весняна', 'вул. Весняна (Голосіївський р-н.)', 'вул. Нова-а'] });
  const r = await build(op, [st('Делоне', 'Весняна', { district: 'Солом’янський' })]);
  assert.deepEqual(entryOf(r.city, 'Делоне').t.map((t) => t.i), [0]);
  const there = await build(op, [st('Делоне', 'Весняна', { district: 'Голосіївський' })]);
  assert.deepEqual(entryOf(there.city, 'Делоне').t.map((t) => t.i).sort(), [0, 1]); // the unqualified row is not ruled out
});

test('an abbreviated district in a qualifier («Поділ. р-н») still names its district', async () => {
  const op = operator({ streets: ['вул. Лінія (Поділ. р-н)', 'вул. Нова-а'] });
  assert.deepEqual(entryOf((await build(op, [st('Стара', 'Лінія', { district: 'Подільський' })])).city, 'Стара').t.map((t) => t.i), [0]);
  assert.equal((await build(op, [st('Стара', 'Лінія', { district: 'Дарницький' })])).city, undefined);
});

test('a qualifier that is not a district is printed as the place, not the source\'s district', async () => {
  const op = operator({ streets: ['вул. Нижній Вал', 'вул. Нижній Вал (Бортничі)'] });
  const r = await build(op, [st('Кімівська', 'Нижній Вал', { district: 'Подільський' })]);
  const byRow = Object.fromEntries(entryOf(r.city, 'Кімівська').t.map((t) => [t.i, t.d]));
  assert.equal(byRow[1], 'Бортничі');
  assert.equal(byRow[0], 'Подільський');
});

test('a kind written after the old name is its kind: «Дарницьке шосе» has no «вул.»; the word is not said twice', async () => {
  const op = operator({ streets: ['вул. Нова-а', 'вул. Нова-б'] });
  const r = await build(op, [
    st('Дарницьке шосе', 'Нова-а', { old_type: '' }),
    st('Білоруський проїзд', 'Нова-б', { old_type: 'проїзд' })
  ]);
  const shosse = r.city.entries.find((e) => e.entry.k === 'Дарницьке шосе').entry;
  assert.equal(shosse.ty, undefined);
  assert.equal(shosse.sure, undefined);
  const proizd = r.city.entries.find((e) => e.entry.k === 'Білоруський').entry;
  assert.equal(proizd.ty, 'проїзд');
});

test('districts: a misspelling joins the frequent label, a rare label that is no district goes, rename.dp.ua gives none', async () => {
  const labels = [];
  for (let i = 0; i < 100; i++) labels.push(['Індустріальний', `Стара${i}`, `Нова${i}`]);
  for (let i = 0; i < 6; i++) labels.push(['Індустріальній', `Хиба${i}`, `Хибна${i}`]);
  labels.push(['Гагаріна', 'Одна', 'Єдина']);
  const streets = [...labels.map((l) => `вул. ${l[2]}`), 'вул. Лише-рдп'];
  const op = operator({ streets });
  const rows = labels.map(([d, a, b]) => st(a, b, { district: d }));
  rows.push(st('Рдпшна', 'Лише-рдп', { src: 'rdp', district: 'Придумане' }), st('Рдпшна', 'Лише-рдп', { src: 'osm' }));
  const r = await build(op, rows);
  assert.equal(entryOf(r.city, 'Хиба3').t[0].d, 'Індустріальний');
  assert.equal(entryOf(r.city, 'Одна').t[0].d, undefined);
  assert.equal(entryOf(r.city, 'Рдпшна').t[0].d, undefined);
});

test('two old names of different districts on one village row: neither picks it', async () => {
  const op = operator({ settlements: ['с. Мирне', 'с. Інше'] });
  const village = (old, d) => row({ list: 'settlements', scope: 'dnipro', old_type: 'с.', old_name: old, new_type: 'с.', new_name: 'Мирне', district: d, year: '2024', src: 'vr' });
  const r = await build(op, [village('Котовське', 'Широківський р-н'), village('Новий Посьолок', 'Синельниківський р-н')]);
  assert.equal(entryOf(r.settlements, 'Котовське').sure, undefined);
  assert.equal(entryOf(r.settlements, 'Новий Посьолок').sure, undefined);
  const alone = await build(op, [village('Котовське', 'Широківський р-н')]);
  assert.equal(alone.settlements && entryOf(alone.settlements, 'Котовське').sure, true);
});

test('the Russian form is stored only when every word is Russian; a current-name entry takes none from the old name', () => {
  const russian = [{ kind: 'word', uk: 'Червоних', ru: 'Красных' }, { kind: 'word', uk: 'козаків', ru: 'казаков' }];
  assert.deepEqual(collectRussian('Червоних козаків', new Set(), russian), ['Красных казаков']);
  assert.deepEqual(collectRussian('Червоних бійців', new Set(), russian), []); // «бійців» has no Russian word yet: no half-form
  assert.deepEqual(collectRussian('Червоних Партизан', new Set(), russian), ['Красных Партизан']); // a name reads the same
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

test('a Russian-only row attaches its form to the Ukrainian entry of its own town, and to no other', async () => {
  const op = operator({ streets: ['вул. Нова-а'] });
  const ruRow = (scope) => row({ list: 'streets', scope, old_type: 'вул.', old_name: 'Будённого', new_type: 'вул.', new_name: 'Нова-а', src: 'osm', flags: 'ruonly', ru: 'Будённого', url: 'u', fetched: 'f' });
  const here = await build(op, [st('Будьонного', 'Нова-а'), ruRow('dnipro/dnipro')]);
  assert.deepEqual(entryOf(here.city, 'Будьонного').ru, ['Будённого']);
  const elsewhere = await build(op, [st('Будьонного', 'Нова-а'), ruRow('dnipro/kryvyi-rih')]);
  assert.equal(entryOf(elsewhere.city, 'Будьонного').ru, undefined);
  assert.equal(elsewhere.report.dropped['ru-without-pair'], 1);
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
  assert.deepEqual(await problems((f) => { delete f.a[0].t[1].d; }), []); // no place in the sources: nothing is printed
  assert.match((await problems((f) => { f.a[0].t[1].d = 'місце не вказано'; })).join(), /d says nothing/);
  assert.match((await problems((f) => { f.a[0].t[1].d = ''; })).join(), /non-empty string/);
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
  assert.match((await problems((f) => { f.a.push({ k: 'Толстого', ty: 'вул.', sure: true, t: [{ i: 1, s: ['wp', 'osm'] }] }); })).join(), /sure on a name that is the name of a row of the list/);
  assert.deepEqual(await problems((f) => { f.a[1].t[0].s = ['loc']; f.src.loc = 'x'; }), []); // an official source alone is enough
});

test('gate: a list that grew makes the file stale, not wrong: n below the length passes the lenient gate and fails the strict one', async () => {
  assert.deepEqual(await problems((f) => { f.n = 3; }, { strict: false }), []);
  assert.match((await problems((f) => { f.n = 3; })).join(), /n is 3, the list has 4 rows/);
  assert.match((await problems((f) => { f.n = 5; }, { strict: false })).join(), /n is 5, the list has 4 rows/); // longer than the list is wrong in any mode
});

test('gate: a target once and sorted by houses, and no key the file does not define', async () => {
  assert.match((await problems((f) => { f.a[0].t[1].i = 0; })).join(), /target 0 twice/);
  assert.match((await problems((f) => { f.a[0].t.reverse(); })).join(), /not sorted by houses/);
  assert.match((await problems((f) => { f.a[0].t[0].x = 1; })).join(), /unknown key "x"/);
  assert.match((await problems((f) => { f.a[0].extra = true; })).join(), /unknown key "extra"/);
});

test('gate: sure is refused for a key that is the name of a row of ANY kind, and for one without a kind', async () => {
  assert.match((await problems((f) => { f.a.push({ k: 'Толстого', ty: 'пров.', sure: true, t: [{ i: 1, s: ['wp', 'osm'] }] }); })).join(), /name of a row of the list/);
  assert.match((await problems((f) => { delete f.a[1].ty; })).join(), /sure without a kind/);
});

test('gate: strict mode counts the houses on disk; lenient mode lets a harvest move them', async () => {
  const dir = await gateFixture((f) => { f.a[0].t[0].h = 2; f.a[0].t[1].h = 1; f.a[1].t[0].h = 9; });
  try {
    await mkdir(join(dir, 'kyiv', 's'), { recursive: true });
    await writeFile(join(dir, 'kyiv', 's', '0.json'), JSON.stringify({ 1: 'GPV1.1', 2: 'GPV1.1' }));
    await writeFile(join(dir, 'kyiv', 's', '1.json'), JSON.stringify({ 1: 'GPV1.1' }));
    const strict = (await checkAliases({ addr: dir, useGit: false, corpus: '/nonexistent' })).errors.join('\n');
    assert.match(strict, /target 0 says 9 houses, the street has 2/);
    assert.doesNotMatch(strict, /target 1 says/);
    assert.deepEqual((await checkAliases({ addr: dir, useGit: false, corpus: '/nonexistent', strict: false })).errors, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
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

