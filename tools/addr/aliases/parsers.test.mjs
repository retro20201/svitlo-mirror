/**
 * The parsers, on excerpts shaped like the real downloads (trimmed by hand from the files fetched on
 * 2026-10-12). Nothing here touches the network or the raw folders.
 */
import test from 'node:test';
import nodeAssert from 'node:assert/strict';
import { findTemplates, parseTables, parseListLines, plain, splitTop } from './wikitext.mjs';
import { yearAndAct, parseKyivPages } from './parse-wikipedia-kyiv.mjs';
import { parseCityPage, parseDniproLines, columnRoles } from './parse-wikipedia-cities.mjs';
import { parseSettlementPage } from './parse-wikipedia-settlements.mjs';
import { parseRuOdesa } from './parse-wikipedia-ru-odesa.mjs';
import { parseOsmTown, oldNameGroups } from './parse-osm.mjs';
import { parseRadaAct, splitOldPart, raionNominative } from './parse-rada.mjs';
import { parseBoryspil, parseBilaTserkva, parseBrovary, parseKhmelnytskyi, localityHeading } from './parse-councils.mjs';
import { parseOda, parseBucha, oldNamesFromNote, layoutItems, nominative } from './parse-pdfs.mjs';
import { parseRenameDp } from './parse-rename-dp.mjs';
import { htmlTables, htmlToLines } from './html.mjs';
import { formatTsv, parseTsv } from './tsv.mjs';

// Rows come out sorted by name, not in table order: compare as sets of lines.
const assert = Object.assign((...a) => nodeAssert(...a), nodeAssert, {
  deepEqual: (actual, expected, message) => nodeAssert.deepEqual(Array.isArray(actual) && actual.every((x) => typeof x === 'string') ? [...actual].sort() : actual, Array.isArray(expected) && expected.every((x) => typeof x === 'string') ? [...expected].sort() : expected, message)
});

const rowsOf = (rows) => rows.map((r) => [r.scope, r.old_type, r.old_name, r.new_type, r.new_name, r.district, r.year, r.act, r.src, r.flags].join('|')).sort();

// ---- wikitext -------------------------------------------------------------------------------

test('wikitext: templates split at their top-level bars, links and nested templates intact', () => {
  const [t] = findTemplates('x {{Street-table-row-Kiev|1| [[A|a]] | вулиця | Нова{{р|1}}, Б | Р | | 2019{{к|7}}}} y', 'street-table-row-kiev');
  assert.equal(t.args.length, 7);
  assert.equal(plain(t.args[1]), 'a');
  assert.deepEqual(splitTop('a|[[b|c]]|{{d|e}}', '|'), ['a', '[[b|c]]', '{{d|e}}']);
});

test('wikitext: tables keep their headings, cell attributes go, a header row is found', () => {
  const text = `== Вулиці ==\n=== А ===\n{| class="wikitable"\n! Назва !! Тип\n|-\n| style="x" | [[Вулиця А|Аа]] || вулиця\n|-\n|Бб\n|провулок\n|}`;
  const [table] = parseTables(text);
  assert.deepEqual(table.headings, ['Вулиці', 'А']);
  assert.deepEqual(table.header, ['Назва', 'Тип']);
  assert.deepEqual(table.rows.map((r) => r.map(plain)), [['Аа', 'вулиця'], ['Бб', 'провулок']]);
});

test('wikitext: list lines come with the heading above them', () => {
  const items = parseListLines("== Перейменування ==\n=== 22 листопада 2023 року ===\n# ''Ангарська вулиця'' — '''Волоська вулиця'''\n* x");
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].headings, ['Перейменування', '22 листопада 2023 року']);
});

// ---- Kyiv ------------------------------------------------------------------------------------

