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

## Running

    node tools/addr/build-addresses.mjs --region=kyiv
    node tools/addr/build-addresses.mjs --region=odesa        # ~100 min
    node tools/addr/build-addresses.mjs --region=dnipro
    node tools/addr/build-addresses.mjs --region=kyiv-region

Run it from the repo root — the paths are relative. `--limit=N` for a smoke test, `--headful` to watch.
The first progress line only appears after Chrome's cold start (up to ~90 s); that is not a hang. Resumable: existing street files are skipped,
so an interrupted run just carries on.

## Output

    v1/addr/kyiv/streets.json          ["вул. Абрикосова", …]      index i -> s/<i>.json
    v1/addr/kyiv/s/<i>.json            {"12": "GPV19.1", …}

    v1/addr/odesa/settlements.json     ["Авангардівська ТГ", …]    index c -> c/<c>/
    v1/addr/odesa/c/<c>/streets.json   ["вул. …", …]               index s -> c/<c>/s/<s>.json
    v1/addr/odesa/c/<c>/s/<s>.json     {"1": "GPV2.2", …}

One small file per street keeps the phone's onboarding download at ~1 KB instead of megabytes.

## Status

| region | settlements | streets | addresses | state |
|---|---|---|---|---|
| kyiv | — | 2670 | 50 177 | **complete** (60 queues, 0.7 MB) |
| odesa | 939 | 14 308 | — | not built |
| dnipro | 1141 | — | — | not built |
| kyiv-region | — | — | — | not built |

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

