/**
 * How a street or settlement name, as one source or the operator writes it, is cut into pieces
 * that can be compared. Used for MATCHING only: the display spelling is always kept as it was.
 *
 * A name arrives as «вул. Богуна І.», «Московський проспект», «проспект Степана Бандери (част.)»,
 * «ім. Т. Г. Шевченка» or «Нова 400-та». `parseName` returns
 *   - `type`   the kind of thing in the operator's abbreviation (`вул.`, `просп.`, `бул.`, `пров.`,
 *              `пл.`, `узвіз`, `проїзд`, `тупик`, `шосе`, `наб.`, `алея`), or `''` when none was written;
 *   - `name`   the name without the type word, the «ім.» filler, parentheticals and initials,
 *              in the spelling it had («Бандери Степана»);
 *   - `tokens` the words that identify it, folded (lower case, Ґ→Г, Ё→Е, no apostrophes, an
 *              ordinal «2-й» as «2», a Roman «ІІІ» as «3»), as a sorted array: names are compared as
 *              SETS, so «Бандери Степана» equals «Степана Бандери»;
 *   - `initials` the first letters of the given names that were written as initials;
 *   - `part`, `unofficial`, `junk`, `locality` what the parentheticals and the leftovers said.
 */

const APOSTROPHES = /['’ʼ‘`´ʹ′]/g;
const COMBINING = /[̀-ͯ]/g;
const SPACES = /[\s  -​  　﻿]+/g;

// Latin letters that look Cyrillic hide in the operator lists («Воронькiв» has a Latin i).
const LOOKALIKES = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };

export function cleanSpaces(text) {
  return String(text ?? '').replace(SPACES, ' ').trim();
}

/** Lower case, Ґ→Г, Ё→Е, apostrophes and combining accents dropped. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(COMBINING, '')
    .replace(APOSTROPHES, '')
    .toLowerCase()
    .replace(/ґ/g, 'г')
    .replace(/ё/g, 'е');
}

/** A word with Latin look-alikes made Cyrillic, but only inside a word that already has Cyrillic letters. */
function unmix(word) {
  if (!/[а-яіїєґ]/i.test(word) || !/[a-z]/i.test(word)) return word;
  return word.replace(/[a-z]/gi, (c) => LOOKALIKES[c.toLowerCase()] ?? c);
}

// ---- Type words ---------------------------------------------------------------------------

/** Street kinds, keyed by the folded word without dots. Values are the operator's abbreviation. */
const STREET_TYPES = new Map(Object.entries({
  'вулиця': 'вул.', 'вулиці': 'вул.', 'вул': 'вул.', 'ул': 'вул.', 'улица': 'вул.', 'вулц': 'вул.',
  'проспект': 'просп.', 'проспекту': 'просп.', 'просп': 'просп.', 'пр-т': 'просп.', 'прт': 'просп.', 'пр': 'просп.', 'проспєкт': 'просп.',
  'бульвар': 'бул.', 'бульвару': 'бул.', 'бул': 'бул.', 'бульв': 'бул.', 'б-р': 'бул.', 'бр': 'бул.',
  'провулок': 'пров.', 'провулка': 'пров.', 'провулку': 'пров.', 'пров': 'пров.', 'прв': 'пров.', 'провул': 'пров.', 'пер': 'пров.', 'переулок': 'пров.',
  'площа': 'пл.', 'площі': 'пл.', 'пл': 'пл.', 'площадь': 'пл.',
  'узвіз': 'узвіз', 'узв': 'узвіз', 'спуск': 'узвіз',
  'проїзд': 'проїзд', 'пр-д': 'проїзд', 'прд': 'проїзд', 'проезд': 'проїзд',
  'тупик': 'тупик', 'туп': 'тупик',
  'шосе': 'шосе', 'шоссе': 'шосе',
  'набережна': 'наб.', 'наб': 'наб.', 'набережная': 'наб.',
  'алея': 'алея', 'аллея': 'алея',
  'майдан': 'майдан', 'майд': 'майдан',
  'лінія': 'лінія', 'линия': 'лінія'
}));

