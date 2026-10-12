# Licence and attribution of `aliases.json`

The `aliases.json` files list which old and former names belong to which operator row. They are built
from the sources below, and **each target says which sources back it** in its `s` field (`wp`, `osm`,
`vr`, `loc`, `rdp`, `man`; the legend is in the file's `src`). `tools/addr/aliases/sources/*.tsv` keeps,
for every row, the URL it was read from (Wikipedia: the exact revision, `?oldid=`) and the date.

This is the owner's decision of 2026-10-12 (option «a»): publish with the source codes, credit the
projects, and keep rename.dp.ua out of anything it would carry alone.

## What the data is

Old name → new name is a fact about a street, taken from public acts of the Верховна Рада, city councils
and the Odesa regional administration. Those acts are official documents and are understood not to be
objects of copyright (Law of Ukraine «Про авторське право і суміжні права», art. 10); that reading is the
owner's to confirm, and this note is not legal advice. Wikipedia and OpenStreetMap carry the same facts and
are the only complete source for Kyiv's 2022–2025 renames (the council decisions exist only as image scans)
and for Dnipro, Kryvyi Rih, Kamianske and others, so they are used and credited.

## Credits

- **Wikipedia.** Rows with code `wp` are taken from the Ukrainian and Russian Wikipedia lists of streets
  and renamed places («Список вулиць Києва», «Вулиці Дніпра», «Вулиці Кривого Рогу», «Вулиці Одеси»,
  «Вулиці Хмельницького», «Вулиці Борисполя», «Вулиці Нікополя», «Вулиці Павлограда», «Список перейменованих вулиць
  Василькова», the lists of settlements renamed by the decommunisation and decolonisation laws, ru.wikipedia
  «Список улиц Одессы»), © Wikipedia contributors, licensed under **Creative Commons Attribution-ShareAlike 4.0**
  (https://creativecommons.org/licenses/by-sa/4.0/). The history of each page names its authors. The rows in
  `sources/wikipedia-*.tsv` are an adaptation of those tables and stay under CC BY-SA 4.0.
- **OpenStreetMap.** Rows with code `osm` are taken from the `old_name` tags of OpenStreetMap highways,
  © **OpenStreetMap contributors**, available under the **Open Database Licence 1.0**
  (https://opendatacommons.org/licenses/odbl/, https://www.openstreetmap.org/copyright). `sources/osm.tsv`
  is a derived database of those tags; it is offered under the ODbL, and the way of each row is in its `url`.
- **Official acts.** Rows with code `vr` (Верховна Рада, zakon.rada.gov.ua) and `loc` (Борисполя, Бучі,
  Броварів, Білої Церкви, Хмельницького, the Odesa regional administration) are the acts' own text.
- **rename.dp.ua** (code `rdp`) states no licence. It is a **cross-check only**: the builder never publishes
  a pair that only it knows, and the gate refuses a target whose sources are `rdp` alone.

## The two share-alike licences

CC BY-SA 4.0 and ODbL 1.0 are both share-alike and are not compatible with each other if one file were bound
by both. That is the reason the source of every target is recorded: a row backed by `vr` or `loc` is the act's
fact and carries neither licence; a row backed only by `wp` is CC BY-SA 4.0 material and one backed only by
`osm` is ODbL material; rows with both codes are facts that both projects state. A consumer who must keep
the two apart can filter on `s` (drop `osm` for CC BY-SA use, drop `wp` for ODbL use).
Option «b» of the design (publish only `vr`/`loc`/`cad`/`man` rows) is a filter on that field and loses most
of Kyiv, Dnipro and Odesa.

## What the app must show

The licences ask for attribution where the data is used. Svitlo's «Про застосунок» should say: «Колишні назви
вулиць: Вікіпедія (CC BY-SA 4.0), © OpenStreetMap contributors (ODbL), акти Верховної Ради та міських рад.» That
line is a task for the app's next release; the files carry the codes it needs.
