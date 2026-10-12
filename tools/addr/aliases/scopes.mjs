/**
 * Which operator list a source row belongs to.
 *
 *   `kyiv`                      Kyiv's streets (flat)
 *   `<region>`                  that region's settlements
 *   `<region>/<town>`           the streets of a town, in the list(s) of the settlement(s) named below
 *   `<region>/~<type> <name>`   the streets of a village a council table named; resolved against the
 *                               region's settlement list, and used only if exactly one settlement fits
 *
 * A town can be several settlements in the operator's list (Кам'янське is c/48, c/49 and c/50):
 * the pairs are joined against each, and each gets its own `aliases.json`.
 */
import { parseName } from './text.mjs';

/** town → settlement titles in the operator's `settlements.json` (compared without apostrophes or case). */
export const TOWNS = {
  'dnipro/dnipro': ['м. Дніпро'],
  'dnipro/kryvyi-rih': ['м. Кривий Ріг'],
  'dnipro/kamianske': ["м. Кам'янське", "м. Кам'янське, смт Карнаухівка"],
  'dnipro/nikopol': ['м. Нікополь'],
  'dnipro/pavlohrad': ['м. Павлоград'],
  'odesa/odesa': ['м. Одеса'],
  'odesa/izmail': ['м. Ізмаїл'],
  'odesa/chornomorsk': ['м. Чорноморськ'],
  'odesa/bilhorod-dnistrovskyi': ['м. Білгород-Дністровський'],
  'odesa/podilsk': ['м. Подільськ'],
  'kyiv-region/bila-tserkva': ['м. Біла Церква'],
  'kyiv-region/boryspil': ['м. Бориспіль'],
  'kyiv-region/brovary': ['м. Бровари'],
  'kyiv-region/bucha': ['м. Буча'],
  'kyiv-region/irpin': ['м. Ірпінь'],
  'kyiv-region/vasylkiv': ['м. Васильків'],
  'kyiv-region/vyshhorod': ['м. Вишгород'],
  'kyiv-region/obukhiv': ['м. Обухів'],
  'kyiv-region/fastiv': ['м. Фастів'],
  'kyiv-region/pereyaslav': ['м. Переяслав'],
  'khmelnytskyi/khmelnytskyi': ['Хмельницький']
};

/** `kyiv-region/~смт Ворзель` → { region, type: 'смт', name: 'Ворзель' }. */
export function parseScope(scope) {
  if (scope === 'kyiv') return { kind: 'kyiv', region: 'kyiv' };
  const [region, rest] = scope.split('/');
  if (rest === undefined) return { kind: 'settlements', region };
  if (rest.startsWith('~')) {
    const village = parseName(rest.slice(1), 'settlement');
    return { kind: 'village', region, type: village.type, tokens: village.tokens, name: village.name };
  }
  return { kind: 'town', region, town: rest };
}

/** The settlement indices a scope's streets are joined against, in a region's settlement list. */
export function settlementsOf(scope, region) {
  const parsed = parseScope(scope);
  const settlements = region.settlements;
  if (parsed.kind === 'town') {
    const exactTitles = new Set((TOWNS[scope] ?? []).map((t) => t.replace(/['’ʼ`]/g, '').toLowerCase()));
    const out = [];
    for (const row of settlements.rows) {
      const plain = String(row.title).replace(/['’ʼ`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (exactTitles.has(plain)) out.push(row.index);
    }
    return { indices: out, ambiguous: false };
  }
  if (parsed.kind === 'village') {
    const hits = settlements.rows.filter((r) => r.eligible && r.parsed.type === parsed.type && r.parsed.tokens.join(' ') === parsed.tokens.join(' '));
    // Several settlements of one name: no way to tell which one the council meant.
    return { indices: hits.length === 1 ? [hits[0].index] : [], ambiguous: hits.length > 1, candidates: hits.length };
  }
  return { indices: [], ambiguous: false };
}
