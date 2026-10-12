# Aliases: old and former names of streets and settlements

The operator's lists carry one name per street, the one on its map. People type the name they grew up
with: «Червоноармійська» for вул. Велика Васильківська, «Днепропетровск» for м. Дніпро. This folder
builds `aliases.json`, the files that let the app find the street by the other name.

    v1/addr/kyiv/aliases.json                next to kyiv/streets.json                list = "streets"
    v1/addr/<region>/aliases.json            next to <region>/settlements.json        list = "settlements" (+ "cities")
    v1/addr/<region>/c/<c>/aliases.json      next to <region>/c/<c>/streets.json      list = "streets"

A 404 means "no aliases", the same convention as `x/`. Old app versions never ask for the files. The
app (Svitlo, branch fix/address-search, `AddressAliases.swift`) reads them with a decoder that drops a
bad entry on its own and treats anything it does not know as «doubtful», never as «sure».

## The file

    {"v":1,"list":"streets","n":2670,"built":"2026-10-12","cities":[…],"src":{"wp":"…"},
    "a":[
    {"k":"Горького","ty":"вул.","t":[{"i":254,"d":"Голосіївський, Печерський","y":2015,"h":125,"s":["wp"]}, …]},
    {"k":"Українських Героїв","ty":"пл.","is":"current","t":[{"i":2100,"s":["wp"]}]}
    ]}

| key | meaning |
|---|---|
| `v` | schema version, 1. An app that knows less ignores the file |
| `list` | `streets` or `settlements`: which list the target indices point into |
| `n` | length of that list when built; every target `i < n`. A list only grows, so `n` below the list's length means the file is stale (run `build-aliases`), not wrong |
| `built` | ISO date |
| `cities` | region file only: the `c` that have a `c/<c>/aliases.json` |
| `src` | legend for the source codes below, only the codes the file uses |
| `a[].k` | the OTHER name as a person writes it, without the type word |
| `a[].ty` | its type in the operator's abbreviation (`вул.`, `просп.`, `бул.`, `пров.`, `пл.`, `м.`, `смт`, `с.` …) |
| `a[].ru` | Russian forms the app's ending fold would NOT derive (Красноармейская, Ильичёвск) |
| `a[].is` | `current`: `k` is the current name and the operator still lists the old one (reverse direction) |
| `a[].sure` | the evidence supports auto-picking (see below) |
| `a[].t[]` | targets, 1 to 12, sorted by houses then index: `i` row index (permanent), `d` where it is (see below), `y` year, `h` houses (a ranking hint), `f` flags, `s` source codes |
| flags | `part` (only a section renamed), `merge` (the new street took several old ones), `twin` (another operator row reads the same), `both` (the operator ALSO lists the old name), `retype` (the kind changed) |

The file says what the evidence supports; the app decides what the query supports. A key with several
targets lists every one of them. `d` says where a target is: the district of the best source that gives one
(never rename.dp.ua), cleaned of the editors' misspellings and of cells that hold a street, not a district; or,
for a row the operator itself qualifies («вул. Нижній Вал (Бортничі)»), that qualifier. **When no source says,
`d` is left out**; the app shows the title and the year and prints nothing in its place (the design asked for `d`
on every target of a multi-target entry, which made the builder write «місце не вказано», and the app prints `d`
verbatim).

`sure` is set only when ALL hold (all of them are stricter than the design, after the review of 2026-10-12):

- one target, no flag on it, an exact join (T1 or T3: not a short form, not another kind, not a bare name), and the
  key has a kind;
- **every hop of the rename is proved**: an official source (`vr`, `loc`, `cad`) or Wikipedia and OpenStreetMap
  together. A name renamed twice is two hops, and the evidence of one does not carry the other; a hop that only
  corrects a spelling («Короленко» → «Короленка») is neither evidence nor a refusal;
- the key is **not the name of any row of the operator's list, of any kind** (a village «Володарка» next to a town
  «Володарка»), not a longer or shorter spelling of one (`Лумумби` / `Лумумби Патріса`), and not a current name in the
  council's own list (the `census` rows of Khmelnytskyi's annex, which lists streets the operator does not);
