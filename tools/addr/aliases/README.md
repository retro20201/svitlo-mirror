# Aliases: old street and settlement names

Raw material for `aliases.json`, the files that let the app find «вул. Горького» when the operator
lists only its current name. The design is in the research workflow's report; this folder holds the
pipeline, one stage at a time. Only the **fetch** stage exists so far.

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
  executed or imported; the verifier reads a PDF through PDFKit (`pdf-text.swift`) and a DOCX as a zip.
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
    `/api/status` first, waits, retries, and only then tries a public mirror. Kyiv is Phase 2 and is not fetched.
  - `bc-rada.gov.ua` now serves a placeholder; `fetch-wayback.mjs` takes the newest Wayback capture
    that really is the rename table (its `id_` form: the page as the council served it).

## Sources and licences

| folder | source | licence |
|---|---|---|
| `rada` | 12 acts of the Верховна Рада on zakon.rada.gov.ua | official acts; understood not to be objects of copyright (Copyright Act art. 10) |
| `wikipedia-kyiv`, `wikipedia-uk-other` | uk.wikipedia.org, 43 pages | CC BY-SA 4.0, © Wikipedia contributors; the revision id of every page is in `manifest.json` |
| `wikipedia-ru-odesa` | ru.wikipedia.org, «Список улиц Одессы» | CC BY-SA 4.0, © Wikipedia contributors |
| `osm` | OpenStreetMap through Overpass, 21 towns | ODbL 1.0, © OpenStreetMap contributors |
| `odesa-oda`, `boryspil`, `brovary`, `bucha`, `khmelnytskyi`, `bila-tserkva` | council and ODA decisions | local-government acts; no site licence stated |
| `rename-dp` | rename.dp.ua | **none stated — cross-check only; no published row may rest on it alone** |

Anything published from these must carry the source code of every row (`wp`, `osm`, `vr`, `loc`, …)
and credit Wikipedia (CC BY-SA 4.0) and OpenStreetMap (ODbL) in the data's LICENCE note and in the
README. That note belongs to the build stage, which does not exist yet.

## Tests

    node --test tools/addr/aliases/*.test.mjs

Offline: a local HTTP server and fixtures, no request leaves the machine.
