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

So: `lib/weather.mjs` asks once per region's main city (`PLACES`, 24 of them — Луганська, Донецька and Крим have no feed), at most once in
30 minutes (`RENEW_AFTER_MS`). The phones never call the source; no coordinates or addresses of theirs are sent to anyone — the weather is the
region's city's.

A region that cannot be read keeps its last reading for 3 hours (`KEEP_MS`) and then drops out of the file. When nothing can be read,
nothing is written.

## On the server

The checkout is cleaned at the start of every cycle (`vps/run.sh`), so `publishWeather` runs on every cycle and starts from the file the
site is serving: it fetches `koly-svitlo.web.app/v1/weather.json` and puts it back into the tree as it is, so that the cycle's deploy — the
fast one or a full `firebase deploy` — carries it. A served copy that cannot be read (anything but a 200 or a 404) means the cycle does
nothing about the weather, rather than ask the source on a guess.

The half hour is counted two ways: by the file's own `updatedAt`, and by when the source was last asked, kept in
`/var/lib/svitlo-mirror/weather-asked-at` (`WEATHER_STATE_FILE`). The second is what keeps a source that is down — or is turning this
server away — from being asked again every two minutes.

GitHub's fallback (`.github/workflows/mirror.yml`) does not publish the weather: while it is the one deploying, the file is off the site,
and the app keeps the reading it has until that is three hours old.

## Switching on

Off by default. On the server: `touch /var/lib/svitlo-mirror/weather-on` (off: `rm`). `run.sh` then exports `SVITLO_WEATHER=1`.
Switched off, the file already on the site stays there and grows old; the app shows no reading older than 3 hours, so the line goes by
itself. The app (the version after 1.14) reads the file and shows nothing when it is missing (404) or old.

Tests: `node --test tools/mirror/weather.test.mjs`.