- the sources do not give the same old name to another street, listed or not; and, for a current-name entry
  (`is: current`), no other name the sources give the operator's old row is missing from the operator's list (four
  villages were «Перше Травня»; with two of the new names still unlisted, neither is sure);
- the pair is not half of a swap or a revert the dates cannot order (`пл. Незалежності` ↔ `пл. Дерев'янка`, both 2012);
- for a village, no other old name from another district ends on the same row.

`build-report/blockers.tsv` lists, for every entry that is not sure, each rule that stopped it.

## The pipeline

    fetch-*.mjs      raw downloads into a NEW folder outside every git checkout      (see below)
    parse-*.mjs      raw → sources/*.tsv, sorted, one renamed street per row, with its source and URL
    manual/*.tsv     hand-written: joins, vetoes, extra pairs, Russian vocabulary
    build-aliases    sources + manual + the lists on disk → every aliases.json  (tools/addr/build-aliases.mjs)
    check-aliases    the publish gate                                           (tools/addr/check-aliases.mjs)
    write-index      index.json gets "aliases": true and "aliasKeys" per region (tools/addr/write-index.mjs)

    RAW=~/scratch/aliases/raw                       # the fetchers' output, one folder per source
    node tools/addr/aliases/parse-all.mjs $RAW      # rewrites sources/*.tsv: a refresh is a git diff to review
    node tools/addr/build-aliases.mjs               # writes the aliases.json files and index.json
    node tools/addr/check-aliases.mjs               # STRICT: exit 1 blocks publishing; rebuilds in memory and compares
    node --test $(find tools -name '*.test.mjs')    # what CI and the mirror's server run before every publish

`build-aliases.mjs` never writes a list, `s/` or `x/` file: it hashes all of them before and after and
stops if one changed. Rerun it after `build-addresses.mjs --fresh` swaps a region (a new operator row can
turn a reverse entry into a forward one), and monthly after re-fetching Wikipedia and OSM and looking
for new Rada acts. It is not part of the 10-minute mirror.

**Two modes of the gate.** `check-aliases.mjs` is strict by default: `n` equal to the list's length, `h` equal to the
houses on disk, and every file byte-for-byte what `build-aliases` writes now from the committed sources and lists (so a
veto that was not rebuilt, or a harvest that grew a list, is caught). The test suite that CI and the mirror's server
run before **every publish of the schedules** uses the lenient mode (`strict: false`, or `--lenient`): a harvest that
appends one street must never stop the schedule mirror, it only means `build-aliases` is due. `ALIASES_STRICT=1 node --test
tools/addr/aliases-published.test.mjs` runs the strict check as a test. Permanence (every target still names the row it
named) is checked against HEAD and, when the checkout has it, `origin/main`: the commit that holds the files proves nothing.

### Joining, in short (`aliases/build-core.mjs`)

1. Names are compared as **token sets** (lower case, Ґ→Г, Ё→Е, no apostrophes, «2-й» as 2, «ІІІ» as 3):
   «Бандери Степана» is «Степана Бандери». The display spelling is kept.
2. The source row's **new** name is joined to the operator's rows of the right list: **T1** same kind and
   same words (rows with the same key are ONE street, all targets, `twin`); **T2** a short form («Леонтовича»
   for «Миколи Леонтовича», extra words only first names or titles), only when exactly one street fits, never
   `sure`; **T3** `manual/joins.tsv`. Another kind with the same name is accepted only when it is the only
   candidate (`retype`). A short spelling next to a long one in the operator's list («вул. Гоголя»,
   «вул. Гоголя Миколи») are both targets. A name renamed twice follows the chain to the row the operator lists.
3. New name listed → a forward entry (key = old name). Only the old name listed → a reverse entry (`is: current`).
   Neither → nothing published, a line in `build-report/unmatched.tsv`.
4. Corner records («ріг …»), garden societies (also a society named in a row's brackets, «вул. Центральна (СТ Дружба)»),
   district-prefixed rows and rows without a type are never targets. A row the operator qualifies with a district
   («вул. Весняна (Голосіївський р-н.)») is ruled out when the source puts the rename in another district.
5. **A decision undone by a later one is replaced.** On 26.07.2024 the Dnipro oblast administration renamed 20 streets
   and on 18.12.2024 the council gave their names back, so the sources hold both A→B and B→A. Each pair carries the date of
   its act (from the act's text, else its year); the later one is kept and the earlier is dropped as `superseded`. When
   the dates cannot order them, both stay and neither is sure.
6. A kind written after the old name («Дарницьке шосе», «Городній тупик») is the old thing's kind: the entry has no `ty`
   rather than the `вул.` of the street it became.

Policy: pairs whose rename year is before **1991** are dropped (`MIN_YEAR` in `build-core.mjs`); a pair that
only rename.dp.ua knows is never published; placeholder names (Нова, Проєктна NNN, «№ 4»), «(неоф.)» names and
non-Cyrillic keys never get in. Every source row ends up used or dropped with a named reason (the build refuses
to finish if the numbers do not add up), and unmatched pairs may not grow by more than 5 % between builds
(`baseline.json`; `--update-baseline` after looking).

### The tables you can edit

| file | for |
|---|---|
| `manual/joins.tsv` | `scope, side, type, name, title`: a source name that must join to this operator row |
| `manual/vetoes.tsv` | `scope, old_name, new_name`: a pair that is never published (empty new_name: every pair of that old name in the scope). A bad pair is removed by adding it here and rebuilding, with no app release |
| `manual/extra.tsv` | pairs written by hand, in the source columns (`src` becomes `man`) |
| `manual/ru.tsv` | `kind` word/name, `uk`, `ru`: the Soviet vocabulary and irregular names; a form the app derives is not stored |
| `corpus/rename-cases.tsv` | the audit's 103 renamed-name queries, six labels corrected (column `was`) |
| `sources/*.tsv` | generated by `parse-all.mjs`; do not edit |

### Reports (`build-report/`, git-ignored)

`unmatched.tsv` (no join), `ambiguous.tsv` (several streets fit), `dropped.tsv` (every dropped row and why),
`joined-short.tsv` (every T2 join, for a human to read), `namesakes.tsv` (aliases that are also a current
street), `counts.json`.

## Fetch

Seven fetchers, one folder per source, none of them in this repo:

    RAW=~/scratch/aliases/raw            # any NEW folder outside every git checkout
    node tools/addr/aliases/fetch-rada.mjs                $RAW/rada
    node tools/addr/aliases/fetch-wikipedia.mjs kyiv      $RAW/wikipedia-kyiv
    node tools/addr/aliases/fetch-wikipedia.mjs uk-other  $RAW/wikipedia-uk-other
    node tools/addr/aliases/fetch-wikipedia.mjs ru-odesa  $RAW/wikipedia-ru-odesa
    node tools/addr/aliases/fetch-osm.mjs                 $RAW/osm      # every town by its OSM boundary relation
    node tools/addr/aliases/fetch-wayback.mjs             $RAW/bila-tserkva
    node tools/addr/aliases/fetch-files.mjs odesa-oda     $RAW/odesa-oda
    node tools/addr/aliases/fetch-files.mjs boryspil      $RAW/boryspil
    node tools/addr/aliases/fetch-files.mjs brovary       $RAW/brovary
    node tools/addr/aliases/fetch-files.mjs bucha         $RAW/bucha
    node tools/addr/aliases/fetch-files.mjs khmelnytskyi  $RAW/khmelnytskyi
    node tools/addr/aliases/fetch-files.mjs rename-dp     $RAW/rename-dp
    node tools/addr/aliases/verify-raw.mjs $RAW           # what each folder holds; non-zero exit on a problem

Rules every fetcher follows (all in `http.mjs`):

- **The folder is an argument and must be new or empty.** It is refused inside any git checkout, so a
  raw dump can never land in `firebase/public` or be committed. `--resume` continues an interrupted
  run of the *same* source (it reads `manifest.json` and skips files whose SHA-256 still matches).
- **Downloads are untrusted data.** Files are written exactly as received and recorded in
  `manifest.json` (URL, final URL, status, bytes, SHA-256, time, attempts). Nothing fetched is ever
  executed or imported; the parsers only read them (a PDF through PDFKit, `pdf-layout.swift`; a DOCX as a zip).
- **One request at a time, a second or two apart**, a descriptive `User-Agent`
  (`Svitlo-aliases/1.0 (contact …)`), and back-off with `Retry-After` on 403/429/5xx. A `200` that is
  not the document (a challenge page, a truncated PDF, an Overpass answer with a `runtime error`
  remark) is a failed attempt, not a download.
- **Known host quirks**
  - `zakon.rada.gov.ua` resets Node's TLS handshake and any non-Chrome User-Agent on `/print`;
    `fetch-rada.mjs` sends a Chrome User-Agent through `curl` and still sees an occasional reset, hence
    the slow retries.
  - `oda.od.gov.ua` answers the descriptive User-Agent with 403; `fetch-files.mjs` then retries once with a
    browser-like one and the manifest records which was used.
  - OpenStreetMap is fetched **by boundary relation, never by rectangle**: the box round Dnipro also holds Яворницьке,
    Любимівка and Підгороднє, and the `old_name` ways of those villages joined, by name, to the city's list (the review of
    2026-10-12 found at least 218 such targets, 106 of them in Dnipro). Where OSM has no boundary of the city itself the
    territorial hromada (level 7) is used; `fetch-osm.mjs --list` prints the relation of each town and its header says
    which. A way that two towns' files both hold is published under neither.
  - Overpass (`overpass-api.de`) answers heavy queries with 504 about half the time; the fetcher checks
    `/api/status` first, waits, retries, and only then tries a public mirror, whose answer is refused if its
    OSM data is more than 3 days old (on 2026-10-12 `overpass.private.coffee` served Pavlohrad from May 2026
    and missed 64 of 242 ways; `--refetch=pavlohrad` replaces one city). Kyiv is Phase 2 and is not fetched.
  - `bc-rada.gov.ua` now serves a placeholder; `fetch-wayback.mjs` takes the newest Wayback capture
    that really is the rename table (its `id_` form: the page as the council served it).

## Sources, codes and licences

| code | folder in `$RAW` / table in `sources/` | source | licence |
|---|---|---|---|
| `vr` | `rada` / `rada.tsv` | 12 acts of the Верховна Рада on zakon.rada.gov.ua (settlements) | official acts; understood not to be objects of copyright (Copyright Act, art. 10) |
| `wp` | `wikipedia-kyiv`, `wikipedia-uk-other`, `wikipedia-ru-odesa` / `wikipedia-*.tsv` | uk.wikipedia (43 pages), ru.wikipedia «Список улиц Одессы» | **CC BY-SA 4.0**, © Wikipedia contributors; the revision (`oldid`) of every row is in its `url` |
| `osm` | `osm` / `osm.tsv` | OpenStreetMap `old_name*` tags through Overpass, 21 towns | **ODbL 1.0**, © OpenStreetMap contributors |
| `loc` | `odesa-oda`, `boryspil`, `brovary`, `bucha`, `khmelnytskyi`, `bila-tserkva` / `councils*.tsv` | decisions of councils and the Odesa regional administration | local-government acts; no site licence stated; not objects of copyright |
| `rdp` | `rename-dp` / `rename-dp.tsv` | rename.dp.ua | **none stated: a cross-check only; no published row may rest on it alone** |
| `man` | `manual/extra.tsv` | written by hand | — |

Two kinds of row in `sources/*.tsv` are not renames. A row with `flags` = `ruonly` gives only the Russian form of a pair another
source knows (ru.wikipedia for Odesa; an OSM way with a Russian-only `old_name`) and is attached to the Ukrainian entry of its own
town, or reported as `ru-without-pair`. A row with `flags` = `census` is a current name from a council's own list (all 1001
streets of Khmelnytskyi's annex 3, renamed or not): it is never published, it only withholds `sure` from a key that is somebody's
current name.

Attribution and the licence posture for the published data are in [LICENCE.md](LICENCE.md); the codes of every
target are in the files (`s`), their legend in `src`.

## Tests

    node --test tools/addr/aliases/*.test.mjs tools/addr/aliases.test.mjs tools/addr/aliases-published.test.mjs

Offline: a local HTTP server and fixtures for the fetchers, excerpts shaped like the real pages for the
parsers (`parsers.test.mjs`), invented lists for the join and the gate (`aliases.test.mjs`), and the
committed files for the golden cases and the audit's corpus (`aliases-published.test.mjs`). The corpus replay
uses a JS port of the app's word folding (`fold.mjs`); the final authority is the app's XCTest over fixture
copies of the files.
