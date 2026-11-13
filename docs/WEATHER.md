# Погода

The line at the top of «Сьогодні» in the app: `Пт, 13 листопада · ☁ +6° · хмарно`. One file for the whole country, `v1/weather.json`:

```json
{ "updatedAt": "2026-11-13T19:27:45.174Z",
  "regions": { "kyiv": { "t": 6, "sky": "cloudy", "night": false, "at": "2026-11-13T19:27:45.174Z" } } }
```

`t` is the whole degrees, `sky` is one of `clear partly cloudy fog rain sleet snow thunder`, `night` is for the moon, `at` is when that
region was read. The words and icons are the app's (uk, ru, en). A region that is not in the file has no weather line.

## Source

The Norwegian Meteorological Institute's open forecast, `api.met.no/weatherapi/locationforecast/2.0/compact` (Yr). No key; free for
commercial use under CC BY 4.0 / NLOD **with the source named** (the app prints «Yr / Норвезький метеоінститут» in «Про застосунок»).
Its terms ask for an identifying user agent (the mirror's), a server making the requests rather than every phone, no more than two
decimals of a place's coordinates, and no reading of a place more often than the answer's `Expires` (about half an hour).

So: `lib/weather.mjs` asks once per region's main city (`PLACES`, 24 of them — Луганська, Донецька and Крим have no feed), only when the file
is older than 30 minutes (`RENEW_AFTER_MS`), on the slow turn. The phones never call the source; no coordinates or addresses of theirs are
sent to anyone — the weather is the region's city's.

A region that cannot be read keeps its last reading for 3 hours (`KEEP_MS`) and then drops out of the file. When nothing can be read,
nothing is written.

## Switching on

Off by default. On the server: `touch /var/lib/svitlo-mirror/weather-on` (off: `rm`). `run.sh` then exports `SVITLO_WEATHER=1`.
The app (from 1.15) reads the file and shows nothing when it is missing (404) or old (over 3 hours).

Tests: `node --test tools/mirror/weather.test.mjs`.