const KYIV = `{{Street-table-row-Kiev|11843| [[Велика Васильківська вулиця|Велика Васильківська]] | вулиця | Велика Васильківська, Червоноармійська | Голосіївський, [[Печерський район|Печерський]] | | 2014{{ркмр2|373}}}}
{{Street-table-row-Kiev|11924| [[Коновальця]] | вулиця | Прозорівський шлях, Новогоспітальна + Сурикова + Володимиро-Либідська (част.), Щорса | Печерський | | 2015{{ркмр2|1808}}}}
{{Street-table-row-Kiev|11695| Українських Героїв | площа | Шулявська (неоф.), Нова 400-та, Толстого Л. Н., Толстого Льва | | | 2023{{ркмр2|6324}}}}
{{Street-table-row-Kiev|11121| Набережно-Хрещатицька | вулиця | Хрещатик | Подільський | | 1869{{рвкмр2|1869}}}}
{{Street-table-row-Kiev|10009| Аеродромна | вулиця | Куліша (Кулішівська), Аеродромна{{рвкмр2|2721}} | Солом'янський | | ''до 2000''}}`;

test('Kyiv: former names, merges, parts, junk and the act of the year cell', () => {
  const rows = parseKyivPages([{ revid: 7, text: KYIV }], { fetched: '2026-10-12' });
  const mine = rowsOf(rows);
  assert.ok(mine.includes('kyiv||Червоноармійська|вул.|Велика Васильківська|Голосіївський, Печерський|2014|КМР 373|wp|'));
  // «Велика Васильківська» is not its own former name.
  assert.equal(rows.some((r) => r.old_name === 'Велика Васильківська'), false);
  // A merge, a part, the junk and the unofficial name.
  assert.ok(mine.some((m) => m.includes('|Сурикова|вул.|Коновальця|') && m.endsWith('|wp|merge')));
  assert.ok(mine.some((m) => m.includes('|Володимиро-Либідська|') && m.endsWith('|wp|part,merge')));
  assert.equal(rows.some((r) => /Нова|Шулявська/.test(r.old_name)), false);
  // Initials leave the surname.
  assert.ok(rows.some((r) => r.old_name === 'Толстого' && r.new_name === 'Українських Героїв'));
  assert.ok(rows.some((r) => r.old_name === 'Толстого Льва'));
  // «до 2000» is a year before 2000; 1869 stays as written and is cut by the builder's policy.
  assert.equal(rows.find((r) => r.old_name === 'Куліша')?.year, '1999');
  assert.equal(rows.find((r) => r.old_name === 'Хрещатик')?.year, '1869');
  assert.equal(rows.find((r) => r.old_name === 'Червоноармійська').url, 'https://uk.wikipedia.org/?oldid=7');
});

test('Kyiv: the year and the act come from the year cell', () => {
  assert.deepEqual(yearAndAct('2019{{ркмр2|7610}}'), { year: '2019', act: 'КМР 7610' });
  assert.deepEqual(yearAndAct("1953{{рвкмр2|2610}}<ref>x</ref>"), { year: '1953', act: 'ВК КМР 2610' });
  assert.deepEqual(yearAndAct("''до 2000''<ref group='п'>x</ref>"), { year: '1999', act: '' });
  assert.deepEqual(yearAndAct(''), { year: '', act: '' });
});

// ---- town street lists ---------------------------------------------------------------------

test('town lists: the header tells which column is which', () => {
  assert.deepEqual(columnRoles(['Сучасна назва', 'Тип', 'Район', 'Колишні назви/Примітки/Поштовий індекс']), { current: 0, type: 1, district: 2, former: 3 });
  assert.deepEqual(columnRoles(['Топонім', 'Стара назва', 'Нова назва', 'Район']), { type: 0, former: 1, new: 2, district: 3 });
  assert.equal(columnRoles(['Сучасна назва', 'Тип', 'Колишні назви', ''], ['', '', '', '{{Abbr|Рік затв.|Рік присвоєння}}']).year, 3);
});

test('town lists: a current-names table gives one pair per former name, postal codes and junk dropped', () => {
  const text = `== Вулиці ==\n{| class="wikitable"\n! Сучасна назва !! Тип !! Район !! Колишні назви/Примітки/Поштовий індекс\n|-\n|[[X|Антоновича Володимира]]||Вулиця||Центральний, Чечелівський||Каретна (Алексеєнківська), вулиця Челюскіна, 49089, Нова\n|-\n|Парковий||Парк||Центральний||Ленінський\n|}`;
  const rows = parseCityPage({ revid: 5, text }, { scope: 'dnipro/dnipro' }, { fetched: 'd' });
  assert.deepEqual(rowsOf(rows), [
    'dnipro/dnipro||Каретна|вул.|Антоновича Володимира|Центральний, Чечелівський|||wp|',
    'dnipro/dnipro|вул.|Челюскіна|вул.|Антоновича Володимира|Центральний, Чечелівський|||wp|'
  ]);
});

