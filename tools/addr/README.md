# Address → черга dictionary

Lets the app work out a user's queue from their address instead of asking them to know it.
Every competitor (including the category leader, «Світло», 3.2k ratings) makes the user pick a
region and a черга by hand.

## Why it needs a browser

ДТЕК sits behind an Imperva Incapsula WAF. A plain `fetch` gets a 212-byte JS challenge and no
combination of headers gets past it. Rather than add Playwright — this repo has no dependencies,
and `sources/dtek.mjs` deliberately avoids running its own headless fleet — `chrome.mjs` drives the
already-installed Chrome over the DevTools Protocol using Node's built-in WebSocket. Nothing from npm.

This is **not** part of the 10-minute mirror. The mapping changes about as often as the grid is
re-segmented, so it is a manual or monthly job whose output is committed.

## Endpoints

    POST /ua/ajax  method=getStreets
      city  (kyiv)        -> ["вул. Абрикосова", …]
      oblast             -> {"м. Ізмаїл": ["вул. …", …], …}

    POST /ua/ajax  method=getHomeNum
      city    data[0][name]=street & data[0][value]=<street>
      oblast  data[0][name]=city   & data[0][value]=<settlement>
              data[1][name]=street & data[1][value]=<street>
      -> {"<house>": {sub_type_reason: ["GPV19.1"], …}, …}

One request per **street**, not per address. Works out of season, before any schedule is published.

`sub_type_reason` is a **list**: a building fed by several lines gets one черга per line. In the
Kyiv harvest of 2026-10-01, 6 208 of 50 206 houses (12.4 %, on 449 of 2670 streets) have two or
more, up to four; the oblasts' shares go here once their re-harvests finish. Yasno's own FAQ says
one address can show two schedules, and which line feeds a given flat is known to the ОСББ or
керуюча компанія. A lettered or corpus building is often on a different group from the bare
number (`14` → 51.1 but `14/2` → 3.1 — 2417 such pairs in Kyiv), which is why the app matches house
numbers exactly first.

## Running

    node tools/addr/build-addresses.mjs --region=kyiv
    node tools/addr/build-addresses.mjs --region=odesa        # ~100 min
    node tools/addr/build-addresses.mjs --region=dnipro
    node tools/addr/build-addresses.mjs --region=kyiv-region

Run it from the repo root — the paths are relative. `--limit=N` for a smoke test, `--headful` to watch.
The first progress line only appears after Chrome's cold start (up to ~90 s); that is not a hang. Resumable: existing street files are skipped,
so an interrupted run just carries on.

Because existing files are skipped, a plain run never refreshes a region that is already built.
To re-harvest one, add `--fresh`: it builds into `v1/addr/<region>.new/` and swaps it into place
only once every listed street is in `.new/` — fetched, or, for a name the operator no longer lists,
copied from the last harvest — leaving the replaced copy at `<region>.old/` until someone has
checked the new one. A re-harvest that dies half-way never touches the published region.

`.new/` is resumable, but only by the run that started it: `.harvest.json` inside it records when
that was, whether it was a `--limit` smoke test, and which published lists it was built on. A
`.new/` with no record, a smoke test's under a full run, one more than a day old, or one whose
published lists have changed since is refused — resuming it would swap in streets from two
harvests as one. Delete it to start clean, or pass `--resume` to keep it anyway. Before swapping,
the run also refuses a `.new/` in which many streets that had houses came back empty: ДТЕК answers
some errors with HTTP 200 and `{"result": false}`, and a run that started getting those part-way
would otherwise replace a good region with an empty one (`--allow-emptied` if it really is so).
`.gitignore` and the Hosting `ignore` list in `firebase.json` keep `<region>.new/` and
`<region>.old/` out of commits and deploys, though both sit under `firebase/public`.

    node tools/addr/build-khmelnytskyi.mjs                    # Хмельницька, from the operator's XLSX
    node tools/addr/build-khmelnytskyi.mjs --only Шепетівський   # check one РЕМ, into a temp dir
    node tools/addr/build-khmelnytskyi.mjs --verify           # ~20 requests to their address API
    node tools/addr/write-index.mjs                           # after any build above

Хмельницькобленерго publishes the mapping as one spreadsheet per РЕМ, named with the date the
черги take effect (`…_РЕМ_побут_01102026.xlsx`). The builder asks which dates exist and takes the
newest per РЕМ, so it picks up a new quarter's set by itself. On 2026-10-01 `hoe.com.ua` refused
every connection from two different networks outside Ukraine — most likely a geo-block — so if it
times out, run it from a Ukrainian connection. `--only` is a check, not a build: it writes to a
fresh temp dir and prints where. Merged over the published region, one РЕМ's file would replace the
houses of every street it shares with another РЕМ by its own and publish the houses a full run
withholds because two РЕМ disagree — so a newly published РЕМ is added by a full run.
`write-index.mjs` only reads what is on disk; it ignores `<region>.new/` and `<region>.old/`.

## Output

    v1/addr/kyiv/streets.json          ["вул. Абрикосова", …]      index i -> s/<i>.json
    v1/addr/kyiv/s/<i>.json            {"12": "GPV19.1", …}

    v1/addr/odesa/settlements.json     ["Авангардівська ТГ", …]    index c -> c/<c>/
    v1/addr/odesa/c/<c>/streets.json   ["вул. …", …]               index s -> c/<c>/s/<s>.json
    v1/addr/odesa/c/<c>/s/<s>.json     {"1": "GPV2.2", …}

    v1/addr/kyiv/x/<i>.json            {"95": ["GPV5.1", "GPV3.1"], …}
    v1/addr/odesa/c/<c>/x/<s>.json     {"4": ["GPV1.1", "GPV1.2"], …}

    v1/addr/index.json                 {"kyiv": {"shape": "flat", "streets": 2670, "built": 2670,
                                                 "addresses": 50206, "lines": true, "multiLine": 6208}, …}