/**
 * Words that are also ordinary names («вул. Набережна»), so they count as a type only at the start:
 * «набережна Леніна», but not the end of «Січеславська Набережна».
 */
const NAMES_TOO = new Set(['набережна', 'набережная', 'алея', 'аллея', 'майдан', 'лінія', 'линия']);
const WEAK_TYPES = new Set(['набережна', 'наб', 'набережная', 'алея', 'аллея', 'лінія', 'линия', 'майдан', 'майд', 'шосе', 'шоссе', 'тупик', 'туп', 'проїзд', 'пр-д', 'прд', 'проезд']);

/** Settlement kinds. As in the app, «смт», «с-ще», «сел» and «селище» are one kind. */
const SETTLEMENT_TYPES = new Map(Object.entries({
  'м': 'м.', 'місто': 'м.', 'город': 'м.', 'г': 'м.',
  'смт': 'смт', 'с-ще': 'смт', 'сщ': 'смт', 'сел': 'смт', 'селище': 'смт', 'пгт': 'смт', 'пос': 'смт', 'поселок': 'смт', 'посёлок': 'смт', 'селищемісцевого': 'смт',
  'с': 'с.', 'село': 'с.', 'c': 'с.', 'сл': 'с.',
  'хут': 'хут.', 'хутір': 'хут.', 'хутор': 'хут.'
}));

/** «вулиця Ватутіна» and «Ватутіна вулиця»: whether a word is a street type, and which. */
export function streetTypeOf(word) {
  return STREET_TYPES.get(fold(word).replace(/\.+$/, '')) ?? '';
}

export function settlementTypeOf(word) {
  return SETTLEMENT_TYPES.get(fold(word).replace(/\.+$/, '')) ?? '';
}

/** The class used to compare types: the abbreviation itself (`вул.` and `вулиця` are the same). */
export function typeClass(type) {
  return type || '';
}

// ---- Junk ----------------------------------------------------------------------------------

const FILLERS = new Set(['імені', 'ім', 'имени', 'им']);
const L = '\\p{L}';