test('town lists: a pair table takes the district from a marker row and the year from its heading', () => {
  const text = `== Перейменування ==\n=== Список перейменувань у 2015—2016 рр. ===\n{| class="wikitable"\n!Топонім\n!Стара назва\n!Нова назва\n|-\n| colspan="3" |'''Амур-Нижньодніпровський'''\n|-\n|вулиця та пров.\n|Білостоцького\n|'''Любарського'''\n|}`;
  const rows = parseCityPage({ revid: 5, text }, { scope: 'dnipro/dnipro' }, { fetched: 'd' });
  assert.deepEqual(rowsOf(rows), [
    'dnipro/dnipro||Білостоцького|вул.|Любарського|Амур-Нижньодніпровський|2016||wp|',
    'dnipro/dnipro||Білостоцького|пров.|Любарського|Амур-Нижньодніпровський|2016||wp|'
  ]);
});

test('town lists: a headerless table (Nikopol) uses the configured columns', () => {
  const text = `{| class="wikitable"\n|'''№ з/п'''\n|'''Попередні назви'''\n|'''Діючі назви'''\n|'''Тип'''\n|-\n|1\n|40 років Жовтня, Краснодонська\n|''Героїв Чорнобиля''\n|вулиця\n|}`;
  const rows = parseCityPage({ revid: 1, text }, { scope: 'dnipro/nikopol', headerless: { former: 1, current: 2, type: 3 } }, {});
  assert.deepEqual(rows.map((r) => r.old_name), ['40 років Жовтня', 'Краснодонська']);
  assert.equal(rows[0].new_name, 'Героїв Чорнобиля');
});

test('Dnipro list lines: old (district) — new, dated by the heading', () => {
  const text = "=== 22 листопада 2023 року ===\n# ''Ангарська вулиця (Шевченківський район)''&nbsp;— '''Волоська вулиця'''\n# ''вулиця Гомельська (Новокодацький, Чечелівський райони)'' — '''Словацька вулиця'''";
  const rows = parseDniproLines({ revid: 3, text }, { scope: 'dnipro/dnipro' });
  assert.deepEqual(rowsOf(rows), [
    'dnipro/dnipro|вул.|Ангарська|вул.|Волоська|Шевченківський|2023||wp|',
    'dnipro/dnipro|вул.|Гомельська|вул.|Словацька|Новокодацький, Чечелівський|2023||wp|'
  ]);
});

test('settlement lists: type, old, raion, new and the act', () => {
  const text = `=== [[Дніпропетровська область]] ===\n{| class="wikitable"\n! Тип\n! Стара назва\n! Район/міськрада\n! Нова назва\n! Посилання\n|-\n| село\n| ''Ленінське''\n| Апостолівський\n| ''[[Грушівка (Криворізький район)|Грушівка]]''\n| ПВРУ 984-VIII\n|}\n=== [[Вінницька область]] ===\n{| class="wikitable"\n! Тип\n! Стара назва\n! Район\n! Нова назва\n! Посилання\n|-\n| село\n| Х\n| Y\n| Z\n| ПВРУ 1-VIII\n|}`;
  const rows = parseSettlementPage({ revid: 2, text }, {});
  assert.deepEqual(rowsOf(rows), ['dnipro|с.|Ленінське|с.|Грушівка|Апостолівський р-н||ВРУ 984-VIII|wp|']);
});

test('ru.wikipedia: the old name is the italic one; the reverse listing of the same pair is skipped', () => {
  const text = "* ''Малороссийская улица'' — см. Адмирала Лазарева улица\n* Адмирала Лазарева улица - см. ''Малороссийская улица''\n* ''Авиаторов /Авиаторский переулок'' — см. Азовский переулок (с 2024)";
  const rows = parseRuOdesa({ revid: 9, text }, {});
  assert.deepEqual(rows.map((r) => `${r.old_name}>${r.new_name}`), ['Малороссийская>Адмирала Лазарева', 'Авиаторов>Азовский', 'Авиаторский>Азовский']);
  assert.ok(rows.every((r) => r.flags === 'ruonly' && r.ru === r.old_name));
});

