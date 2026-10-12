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
| `n` | length of that list when built; every target `i < n` (the gate checks it) |
| `built` | ISO date |
| `cities` | region file only: the `c` that have a `c/<c>/aliases.json` |
| `src` | legend for the source codes below, only the codes the file uses |
| `a[].k` | the OTHER name as a person writes it, without the type word |
| `a[].ty` | its type in the operator's abbreviation (`вул.`, `просп.`, `бул.`, `пров.`, `пл.`, `м.`, `смт`, `с.` …) |
| `a[].ru` | Russian forms the app's ending fold would NOT derive (Красноармейская, Ильичёвск) |
| `a[].is` | `current`: `k` is the current name and the operator still lists the old one (reverse direction) |
| `a[].sure` | the evidence supports auto-picking (see below) |
| `a[].t[]` | targets, 1 to 12, sorted by houses: `i` row index (permanent), `d` district / old raion, `y` year, `h` houses (a ranking hint), `f` flags, `s` source codes |
| flags | `part` (only a section renamed), `merge` (the new street took several old ones), `twin` (another operator row reads the same), `both` (the operator ALSO lists the old name), `retype` (the kind changed) |

The file says what the evidence supports; the app decides what the query supports. A key with several
targets lists every one with its district (`d`; when a source gives no place the target says
«місце не вказано»). `sure` is set only when ALL hold: one target, no flag on it, an official source
(`vr`, `loc`, `cad`) or Wikipedia and OpenStreetMap together, an exact join (not a short form), the key
is not the current name of a row of the same kind, **and the sources do not give the same old name to
another street, listed or not** (this last condition is stricter than the design).

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
    node tools/addr/check-aliases.mjs               # exit 1 blocks publishing
    node --test $(find tools -name '*.test.mjs')    # what CI runs

`build-aliases.mjs` never writes a list, `s/` or `x/` file: it hashes all of them before and after and
stops if one changed. Rerun it after `build-addresses.mjs --fresh` swaps a region (a new operator row can
turn a reverse entry into a forward one), and monthly after re-fetching Wikipedia and OSM and looking
for new Rada acts. It is not part of the 10-minute mirror.

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
4. Corner records («ріг …»), garden societies, district-prefixed rows and rows without a type are never targets.

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
    node tools/addr/aliases/fetch-osm.mjs                 $RAW/osm
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

Attribution and the licence posture for the published data are in [LICENCE.md](LICENCE.md); the codes of every
target are in the files (`s`), their legend in `src`.

## Tests

    node --test tools/addr/aliases/*.test.mjs tools/addr/aliases.test.mjs tools/addr/aliases-published.test.mjs

Offline: a local HTTP server and fixtures for the fetchers, excerpts shaped like the real pages for the
parsers (`parsers.test.mjs`), invented lists for the join and the gate (`aliases.test.mjs`), and the
committed files for the golden cases and the audit's corpus (`aliases-published.test.mjs`). The corpus replay
uses a JS port of the app's word folding (`fold.mjs`); the final authority is the app's XCTest over fixture
copies of the files.