/** Placeholder names the councils use for a street that has not been named yet: «Нова 400-та», «Проєктна 12977». */
export function isJunkName(name) {
  const words = cleanSpaces(name).split(' ').filter(Boolean);
  if (!words.length) return true;
  const letters = fold(words.join('')).replace(/[^а-яіїєa-z]/g, '');
  if (letters.length < 2) return true;
  const first = fold(words[0]);
  if (/^(проєктн|проектн|безімен|безымян|невідом|без$)/.test(first)) return true;
  if (/№\s*\d/.test(name)) return true;
  if (/^(завулок|дорога|проїзд)$/.test(first) && words.length === 2 && /^\d/.test(words[1])) return true;
  if (/^(нова|нов|новий|нове)$/.test(first) && (words.length === 1 || /^[№#]?\d/.test(words[1]))) return true;
  return false;
}

/**
 * Whether a key looks like a NAME and not like a sentence, a list or a note that ended up in a table cell
 * («Арсенальна вулиця Назва походить від слова «арсенал».», «До 2014 — Калініна», «Воронцова/Воронцовський»,
 * «Один з трьох провулків Давидова», «Комсомольський з початку 1930-х років», «Будівельна - непарна сторона»,
 * «Перемоги пр-т 15 км», or a lone «Проїзд»). Applied to every key before it is published, and again by the gate.
 */
export function isPlausibleKey(name) {
  const text = cleanSpaces(name);
  if (!text || text.length > 48) return false;
  if (/[,;:|/()«»"\[\]\\—–=<>]/.test(text)) return false;
  const words = text.split(' ');
  if (words.length > 6) return false;
  if (/^(до|як|за|із|з|від|на|при|біля|це|який|яка)$/i.test(words[0])) return false;
  // A count or a quantity opens a sentence («Один з трьох …», «Кілька вулиць …»), not a name.
  if (/^(один|одна|одну|одне|одного|кілька|декілька|дві|два|три|чотири|обидві|усі|всі)$/i.test(words[0]) && words.length > 1) return false;
  if (words.some((w) => /^(походить|який|включає|об’єднано|об'єднано|перейменовано|ділянка|відрізок|вулицяя|сторона|сторони|сторону|непарна|парна|непарний|парний|початку|кінця|км|кілометр|кілометрів|рр)$/i.test(w))) return false;
  // «з початку 1930-х років», «з 1991»: a date range is a note.
  if (/(^|\s)з\s+(початку|кінця|\d)/i.test(text) || /\d{4}-х/.test(text)) return false;
  // «- непарна сторона»: a dash between words is a note's separator; a hyphen inside a word is not.
  if (/\s[-‐‑]\s/.test(text)) return false;
  // A lone type word is a category, not a name («Проїзд»). The few kinds that are also ordinary street names
  // («вул. Набережна», «вул. Алея», «пл. Майдан») stay.
  const kind = (w) => STREET_TYPES.has(fold(w).replace(/\.+$/, '')) && !NAMES_TOO.has(fold(w).replace(/\.+$/, ''));
  if (words.every(kind)) return false;
  // A name that begins or ends with a type word AND says it twice («проїзд Білоруський проїзд»).
  if (words.length > 1 && kind(words[0]) && kind(words[words.length - 1])) return false;
  return true;
}

// ---- Parsing a name ------------------------------------------------------------------------

const ROMAN = /^[іvх]{2,}$/;
const ROMAN_VALUES = { і: 1, v: 5, х: 10 };
const ORDINAL_ENDINGS = new Set(['й', 'ий', 'ій', 'я', 'а', 'е', 'є', 'го', 'ого', 'ої', 'ша', 'га', 'та', 'ма', 'му', 'ю', 'ї', 'ой', 'ый', 'ая', 'ое', 'ье', 'ти', 'ми', 'ті']);

function romanToArabic(word) {
  if (!ROMAN.test(word)) return null;
  let total = 0;
  for (let i = 0; i < word.length; i++) {
    const v = ROMAN_VALUES[word[i]];
    const next = ROMAN_VALUES[word[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return total > 0 && total < 40 ? String(total) : null;
}

/** Cuts text into words at anything that is not a letter or a digit; a hyphen makes two words. */
function wordsOf(text) {
  return cleanSpaces(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Reads one name. `kind` is `street` or `settlement`: «с» is a village in one and nothing in the
 * other.
 */
export function parseName(raw, kind = 'street') {
  const typeOf = kind === 'settlement' ? settlementTypeOf : streetTypeOf;
  let text = cleanSpaces(String(raw ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '));
  const result = { raw: text, type: '', name: '', tokens: [], ordered: [], initials: [], part: false, unofficial: false, junk: false, locality: '' };

  // Parentheticals: «(част.)», «(неоф.)», «(Бортничі)». Their content is remembered, not matched.
  const notes = [];
  text = text.replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (_, a, b) => { notes.push(cleanSpaces(a ?? b)); return ' '; });
  text = text.replace(/[(){}\[\]]/g, ' ');
  for (const note of notes) {
    const n = fold(note);
    if (/^част/.test(n) || /^(одна з|відрізок|ділянка)/.test(n)) result.part = true;
    else if (/неоф/.test(n)) result.unofficial = true;
    else if (note && !/^\d+$/.test(note)) result.locality = result.locality ? `${result.locality}, ${note}` : note;
  }
  if (/(?<!\p{L})част(ина|ини|ку|ково)(?!\p{L})/iu.test(text)) result.part = true;
  text = text.replace(/(?<!\p{L})частин[аиу](\s+(вулиці|вул\.?|провулка|проспекту|площі|бульвару))?(?!\p{L})/giu, ' ');

  // «ім. Леніна» (glued or not): the filler says nothing about which street.
  text = text.replace(/(?<!\p{L})[Іі]м\.\s*/gu, ' ');

  // «селище міського типу Ювілейне» is «смт Ювілейне».
  if (kind === 'settlement') text = text.replace(/(?<!\p{L})селище\s+міського\s+типу(?!\p{L})/giu, 'смт');

  // Type word: at the start, or at the end («Московський проспект»).
  let parts = text.split(/\s+/).filter(Boolean);
  // Glued: «вул.Садова», «вул.Т.Шевченка».
  parts = parts.flatMap((p) => {
    const m = p.match(/^([А-Яа-яІіЇїЄє]{1,5})\.([\p{L}\p{N}].*)$/u);
    return m && typeOf(m[1]) ? [m[1], m[2]] : [p];
  });
  let type = '';
  const first = parts[0];
  if (first && parts.length > 1 && typeOf(first)) {
    type = typeOf(first);
    parts.shift();
  } else {
    const last = parts[parts.length - 1];
    if (last && parts.length > 1 && typeOf(last) && !(kind === 'street' && WEAK_TYPES.has(fold(last).replace(/\.+$/, '')))) {
      type = typeOf(last);
      parts.pop();
    }
  }
  // «1-й провулок Матросова», «2-ий проїзд Лісний»: the number first, then the type, then the name.
  if (!type && parts.length > 2 && /^(\d+(-?[а-яіїєй]{0,3})|[ІVХ]{1,4}(-?[а-яіїєй]{0,3}))$/u.test(parts[0]) && typeOf(parts[1])) {
    type = typeOf(parts[1]);
    parts.splice(1, 1);
  }
  result.type = type;

  // Initials: «Т.Г. Шевченка», «Богуна І.», «І.Франка»: a capital with a dot, set apart from a word.
  let body = parts.join(' ');
  const initials = [];
  body = body.replace(/(?<![\p{L}])([А-ЯІЇЄҐA-Z])\./gu, (m, letter) => { initials.push(fold(letter)); return ' '; });
  result.initials = initials;

  const kept = body.split(/\s+/).filter((p) => p && !FILLERS.has(fold(p).replace(/\.+$/, '')));
  const display = kept.join(' ').replace(/^[\s\-–—,.;:]+|[\s\-–—,;:]+$/g, '').replace(/\s{2,}/g, ' ');
  result.name = display.trim();
  result.junk = isJunkName(result.name) || /^\d+$/.test(result.name);

  // Tokens.
  const tokens = [];
  for (const w of wordsOf(fold(result.name))) {
    let word = unmix(w);
    if (!word) continue;
    // A Roman numeral typed in Latin letters («Іоанна Павла II») is the Cyrillic one.
    if (/^[ivx]{2,}$/.test(word)) word = word.replace(/i/g, 'і').replace(/x/g, 'х');
    if (tokens.length && /^\d+$/.test(tokens[tokens.length - 1]) && ORDINAL_ENDINGS.has(word)) continue;
    tokens.push(romanToArabic(word) ?? word);
  }
  // A single letter left over is an initial written without its dot.
  const significant = [];
  for (const t of tokens) {
    if (t.length === 1 && !/\d/.test(t) && tokens.length > 1) { result.initials.push(t); continue; }
    significant.push(t);
  }
  result.ordered = [...new Set(significant)];
  result.tokens = [...result.ordered].sort();
  return result;
}

/** The comparison key: the token set as one string. */
export function nameKey(tokens) {
  return tokens.join(' ');
}

/** Key of a type class plus a token set; the unit the join works on. */
export function recordKey(type, tokens) {
  return `${typeClass(type)}|${nameKey(tokens)}`;
}

/** Display spelling of a former name: spaces tidied, stray quotes and punctuation trimmed. */
export function tidyName(name) {
  let text = cleanSpaces(name).replace(/\s+([,.;:])/g, '$1');
  for (;;) {
    const next = text.replace(/^[\s"«„“'’\-–—,.;:]+|[\s"»“”'’\-–—,;:]+$/g, '');
    if (next === text) break;
    text = next;
  }
  // A quote left open at one end of a name («Крейсера «Аврора») is dropped; a balanced pair stays.
  const opens = (text.match(/«/g) ?? []).length, closes = (text.match(/»/g) ?? []).length;
  if (opens > closes) text = text.replace(/«/g, '');
  if (closes > opens) text = text.replace(/»/g, '');
  return text;
}

/** Letters in a name: «Ґедройця» has 8. */
export function letterCount(name) {
  return (String(name).match(/\p{L}/gu) ?? []).length;
}

/** Whether a name is written in Cyrillic: at least three Cyrillic letters and no Latin ones. */
export function isCyrillicName(name) {
  const text = String(name);
  return (text.match(/[а-яіїєґА-ЯІЇЄҐ]/g) ?? []).length >= 3 && !/[a-zA-Z]/.test(text.replace(/[ʼ'’]/g, ''));
}

// ---- A kind written after the name, dates in acts, spellings ---------------------------------------

/** Kinds that parseName leaves in the name when they come last («Дарницьке шосе») because they are also plain names. */
const TRAILING_KINDS = new Set(['шосе', 'шоссе', 'проїзд', 'проезд', 'тупик']);

/**
 * «Дарницьке шосе», «Якубенківський проїзд», «Байкальський тупик»: an adjective and then the kind. The kind
 * is the OLD thing's kind, and keeping it in the name next to a type of «вул.» (the new street's) printed
 * «вул. Дарницьке шосе». Returns `{ type, name }` with the trailing kind taken out, or null when there is none.
 */
export function trailingKind(parsed) {
  const words = parsed.name.split(' ');
  if (words.length < 2) return null;
  const last = fold(words[words.length - 1]).replace(/\.+$/, '');
  if (!TRAILING_KINDS.has(last)) return null;
  const rest = words.slice(0, -1).join(' ');
  // The word before must be an adjective («Дарницьке», «Якубенківський», «Городній», «Старокостянтинівського»),
  // alone or after an ordinal («2-й Рибінський»); not a number or a name's part.
  const head = rest.replace(/^\d+(-[а-яі]{1,3})?\s+/i, '');
  if (!/(ий|ій|а|я|е|є|ого|ої)$/i.test(head) || /\d/.test(head)) return null;
  return { type: streetTypeOf(words[words.length - 1]), name: rest };
}

const MONTHS = { січня: 1, лютого: 2, березня: 3, квітня: 4, травня: 5, червня: 6, липня: 7, серпня: 8, вересня: 9, жовтня: 10, листопада: 11, грудня: 12 };

/** The date an act is of, as `YYYY-MM-DD`: «від 18 грудня 2024 року», «від 21.09.2022 № 43/27»; '' when there is none. */
export function actDate(text) {
  const s = String(text ?? '');
  let m = s.match(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/(?<!\d)(\d{1,2})\s+([а-яі]+)\s+(\d{4})(?!\d)/i);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

/** Levenshtein distance, stopping early above `limit`. */
export function editDistance(a, b, limit = 3) {
  const x = [...a], y = [...b];
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > limit) return limit + 1;
    prev = cur;
  }
  return prev[y.length];
}

/**
 * Whether two token lists are one name in two spellings («Короленко» / «Короленка»): the same number of words,
 * each the same or one letter off. A pair like that is a correction of the spelling, not a rename.
 */
export function isRespelling(a, b) {
  if (a.length !== b.length || !a.length) return false;
  const x = [...a].sort(), y = [...b].sort();
  let changed = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    if (x[i].length < 5 || editDistance(x[i], y[i], 1) > 1) return false;
    changed++;
  }
  return changed > 0 && changed <= 2;
}
