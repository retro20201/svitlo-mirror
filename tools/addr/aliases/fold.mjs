/**
 * A port of the parts of the app's `AddressSearchText.swift` (Svitlo, fix/address-search) that decide
 * whether a typed word reads as a word of a name, so that
 *   - the builder stores a Russian form (`ru`) only when the app's own folding would NOT derive it from
 *     the Ukrainian key, and
 *   - the corpus regression can replay a query against an alias file without the app.
 *
 * The final authority is the app's XCTest over fixture copies of the files; this port is a cheap
 * guard that runs in CI and agrees with the Swift tables as of 2026-10-12. If the Swift tables change,
 * change these (the tables are written in the same order to make the comparison a diff).
 */

const KEYBOARD = { є: 'е', э: 'е', ё: 'е', і: 'и', ї: 'и', ы: 'и', ґ: 'г' };
const KEY_VOWELS = new Set(['о', 'е', 'и', 'і', 'ы', 'ї', 'є', 'э', 'ё']);
const LOOKALIKES = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const APOSTROPHES = /['’ʼ‘`´ʹ]/g;

/** The `loose` form of an already lower-cased word: what a Russian keyboard lacks folded together, ъ dropped. */
export function loose(exact) {
  let out = '';
  for (const ch of exact) if (ch !== 'ъ') out += KEYBOARD[ch] ?? ch;
  return out;
}

/** Lower case, Latin look-alikes made Cyrillic, apostrophes dropped: the `exact` form of a run of letters. */
export function exactOf(run) {
  return [...run.normalize('NFC').replace(APOSTROPHES, '').toLowerCase()].map((c) => LOOKALIKES[c] ?? c).join('');
}

/** Russian endings in their Ukrainian form, on the `loose` form and from five letters. Longest first. */
const RUSSIAN_ENDINGS = [
  ['ическая', ['ічна']], ['ический', ['ічний']],
  ['зского', ['зького']], ['ского', ['ського']], ['цкого', ['цького']],
  ['зская', ['зька']], ['зский', ['зький']], ['зское', ['зьке']],
  ['ская', ['ська']], ['цкая', ['цька']], ['ский', ['ський']], ['цкий', ['цький']],
  ['ской', ['ський', 'ської']], ['цкой', ['цький', 'цької']],
  ['ское', ['ське']], ['цкое', ['цьке']], ['ские', ['ські']], ['цкие', ['цькі']],
  ['овой', ['овий', 'ової']], ['евой', ['евий', 'евої']],
  ['ово', ['ове']], ['ево', ['еве']],
  ['ая', ['а']], ['яя', ['я']], ['ое', ['е']], ['ые', ['і']], ['ой', ['ий', 'ої']],
  ['ье', ['я']], ['ов', ['ів']], ['ев', ['ів']], ['ко', ['ка']]
].map(([ru, uk]) => [loose(ru), uk.map(loose)]);

export function ukrainianEndings(looseWord) {
  if ([...looseWord].length < 5) return [];
  for (const [russian, ukrainian] of RUSSIAN_ENDINGS) {
    if (looseWord.endsWith(russian)) {
      const stem = looseWord.slice(0, looseWord.length - russian.length);
      return ukrainian.map((u) => stem + u);
    }
  }
  return [];
}

const RUSSIAN_WORDS = (() => {
  const table = {
    'мира': ['миру'], 'победы': ['перемоги'], 'победа': ['перемога'],
    'независимости': ['незалежності'], 'возрождения': ['відродження'],
    'большая': ['велика'], 'большой': ['великий'], 'белая': ['біла'], 'белый': ['білий'],
    'церковь': ['церква'], 'желтые': ['жовті'], 'воды': ['води'],
    'красный': ['червоний'], 'красная': ['червона'], 'камень': ['камінь'],
    'солнечный': ['сонячний'], 'солнечная': ['сонячна'],
    'восточный': ['східний'], 'восточная': ['східна'],
    'строителей': ['будівельників'], 'сечевых': ['січових'], 'стрельцов': ['стрільців'],
    'николаевская': ['миколаївська'], 'николаевский': ['миколаївський'],
    'греческая': ['грецька'], 'раздельная': ['роздільна'], 'казацкая': ['козацька'],
    'рабочая': ['робоча'], 'яблоневая': ['яблунева'], 'звездная': ['зоряна'],
    'запорожское': ['запорізьке'], 'каменецкая': ['камянецька'], 'рога': ['рогу'],
    'лет': ['років'], 'летия': ['річчя'], 'ссср': ['срср'], 'днепр': ['дніпро'], 'рог': ['ріг']
  };
  const out = new Map();
  for (const [ru, uk] of Object.entries(table)) out.set(loose(ru), uk.map(loose));
  return out;
})();

export function translations(looseWord) {
  return RUSSIAN_WORDS.get(looseWord) ?? [];
}

/** The vowel-merged key on which a Russian and a Ukrainian spelling of one name meet (matched from the start of a word only, as a guess). */
export function russianKey(looseWord) {
  const key = [];
  for (const ch of looseWord) {
    if (ch === 'ь') continue;
    const folded = KEY_VOWELS.has(ch) ? 'и' : ch;
    if (folded !== 'и' && key[key.length - 1] === folded) continue;
    key.push(folded);
  }
  return key.join('');
}

// ---- Latin typed on the English layout ("Peremohy" → "перемоги") ------------------------------

const LATIN_SPELLINGS = [
  ['shch', 'щ'], ['zgh', 'зг'], ['kh', 'х'], ['zh', 'ж'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'],
  ['ya', 'я'], ['ia', 'я'], ['yu', 'ю'], ['iu', 'ю'], ['ie', 'є'], ['yo', 'йо'], ['a', 'а'], ['b', 'б'], ['v', 'в'], ['h', 'г'], ['g', 'г'], ['d', 'д'],
  ['e', 'е'], ['z', 'з'], ['y', 'и'], ['i', 'і'], ['j', 'й'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'],
  ['c', 'ц'], ['w', 'в'], ['x', 'кс'], ['q', 'к']
];

export function isLatin(text) {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  return letters.length > 0 && letters.every((c) => c.charCodeAt(0) < 128);
}

export function cyrillicFromLatin(text) {
  const words = [];
  for (const raw of text.toLowerCase().split(' ')) {
    let word = raw;
    let result = '';
    for (const [latin, cyrillic] of [['yi', 'ї'], ['ye', 'є']]) {
      if (word.startsWith(latin)) { result = cyrillic; word = word.slice(2); }
    }
    let ending = '';
    if (word.length > 3 && (word.endsWith('yi') || word.endsWith('iy'))) { word = word.slice(0, -2); ending = 'ий'; }
    scan: while (word.length) {
      for (const [latin, cyrillic] of LATIN_SPELLINGS) {
        if (word.startsWith(latin)) { result += cyrillic; word = word.slice(latin.length); continue scan; }
      }
      result += word[0];
      word = word.slice(1);
    }
    words.push(result + ending);
  }
  return words.join(' ');
}

// ---- Words of a name, and whether a typed word reads as one ---------------------------------

const STREET_TYPE_WORDS = new Set([
  'вул', 'вулиця', 'ул', 'улица', 'пров', 'провулок', 'пер', 'переулок', 'просп', 'проспект', 'пр', 'бул', 'бульв', 'бульвар',
  'пл', 'площа', 'площадь', 'майдан', 'майд', 'наб', 'набережна', 'набережная', 'узвіз', 'узв', 'спуск', 'тупик', 'туп',
  'шосе', 'шоссе', 'проїзд', 'проезд', 'алея', 'аллея'
].map(loose));
const SETTLEMENT_TYPE_WORDS = new Set(['м', 'місто', 'город', 'г', 'смт', 'селище', 'сел', 'пгт', 'пос', 'поселок', 'с', 'село', 'хут', 'хутір', 'хутор'].map(loose));
const FILLERS = new Set(['имени', 'им', 'садове', 'садовое', 'дачне', 'дачное'].map(loose));

/** Words of a text as the app cuts them: runs of letters and digits, apostrophes dropped, Latin look-alikes made Cyrillic. */
export function words(text) {
  const clean = text.normalize('NFC').replace(APOSTROPHES, '');
  const runs = clean.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return runs.map((r) => loose(exactOf(r)));
}

const NAME_ENDINGS = ['ов', 'ев', 'ко'].map(loose);

/** A surname or a town ends in «-ов», «-ев» or «-ко»: its Ukrainian form stands for that whole word only. */
export function endsLikeAName(looseWord) {
  return [...looseWord].length >= 5 && NAME_ENDINGS.some((e) => looseWord.endsWith(e));
}

/** One substitution, swap of neighbours, extra letter or missing letter away from the START of `word`. */
export function isOneEdit(typed, word) {
  const t = [...typed], w = [...word];
  const count = t.length;
  if (!count) return false;
  const dropsOne = (longer, shorter) => {
    if (longer.length !== shorter.length + 1) return false;
    let l = 0, s = 0, dropped = false;
    while (l < longer.length && s < shorter.length) {
      if (longer[l] === shorter[s]) { l++; s++; } else if (dropped) return false; else { dropped = true; l++; }
    }
    return true;
  };
  if (w.length >= count) {
    const diffs = [];
    for (let i = 0; i < count; i++) {
      if (t[i] !== w[i]) { diffs.push(i); if (diffs.length > 2) break; }
    }
    if (diffs.length <= 1) return true;
    if (diffs.length === 2 && diffs[1] === diffs[0] + 1 && t[diffs[0]] === w[diffs[1]] && t[diffs[1]] === w[diffs[0]]) return true;
  }
  if (count >= 2 && w.length >= count - 1 && dropsOne(t, w.slice(0, count - 1))) return true;
  if (w.length >= count + 1 && dropsOne(w.slice(0, count + 1), t)) return true;
  return false;
}

/** The strict readings only: the same word after the keyboard fold, the Russian ending read in Ukrainian, a Russian word with another Ukrainian word. */
export function wordReadsExactly(typed, titleWord) {
  if (typed === titleWord) return true;
  if (ukrainianEndings(typed).includes(titleWord)) return true;
  if (translations(typed).includes(titleWord)) return true;
  return false;
}

/**
 * Whether a typed word is a word of the title, as the app's index scores it (`AddressSearchIndex`):
 * the same word, the start of it (someone still typing), the Russian ending read in Ukrainian
 * (a name keeps its whole word), a translation, the vowel-merged Russian key and one typo. The
 * last three are the guess pass: they show a row, marked approximate, but never choose it.
 */
export function wordReads(typed, titleWord) {
  if (typed === titleWord || titleWord.startsWith(typed)) return true;
  const derived = ukrainianEndings(typed).filter((d) => d !== typed);
  if (derived.includes(titleWord)) return true;
  if (!endsLikeAName(typed) && derived.some((d) => titleWord.startsWith(d))) return true;
  const translated = translations(typed);
  if (translated.includes(titleWord) || translated.some((t) => titleWord.startsWith(t))) return true;
  if ([...typed].length >= 5) {
    const forms = [typed, ...derived];
    const key = russianKey(titleWord);
    if (forms.map(russianKey).some((k) => key.startsWith(k))) return true;
    if (forms.some((f) => isOneEdit(f, titleWord))) return true;
  }
  return false;
}

/**
 * Whether a query finds a title: after the type words, ordinal endings and a trailing house number
 * are set aside, every typed word is a word of the title (in any order). Prefix typing is not
 * replayed: the corpus queries are finished words.
 */
export function queryFindsTitle(query, title, vocabulary = 'street') {
  const typeWords = vocabulary === 'street' ? STREET_TYPE_WORDS : SETTLEMENT_TYPE_WORDS;
  const strip = (text) => words(text).filter((w) => !typeWords.has(w) && !FILLERS.has(w));
  let q = query.trim();
  // A trailing house number («Перемоги 52», «Московский пр-т 22а»).
  q = q.replace(/[\s,]+(?:буд\.?\s*|№\s*)?\d+[а-яa-zіїє]?(?:[/\-]\d+)?\s*$/iu, '');
  const typed = strip(q).filter((w) => !/^[а-яіїєa-z]$/.test(w));
  const target = strip(title);
  if (!typed.length || !target.length) return false;
  const read = (candidates) => candidates.every((w) => target.some((t) => wordReads(w, t) || (/^\d+$/.test(w) && w === t)));
  if (read(typed)) return true;
  // The English layout: «Peremohy» is «Перемоги».
  if (isLatin(q)) {
    const cyr = words(cyrillicFromLatin(q.toLowerCase())).filter((w) => !typeWords.has(w));
    if (cyr.length && read(cyr)) return true;
  }
  return false;
}

/** The Russian forms a Ukrainian key already yields through the app's folding, so `ru` need not store them. */
export function derivableRussian(ukrainianKey, russianForm) {
  const uk = words(ukrainianKey);
  const ru = words(russianForm);
  if (!ru.length || ru.length !== uk.length) return false;
  return ru.every((w) => uk.some((u) => wordReadsExactly(w, u)));
}