One small file per street keeps the phone's onboarding download at ~1 KB instead of megabytes.

### Several lines per house: `x/`

`s/<i>.json` is exactly what app 1.0.2 decodes, `[String: String]`, and must stay that shape: one
черга per house, the **first** line the operator gives. Every line goes to `x/<i>.json`, a sibling
of `s/`, in the operator's order — and only for houses with two or more, and only for streets that
have such a house. A 404 on `x/<i>.json` means "nobody on this street has a second line".

Хмельницька is the exception in one direction: a house the operator lists under two черги is
published in `x/` **only**, not in `s/`. Its spreadsheet gives no order between the two, so there
is no "first" line, and 1.0.2 keeps saying "not found" for it — what it said when these houses
were withheld — instead of presenting one of the two schedules as the whole answer. A house two
different РЕМ files put on different черги is still withheld: that is most likely two villages of
the same name, not one building on two lines.

### `index.json`

Written by `write-index.mjs`, one entry per region: `shape`, `streets`, `built` (streets with an
`s/` file), `addresses` (houses across `s/`) and, for nested regions, `settlements`. A region with
any `x/` file also gets `"lines": true` and `"multiLine"`, the number of houses across its `x/`
files. The app requests `x/` only where `lines` is true; without it, no extra request per street.
A region without `x/` has exactly the entry it had before these fields existed.

### Indices are permanent

The phone addresses settlements and streets by their **index** in the published list and caches
the list for a day. If a rebuild reordered it — the operator adds a street and everything after it
shifts — a cached list paired with a fresh `s/<i>.json` would show another street's houses, in
every app version already installed. So both builders keep the previous list as it is, append new
names at the end, and leave a name the operator no longer lists in its slot. A list is in
alphabetical (or the operator's) order only until its first rebuild; after that only its tail
grows, so a rebuilt `streets.json` should only ever differ from git at the end.

The slot keeps its index, not necessarily its houses. `build-khmelnytskyi.mjs` empties it — `{}` in
`s/`, no `x/` — for a street and for every street of a village the operator no longer lists: each
quarter's files replace the last, the old черги may have been redrawn, and "not found" sends the
person to pick their черга by hand rather than presenting last quarter's as theirs. A published
list that does not parse stops that builder instead of being rebuilt in a new order; restore it
from git.

`build-addresses.mjs` does the opposite on purpose: a street ДТЕК does not list right now keeps its
last `s/` and `x/`. ДТЕК's street list flickers — on 2026-10-01 Kyiv's gave 2667 names at 09:07
and 2674 at 11:00, two of the "missing" three back — so a name absent from one harvest is far more
often a blip than a rename, while houses rarely change group (0 of 50 177 Kyiv houses did between
2026-09-07 and 2026-10-01). Emptying it would turn a real street into "not found" until the next
harvest. Хмельницькобленерго's quarterly file sets are not a flickering list, hence the difference.

## Status

| region | settlements | streets | addresses | state |
|---|---|---|---|---|
| kyiv | — | 2670 | 50 206 | **re-harvested 2026-10-01** with `x/`: 6 208 houses (12.4 %) on 2–4 lines, 6 169 of them on lines with different schedules; first lines unchanged for every house since 2026-09-07 |
| odesa | 939 | 14 311 | 381 863 | **re-harvested 2026-10-01** with `x/`: 13 973 houses (3.7 %) on several lines; 120 streets ДТЕК did not list that day kept from the last harvest |
| dnipro | 1149 | 18 273 | 472 195 | **re-harvest in progress 2026-10-01**; previous harvest |
| kyiv-region | 1190 | 25 364 | 628 600 | **re-harvest in progress 2026-10-01**; previous harvest |
| khmelnytskyi | 135 | 3050 | 61 437 | 01.07.2026 set, Хмельницький РЕМ only (built 2026-09-20). The 01.10.2026 rebuild is pending: `hoe.com.ua` refused every connection on 2026-10-01 |

## Publishing

The dictionary is ~17 900 files but only **6 MB of actual content** — `du` reports ~70 MB because
17 000 files of ~175 bytes each take a whole filesystem block. Firebase counts bytes, so this is
nowhere near the 10 GB storage limit, and Hosting documents no limit on file count.

`v1/addr/**` is served with `max-age=86400` (the schedules keep their 300 s). The schedule rule
`/v1/*.json` does **not** cover these — a `*` glob does not cross `/` — which is why they need
their own rule.

### Today: one site

`firebase deploy --only hosting` publishes `firebase/public` whole; Hosting has no partial deploy.
So the dictionary rides along with the schedule deploy. That deploy is conditional
(`if: steps.mirror.outputs.changed == 'true'`), so it runs a few times a day rather than every ten
minutes, and the extra hashing is tolerable — but it is still weight on the one deploy that pushes
are sequenced behind.

### After moving to Blaze: split it out

Multi-site Hosting needs the Blaze plan. Once on it:

1. `firebase hosting:sites:create koly-svitlo-addr`
2. `firebase target:apply hosting main koly-svitlo` and `firebase target:apply hosting addr koly-svitlo-addr`
3. Split `firebase.json` into two hosting entries — `main` serving a public dir without `v1/addr`,
   `addr` serving the dictionary — and keep the header rules with their own site.
4. Mirror workflow deploys `--only hosting:main`; the dictionary is deployed by hand or by a
   monthly job with `--only hosting:addr`.
5. Point `RemoteAddressQueueLookup.baseURL` in the app at the new host.

Step 5 is an App Store release, so do it in the same version that ships address lookup rather than
switching hosts under a shipped build.