// ---- OSM -------------------------------------------------------------------------------------

test('OSM: Ukrainian old names, the Russian twin, a dated key, noise languages and Latin values', () => {
  const tags = { highway: 'residential', name: 'вулиця Героїв Чорнобиля', old_name: 'вулиця Воїнів-Афганців;Voiniv Street', 'old_name:ru': 'улица Воинов-Афганцев', 'old_name:en': 'Voiniv', 'old_name:2016-2026': 'вулиця Воїнів-Афганців', 'old_name:pl': 'x', 'old_name:uk-Latn': 'vulytsia' };
  const groups = oldNameGroups(tags);
  assert.deepEqual(groups.map((g) => [g.period, g.year, g.uk, g.ru]), [['', '', ['вулиця Воїнів-Афганців;Voiniv Street'], ['улица Воинов-Афганцев']], ['2016-2026', '2026', ['вулиця Воїнів-Афганців'], []]]);
  const rows = parseOsmTown({ elements: [{ type: 'way', id: 42, center: { lat: 1, lon: 1 }, tags }, { type: 'way', id: 43, center: { lat: 9, lon: 9 }, tags: { ...tags, name: 'вулиця Інша' } }] }, { scope: 'kyiv-region/brovary', box: [0, 0, 2, 2], fetched: 'd' });
  assert.equal(rows.length, 2); // the same old name with and without a period are two rows; the way outside the box is out
  const plainRow = rows.find((r) => !r.year);
  assert.equal(plainRow.old_name, 'Воїнів-Афганців');
  assert.equal(plainRow.new_type, 'вул.');
  assert.equal(plainRow.new_name, 'Героїв Чорнобиля');
  assert.equal(plainRow.ru, 'Воинов-Афганцев');
  assert.equal(plainRow.url, 'https://www.openstreetmap.org/way/42');
  assert.equal(rows.find((r) => r.year).year, '2026');
});

test('OSM: a street whose old name is its own, or whose name is Latin, gives nothing', () => {
  const rows = parseOsmTown({ elements: [
    { type: 'way', id: 1, tags: { name: 'вулиця Лісова', old_name: 'Лісова вулиця' } },
    { type: 'way', id: 2, tags: { name: 'Main Street', old_name: 'вулиця Х' } }
  ] }, { scope: 'x/y' });
  assert.deepEqual(rows, []);
});

// ---- Rada ------------------------------------------------------------------------------------

const RADA = `<html><head><title>Про перейменування окремих... | від 17.03.2016 № 1037-VIII (Текст для друку)</title></head><body>
<p>1. Перейменувати такі населені пункти:</p>
<p>2) у Дніпропетровській області:</p>
<p>село Інтернаціональне Павлівської сільської ради Васильківського району на село Довге;</p>
<p>місто Орджонікідзе на місто Покров;</p>
<p>5) у Київській області:</p>
<p>село Жовтневе Бородянського району на село Дмитрівка;</p>
<p>село Перше Травня Солонянської селищної територіальної громади Дніпровського району на село Квітневе;</p>
<p>6) у Кіровоградській області:</p>
<p>село Леніна Маловисківського району на село Гаївка;</p>
<p>11)&nbsp; в Одеській області:</p>
<p>село Ухожани Балтського району на село Новополь;</p></body></html>`;

