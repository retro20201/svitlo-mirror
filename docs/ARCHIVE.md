# «Архів»: the days that are over

`tools/mirror/lib/archive.mjs` puts every finished day away, per region:

    v1/archive/<region>/<YYYY-MM-DD>.json   the region file narrowed to that day, in its last form before Kyiv midnight
    v1/archive/<region>/index.json          { "days": ["2026-11-14", …] } — the days there are, oldest first

A day's file has the shape of `v1/<region>.json` (`fact.data` holds that one day, `fact.today` is it, `preset` names the
queues), so the app reads it with the code it reads today with. Beside it, under `archive`: the `date`, `emergency` (the
operator declared emergency outages for that day at some point of it) and `withdrawn` (the day had a table and the operator
took it down before the day ended; the file holds the last one seen).

A day with no table published makes no file. «No file» means «nothing known», not «no outages».

## Why

The mirror holds today and tomorrow only. A phone knows a past day only if it was opened on it, so «Статистика» of a new
address starts from nothing and a week away leaves a week's hole. The archive begins on the day it is switched on: nothing
can be read back from before that.

## How it runs

* Every cycle the running day's table is noted in `<state>/archive/open/<region>.json`. Nothing is published while the day
  runs — the region file is the day's live copy.
* The first cycle after Kyiv midnight finds the note a day old and writes that day's file into `<state>/archive/v1/`, the
  store outside the tree (the tree is cleaned every cycle).
* Each cycle lays the last three days and every index into the tree; the fast deploy carries them (`regionFiles`) and leaves
  the rest of the live site as it is. A day offered again costs nothing: Firebase stores a file by its hash.
* Before a **full** deploy `vps/run.sh` copies the whole store into the tree — a full deploy publishes the tree and nothing
  else. If GitHub publishes while this server is away the archive leaves the site; the server's next cycle sees that live is
  not its own release, deploys in full, and the archive is back.
* Kept for 400 days.

## Switching on

Off by default. On the server: `touch /var/lib/svitlo-mirror/archive-on` (off: `rm` — the store stays, nothing new is put
away). `firebase.json` has a header rule for `/v1/archive/**` (an hour's cache, CORS), so the first cycle after this is
merged deploys in full once.
