/**
 * The shape every parser writes and the builder reads: one renamed street or settlement per row.
 * `sources/*.tsv` holds exactly these rows, sorted, so a refresh is a reviewable git diff.
 */
export const SOURCE_COLUMNS = [
  'list', 'scope', 'old_type', 'old_name', 'new_type', 'new_name', 'district', 'year', 'act', 'src', 'flags', 'ru', 'note', 'url', 'fetched'
];

/**
 * list      `streets` or `settlements`: which operator list the NEW name is looked up in
 * scope     `kyiv`; a region id for settlements (`dnipro`); `<region>/<town>` for a town's streets
 * old_type  what the source called the old thing (`вул.`, `просп.`, …), empty when it did not say
 * old_name  the old name as written, without the type word
 * new_type, new_name   the same for the current name
 * district  where it is: a district for streets, the former raion or hromada for settlements
 * year      the year the current name was decided, when the source says
 * act       the act or decision, as the source cites it
 * src       `vr` (Rada act), `loc` (council or ODA act), `wp` (uk/ru.wikipedia), `osm`, `rdp` (rename.dp.ua), `man`
 * flags     comma-separated: `part` (only a section renamed), `merge` (the new street took several old ones)
 * ru        the old name in Russian, when the source gave one
 * note      anything a reviewer wants to see (the cadastre code, the location text)
 * url       where the row was read
 * fetched   the date it was read
 */
export function row(fields) {
  const out = {};
  for (const c of SOURCE_COLUMNS) out[c] = fields[c] ?? '';
  return out;
}

export const SOURCE_SORT = ['list', 'scope', 'new_name', 'new_type', 'old_name', 'old_type', 'district', 'src', 'act'];