test('Rada: a rename sentence, the oblast from its heading, the raion kept, other oblasts ignored', () => {
  const rows = parseRadaAct(RADA, { url: 'u', fetched: 'd' });
  assert.deepEqual(rowsOf(rows), [
    'dnipro|с.|Інтернаціональне|с.|Довге|Васильківський р-н|2016|ВРУ 1037-VIII|vr|',
    'dnipro|м.|Орджонікідзе|м.|Покров||2016|ВРУ 1037-VIII|vr|',
    'kyiv-region|с.|Жовтневе|с.|Дмитрівка|Бородянський р-н|2016|ВРУ 1037-VIII|vr|',
    'kyiv-region|с.|Перше Травня|с.|Квітневе|Дніпровський р-н|2016|ВРУ 1037-VIII|vr|',
    'odesa|с.|Ухожани|с.|Новополь|Балтський р-н|2016|ВРУ 1037-VIII|vr|'
  ]);
  assert.equal(raionNominative('Переяслав-Хмельницького'), 'Переяслав-Хмельницький р-н');
  assert.deepEqual(splitOldPart('Красне Васильківської селищної територіальної громади Дніпровського району'), { name: 'Красне', raion: 'Дніпровський р-н', council: 'Васильківської селищної територіальної громади', region: '' });
});

test('Rada: a one-sentence act names its oblast in the sentence', () => {
  const html = '<title>x | від 19.05.2016 № 1375-VIII (Текст)</title><p>1. Перейменувати місто Дніпропетровськ Дніпропетровської області на місто Дніпро.</p>';
  assert.deepEqual(rowsOf(parseRadaAct(html)), ['dnipro|м.|Дніпропетровськ|м.|Дніпро||2016|ВРУ 1375-VIII|vr|']);
});

// ---- councils --------------------------------------------------------------------------------

test('Boryspil: «№ | Стара назва | Нова назва» tables, the date of the decision in the title, villages by heading rows', () => {
  const html = `<title>Borispol-rada.gov.uA — 19 квітня 2022 року № 1792-23-VIII «Про перейменування»</title>
<table><tr><td>№</td><td>Стара назва</td><td>Нова назва</td></tr><tr><td>1</td><td>2</td><td>3</td></tr>
<tr><td>1.</td><td>вул. Анни Ахматової</td><td>вул Дмитра Бортнянського</td></tr>
<tr><td>2.</td><td>вул.8 Березня</td><td>вул Шелестівка</td></tr></table>
<table><tr><td>№</td><td>Стара назва</td><td>Нова назва</td></tr><tr><td>село Глибоке</td></tr>
<tr><td>1.</td><td>вул. Ватутіна</td><td>вул. Ярослава Мудрого</td></tr></table>`;
  assert.deepEqual(rowsOf(parseBoryspil(html)), [
    'kyiv-region/boryspil|вул.|Анни Ахматової|вул.|Дмитра Бортнянського||2022|БМР 1792-23-VIII|loc|',
    'kyiv-region/boryspil|вул.|8 Березня|вул.|Шелестівка||2022|БМР 1792-23-VIII|loc|',
    'kyiv-region/~с. Глибоке|вул.|Ватутіна|вул.|Ярослава Мудрого||2022|БМР 1792-23-VIII|loc|'
  ]);
  assert.deepEqual(localityHeading('с.Гайок'), { type: 'с.', name: 'Гайок' });
  assert.deepEqual(localityHeading('м.Біла Церква'), { type: 'м.', name: 'Біла Церква' });
});

test('Bila Tserkva: the decision of each row, a heading row for a village, the dateless 2016 table', () => {
  const html = `<table><tr><td></td><td>Стара назва</td><td>Нова назва</td><td>Обґрунтування</td><td>Рішення</td></tr>
<tr><td>м.Біла Церква</td></tr>
<tr><td>4.</td><td>вул. Гагаріна</td><td>вул. Млинова</td><td>Повернення історичної назви</td><td>Рішення БМР «Про перейменування» від 28 липня 2022 року № 2869-31-VІІІ</td></tr>
<tr><td>с. Глибочка</td></tr>
<tr><td>71.</td><td>вул. Гагаріна</td><td>вул. Павла Поповича</td><td></td><td>Рішення БМР від 28 липня 2022 року № 2810-31-VІІІ</td></tr></table>
<table><tr><td>№ п\\п</td><td>Стара назва</td><td>Нова назва</td></tr><tr><td>1.</td><td>бул. 50-річчя Перемоги</td><td>бул. Олександрійський</td></tr></table>`;
  assert.deepEqual(rowsOf(parseBilaTserkva(html)), [
    'kyiv-region/bila-tserkva|вул.|Гагаріна|вул.|Млинова||2022|БМР 2869-31-VІІІ|loc|',
    'kyiv-region/~с. Глибочка|вул.|Гагаріна|вул.|Павла Поповича||2022|БМР 2810-31-VІІІ|loc|',
    'kyiv-region/bila-tserkva|бул.|50-річчя Перемоги|бул.|Олександрійський||2016||loc|'
  ]);
});

