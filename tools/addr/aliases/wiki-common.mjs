/**
 * What the Wikipedia parsers share: reading a cell of former names, a cell of types, a year.
 */
import { plain, splitTop, stripNotes } from './wikitext.mjs';
import { parseName, streetTypeOf, tidyName, isJunkName, cleanSpaces } from './text.mjs';

/** Districts as one comma list: «[[Подільський район (Київ)|Подільський]], Святошинський» → «Подільський, Святошинський». */
export function districts(cell) {
  return plain(cell)
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s*(?:,|\/|;|\sта\s|\sі\s)\s*/)
    .map((d) => d.replace(/\s*(район|райони|р-н|р-ни)$/i, '').trim())
    .filter((d) => d && !/^\d+$/.test(d))
    .join(', ');
}

/** One former-names cell → [{ name, type, part, merge }], junk and unofficial names dropped. */
export function formerNames(cell) {
  const items = splitTop(stripNotes(cell), ',', { parens: true });
  const out = [];
  for (const item of items) {
    const text = plain(item);
    if (!text) continue;
    const pieces = text.split(/\s+\+\s+/);
    const merge = pieces.length > 1;
    for (const piece of pieces.flatMap((p) => p.split(/\s+\/\s+|(?<=\p{L}{3})\/(?=\p{L}{3})|\s*[;|]\s*/u))) {
      const parsed = parseName(piece, 'street');
      const name = tidyName(parsed.name);
      if (!name || parsed.junk || parsed.unofficial || isJunkName(name)) continue;
      out.push({ name, type: parsed.type, part: parsed.part, merge });
    }
  }
  return out;
}

/** The street kinds a type cell names: «вулиця та пров.» → [вул., пров.]; unknown kinds (парк, сквер) → []. */
export function typesOf(cell) {
  const text = cleanSpaces(plain(cell));
  const kinds = [];
  for (const part of text.split(/\s+та\s+|\s+і\s+|\s*[,/]\s*|\s+/)) {
    const kind = streetTypeOf(part);
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  // «проспект та ж/м»: the second kind is a housing estate, not a street kind we know; only [просп.] stays.
  return kinds;
}

/** The first plausible year in a raw cell (templates such as {{Рік|2016}} included). */
export function yearIn(raw) {
  const m = String(raw ?? '').match(/(?<!\d)(1[5-9]\d\d|20[0-3]\d)(?!\d)/);
  return m ? m[1] : '';
}

/** The last year in a heading chain: «Список перейменувань у 2015—2016 рр.» → 2016. */
export function headingYear(headings) {
  for (let i = headings.length - 1; i >= 0; i--) {
    const years = [...plain(headings[i]).matchAll(/(?<!\d)(1[5-9]\d\d|20[0-3]\d)(?!\d)/g)].map((m) => m[1]);
    if (years.length) return years[years.length - 1];
  }
  return '';
}

/** A short act reference out of a heading, when it names a decision. */
export function headingAct(headings) {
  for (let i = headings.length - 1; i >= 0; i--) {
    const text = plain(headings[i]);
    if (/(рішенн|розпорядж|наказ|постанов)/i.test(text)) return text.replace(/^Список перейменувань вулиць [^ ]+\s*/i, '').slice(0, 100);
  }
  return '';
}
