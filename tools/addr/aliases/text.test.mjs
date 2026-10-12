import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, isJunkName, isPlausibleKey, tidyName, streetTypeOf, settlementTypeOf, trailingKind, actDate, isRespelling, editDistance } from './text.mjs';

const read = (s, kind) => { const r = parseName(s, kind); return { type: r.type, name: r.name, tokens: r.tokens.join(' ') }; };

test('the type word is read at the start or the end, in any spelling', () => {
  assert.deepEqual(read('вул. Богуна І.'), { type: 'вул.', name: 'Богуна', tokens: 'богуна' });
  assert.deepEqual(read('Московський проспект'), { type: 'просп.', name: 'Московський', tokens: 'московський' });
  assert.deepEqual(read('проспект Степана Бандери'), { type: 'просп.', name: 'Степана Бандери', tokens: 'бандери степана' });
  assert.deepEqual(read('вул.  Бандери Степана'), { type: 'вул.', name: 'Бандери Степана', tokens: 'бандери степана' });
  assert.equal(read('бульв. Лесі Українки').type, 'бул.');
  assert.equal(read('Улица Пушкина').type, 'вул.');
  assert.equal(read('пр-т Перемоги').type, 'просп.');
});

test('names are compared as token sets: order, Ґ/Г, apostrophes, case and NBSP do not matter', () => {
  assert.equal(read('вул. Бандери Степана').tokens, read('просп. Степана  Бандери').tokens);
  assert.equal(read('вулиця Ґедройця').tokens, read('вул. Гедройця Єжи').tokens.replace(' єжи', '').replace('єжи ', ''));
  assert.equal(read("вул. Лук'яненка").tokens, read('вул. Лук’яненка').tokens);
  assert.equal(read('вул. Лукʼяненка').tokens, read("вул. Лук'яненка").tokens);
  assert.equal(read('ВУЛ. ГЕРОЇВ 72-Ї БРИГАДИ').tokens, read('вул. Героїв 72-ї Бригади').tokens);
});

test('a word never goes: a name that happens to be a type word stays a name', () => {
  // «Січеславська Набережна» is a street's name, «Набережна Леніна» is an embankment.
  assert.deepEqual(read('Січеславська Набережна'), { type: '', name: 'Січеславська Набережна', tokens: 'набережна січеславська' });
  assert.equal(read('Набережна Леніна').type, 'наб.');
  assert.equal(read('вул. Набережна').name, 'Набережна');
});

test('ordinals and Roman numerals read the same wherever they stand', () => {
  assert.equal(read('1-й провулок Матросова').tokens, read('пров. 1 Матросова').tokens);
  assert.equal(read('1-й провулок Матросова').type, 'пров.');
  assert.equal(read('вул. ІІІ Інтернаціоналу').tokens, read('вул. III-Інтернаціоналу').tokens);
  assert.equal(read('вул. Іоанна Павла ІІ').tokens, read('вул. Іоанна Павла II').tokens); // Cyrillic ІІ and Latin II
  assert.equal(read('вул. 1-го Травня').tokens, '1 травня');
});

test('initials are hints, not words: they drop out of the tokens', () => {
  assert.deepEqual(parseName('вул.Т.Шевченка').initials, ['т']);
  assert.equal(parseName('вул.Т.Шевченка').tokens.join(' '), 'шевченка');
  assert.equal(parseName('Толстого Л. Н.').name, 'Толстого');
  assert.equal(parseName('ім. Т. Г. Шевченка').tokens.join(' '), 'шевченка');
  assert.equal(parseName('вул. Максюти Ю.').tokens.join(' '), 'максюти');
});

test('parentheses are remembered, not matched', () => {
  const part = parseName('Велика Васильківська (част.)');
  assert.equal(part.part, true);
  assert.equal(part.tokens.join(' '), 'васильківська велика');
  assert.equal(parseName('Шулявська (неоф.)').unofficial, true);
  assert.equal(parseName('вул. Толстого (Бортничі)').locality, 'Бортничі');
  assert.equal(parseName('вул. Толстого (Бортничі)').tokens.join(' '), 'толстого');
  assert.equal(parseName('частина вул. Ворошилова').part, true);
});

test('Latin look-alikes inside a Cyrillic word are Cyrillic', () => {
  assert.equal(read('с. Воронькiв', 'settlement').tokens, 'вороньків');
});

test('placeholder names are junk, and real names are not', () => {
  for (const junk of ['Нова', 'Нова 400-та', 'Проєктна 12977', 'Безіменна', 'Завулок № 4', 'Дорога № 6', 'без назви № 7', '49099', 'Х']) assert.equal(isJunkName(junk) || parseName(junk).junk, true, junk);
  for (const fine of ['Нова Слобода', 'Новаторів', 'Перемоги', '40-річчя Жовтня', 'Лісова']) assert.equal(isJunkName(fine), false, fine);
});