test('Brovary and Khmelnytskyi: Word annexes', () => {
  const brovary = [
    { kind: 'p', text: 'від 06.05.2022 р.' }, { kind: 'p', text: '№ 713-26-08' },
    { kind: 'table', rows: [['№ з/п', 'Вул/провул.', 'Попереднє найменування', 'Нове найменування'], ['', 'вул.', 'Блока Олександра', 'Цвілої Ірини'], ['', 'пров.', 'Вавилова', 'Рокфордський']] }
  ];
  assert.deepEqual(rowsOf(parseBrovary(brovary)), [
    'kyiv-region/brovary|вул.|Блока Олександра|вул.|Цвілої Ірини||2022|БМР 713-26-08|loc|',
    'kyiv-region/brovary|пров.|Вавилова|пров.|Рокфордський||2022|БМР 713-26-08|loc|'
  ]);
  const khm = [{ kind: 'table', rows: [
    ['№з/п', 'Вулиця, провулок', 'Повна назва вулиці', 'Коротка назва вулиці', 'Опис розташування', 'Рік', 'Попередні назви', 'Код'],
    ['5', 'вулиця', 'Миколи Амосова', 'Амосова', 'Лезневе', '2016', 'вулиця Лесі Українки,вулиця Д.Коротченка', '220'],
    ['6', 'вулиця', 'Авіаційна', 'Авіаційна', 'Дубове', '1993', '', '001']
  ] }];
  assert.deepEqual(rowsOf(parseKhmelnytskyi(khm)), [
    'khmelnytskyi/khmelnytskyi|вул.|Лесі Українки|вул.|Миколи Амосова||2016|ХМР 24/2008|loc|',
    'khmelnytskyi/khmelnytskyi|вул.|Коротченка|вул.|Миколи Амосова||2016|ХМР 24/2008|loc|'
  ]);
});

// ---- PDFs ------------------------------------------------------------------------------------

test('Odesa ODA order: columns put back together, headings give the locality and the hromada, squares are not streets', () => {
  const items = layoutItems([
    '1\t2\t470.2\tНазва до перейменування', '1\t2\t451.2\tмісто Одеса',
    '1\t0\t433.7\tВулиця Адмірала Лазарева', '1\t1\t433.7\tВулиця Михайла Болтенка',
    '1\t0\t419.3\tПровулок Аполона Скальковського', '1\t1\t419.3\tПровулок Зої Пасічної',
    '1\t0\t405.0\tСквер Паустовського', '1\t1\t405.0\tСквер Номана Челебіджіхана',
    '1\t0\t391.0\tВулиця Двічі Героя', '1\t0\t377.0\tВасильовича', '1\t1\t391.0\tВулиця Нова Назва',
    '1\t2\t340.0\tДальницька ТГ', '1\t2\t326.0\tсело Петродолинське',
    '1\t0\t312.0\tВулиця Першотравнева', '1\t1\t312.0\tВулиця Богдана Костіва'
  ].join('\n'));
  assert.deepEqual(rowsOf(parseOda(items)), [
    'odesa/odesa|вул.|Адмірала Лазарева|вул.|Михайла Болтенка||2024|ОДА 830/А-2024|loc|',
    'odesa/odesa|пров.|Аполона Скальковського|пров.|Зої Пасічної||2024|ОДА 830/А-2024|loc|',
    'odesa/odesa|вул.|Двічі Героя Васильовича|вул.|Нова Назва||2024|ОДА 830/А-2024|loc|',
    'odesa/~с. Петродолинське|вул.|Першотравнева|вул.|Богдана Костіва|Дальницька ТГ|2024|ОДА 830/А-2024|loc|'
  ]);
});

