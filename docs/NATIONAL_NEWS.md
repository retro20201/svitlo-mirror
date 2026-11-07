# «Новини України»

`tools/mirror/lib/national-news.mjs` reads the public RSS feeds of a few Ukrainian news outlets and writes one file for the whole
country, `firebase/public/v1/news-ua.json`:

    { "items": [ { "id": "ukrinform//rubric-ato/4182307-…", "at": "2026-11-07T04:33:00.000Z", "title": "…", "excerpt": "…",
                   "url": "https://www.ukrinform.ua/rubric-ato/4182307-….html", "source": "Укрінформ" } ] }

Same shape as `news-<region>.json` ([OPERATOR_NEWS.md](OPERATOR_NEWS.md)) plus `source`, the outlet's name, which the app prints
under every headline.

## What is taken, and what is not

Only what an RSS feed is published for: `title`, `description`, `link`, `pubDate` (and `category`, to filter). **Never**
`content:encoded` / `fulltxt` (the story itself), never a picture. The reader who wants the story opens it on the outlet's own
site; the headline links there and the outlet's name stands beside it.

* newest first, at most 30 in all, at most 12 from one outlet, at most two days old;
* a link must be `https` and lead to the outlet's own host — an advertisement or a redirect in a feed is not passed on;
* «партнерський матеріал», «на правах реклами» and the like are dropped; a story told twice in the same words is kept once;
* УНІАН mixes quizzes and horoscopes into its feed, so only its news categories pass (`allow` in `NATIONAL_SOURCES`).

Outlets today: Укрінформ, Українська правда, УНІАН. Суспільне answers 403 to the server's user agent and is not used.

A feed that cannot be read is left out of that file and the others still go out; when none can be read nothing is written and the
file already served stays.

## Switching on

Off by default. On the server: `touch /var/lib/svitlo-mirror/national-news-on` (off: `rm`). `run.sh` then exports
`SVITLO_NATIONAL_NEWS=1`. The feeds are read on the slow turn only (about every five and a half minutes), not every cycle. The file
is a top-level `v1/*.json`, so the fast deploy carries it; no `firebase.json` change.

A new outlet is one more entry in `NATIONAL_SOURCES` (`id`, `name`, `url`, `hosts`, optional `allow`) — read its feed's terms first.