test('settlements: «смт», «с-ще», «сел» and «селище» are one kind; a village is another', () => {
  assert.equal(settlementTypeOf('смт'), settlementTypeOf('с-ще'));
  assert.equal(settlementTypeOf('сел'), settlementTypeOf('селище'));
  assert.notEqual(settlementTypeOf('с.'), settlementTypeOf('смт'));
  assert.deepEqual(read('м. Кам\'янське', 'settlement'), { type: 'м.', name: 'Кам\'янське', tokens: 'камянське' });
  assert.equal(read('селище міського типу Ювілейне', 'settlement').type, 'смт');
  assert.equal(read('село Фрунзівка', 'settlement').type, 'с.');
  assert.equal(read('Хмельницький', 'settlement').type, '');
});

test('tidyName trims quotes, stray punctuation and spaces', () => {
  assert.equal(tidyName('  «Нова» ,'), 'Нова');
  assert.equal(tidyName('Червоних  козаків;'), 'Червоних козаків');
  assert.equal(streetTypeOf('вулиці'), 'вул.');
});

test('a key is a name: not a sentence, a list, a note or an alternative', () => {
  for (const bad of ['Арсенальна вулиця Назва походить від слова «арсенал».', 'До 2014 — Калініна', 'Воронцова/Воронцовський', 'Лікаря Ребініна;вулиця Гавриленка', '152-ї Дивізії/49122', 'Як 1201-й кілометр', 'Пушкінська вулицяя', 'а б в г д е ж']) assert.equal(isPlausibleKey(bad), false, bad);
  for (const good of ['Горького', 'Льва Толстого', '40-річчя Жовтня', 'Лук’яненка', 'Героїв 72-ї Бригади', 'Маршала Тимошенка', '2-й Медовий']) assert.equal(isPlausibleKey(good), true, good);
});

test('a key is not a count, a date range, a side of a street or a lone kind', () => {
  for (const bad of ['Один з трьох провулків Давидова', 'Одну з трьох вулиць Потічних', 'Одна з п’яти вулиць Черкаських', 'Комсомольський з початку 1930-х років', 'Будівельна - непарна сторона', 'Центральна поперечна північна сторона', 'Перемоги пр-т 15 км', 'Проїзд', 'Вулиця', 'проїзд Білоруський проїзд']) assert.equal(isPlausibleKey(bad), false, bad);
  // The kinds that are also street names stay names; so do «року», «і», «на» and a hyphen in a word.
  for (const good of ['Набережна', 'Алея', 'Повстання 1905 року', 'Ільфа і Петрова', 'Поштова на Летичів', 'Московська-1', 'Брест-Литовське шосе', '19 лютого 1861 року']) assert.equal(isPlausibleKey(good), true, good);
});

test('a kind after the name is the old thing\'s kind: «Дарницьке шосе», «Городній тупик»; a name that is a kind is not', () => {
  assert.deepEqual(trailingKind(parseName('Дарницьке шосе')), { type: 'шосе', name: 'Дарницьке' });
  assert.deepEqual(trailingKind(parseName('Городній тупик')), { type: 'тупик', name: 'Городній' });
  assert.deepEqual(trailingKind(parseName('Білоруський проїзд')), { type: 'проїзд', name: 'Білоруський' });
  assert.equal(trailingKind(parseName('Січеславська Набережна')), null);
  assert.equal(trailingKind(parseName('Шосе')), null);
  assert.equal(trailingKind(parseName('50 років шосе')), null);
});

test('an act\'s date, in either way councils write it', () => {
  assert.equal(actDate('Рішення Дніпровської міської ради від 18 грудня 2024 року'), '2024-12-18');
  assert.equal(actDate('Розпорядження ОДА від 26 липня 2024 року'), '2024-07-26');
  assert.equal(actDate('згідно рішення міськради від 21.09.2022 № 43/27'), '2022-09-21');
  assert.equal(actDate('КМР 3200'), '');
  assert.equal(actDate(''), '');
});

test('a respelling is one letter off in each of at most two words, never a different name', () => {
  assert.equal(isRespelling(['короленко'], ['короленка']), true);
  assert.equal(isRespelling(['братська'], ['веделя', 'артема']), false);
  assert.equal(isRespelling(['пушкіна'], ['пушкінська']), false);
  assert.equal(isRespelling(['нова'], ['нове']), false); // short words differ in meaning
  assert.equal(isRespelling(['леніна'], ['леніна']), false); // the same is not a change
  assert.equal(editDistance('кіт', 'кит', 1), 1);
  assert.equal(editDistance('кіт', 'мапа', 1), 2);
});