test('Bucha list: the note says what the street was; a genitive adjective is turned back; squares and corners are skipped', () => {
  assert.deepEqual(oldNamesFromNote('(перейменовано з вул. Піонерської )'), [{ type: 'вул.', name: 'Піонерська', part: false }]);
  assert.deepEqual(oldNamesFromNote('(перейменовано з частини вул. Ворошилова )'), [{ type: 'вул.', name: 'Ворошилова', part: true }]);
  assert.deepEqual(oldNamesFromNote('(перейменовано з провулку Ворошилова )'), [{ type: 'пров.', name: 'Ворошилова', part: false }]);
  assert.deepEqual(oldNamesFromNote('( перейменовано з площі на розі вул. Леха Качинського)'), []);
  assert.equal(nominative('Жовтневої'), 'Жовтнева');
  const items = layoutItems([
    '0\t0\t651.1\tвулиця', '0\t1\t651.1\tАзовська', '0\t2\t651.1\t(перейменовано з вул. Ново-Лермонтова)',
    '0\t0\t637.0\tвулиця', '0\t1\t637.0\tАмосова Миколи',
    '0\t0\t620.0\tсквер', '0\t1\t620.0\tМистецький', '0\t2\t620.0\t(перейменовано з сквер Ім. Булгакова)',
    '7\t3\t775.9\tПерелік назв вулиць та провулків розташованих в', '7\t3\t757.4\tселищі Ворзель',
    '7\t0\t722.5\tпровулок', '7\t1\t722.5\tАрхітектора Городецького', '7\t2\t722.5\t(перейменовано з провулку Некрасова)'
  ].join('\n'));
  assert.deepEqual(rowsOf(parseBucha(items)), [
    'kyiv-region/bucha|вул.|Ново-Лермонтова|вул.|Азовська|||Бучанська МР, перелік від 04.09.2024|loc|',
    'kyiv-region/~смт Ворзель|пров.|Некрасова|пров.|Архітектора Городецького|||Бучанська МР, перелік від 04.09.2024|loc|'
  ]);
});

// ---- rename.dp.ua ----------------------------------------------------------------------------

test('rename.dp.ua: kinds of object become kinds of street; it is a cross-check only (code rdp)', () => {
  const rows = parseRenameDp({ lastUpdate: 'x', r61: { newAreaName: 'Амур-Нижньодніпровський', objects: [
    { type: 'street', oldName: 'Баглія', newName: 'Брацлавська' },
    { type: 'avenue', oldName: 'Карла Маркса', newName: 'Дмитра Яворницького', restored: false },
    { type: 'lake', oldName: 'ім. Кірова', newName: 'Затишна' },
    { type: 'lane', oldName: 'Білостоцького', newName: 'Любарського' }
  ] } }, {});
  assert.deepEqual(rowsOf(rows), [
    'dnipro/dnipro|вул.|Баглія|вул.|Брацлавська|Амур-Нижньодніпровський|||rdp|',
    'dnipro/dnipro|просп.|Карла Маркса|просп.|Дмитра Яворницького|Амур-Нижньодніпровський|||rdp|',
    'dnipro/dnipro|пров.|Білостоцького|пров.|Любарського|Амур-Нижньодніпровський|||rdp|'
  ].sort());
});

// ---- html, tsv -------------------------------------------------------------------------------

test('html: text lines and tables, entities decoded, scripts dropped', () => {
  const html = '<script>x()</script><p>село&nbsp;Іванків &amp; Ко</p><table><tr><td>1</td><td> a<br>b </td></tr></table>';
  assert.deepEqual(htmlToLines(html), ['село Іванків & Ко', '1', 'a', 'b']);
  assert.deepEqual(htmlTables(html), [[['1', 'a b']]]);
});

test('tsv: tabs and line breaks in a cell become spaces, comments are skipped, an empty cell is empty', () => {
  const text = formatTsv(['a', 'b'], [{ a: 'x\ty', b: '' }, { a: 'line\nbreak', b: 'z' }], 'comment');
  assert.equal(text, '# comment\na\tb\nx y\t\nline break\tz\n');
  assert.deepEqual(parseTsv(text), [{ a: 'x y', b: '' }, { a: 'line break', b: 'z' }]);
});
