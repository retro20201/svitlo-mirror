# «Новини оператора»

`tools/mirror/lib/operator-posts.mjs` reads the operators' own public Telegram channels (the pages `lib/telegram.mjs` describes —
no extra requests: `pageOf` keeps a page for a minute) and writes `firebase/public/v1/news-<region>.json`:

    { "items": [ { "id": "SumyEnergo/3849", "at": "2026-11-05T14:51:00.000Z", "title": "…", "excerpt": "…", "url": "https://t.me/SumyEnergo/3849" } ] }

* newest first, at most 12, at most a week old;
* only posts about the power (`isAboutPower`): memorials, fire-safety leaflets and a day's table are left out;
* a headline (first sentence, ≤110 chars) and an excerpt (≤220 chars) — never the whole post; `url` is the post itself;
* ДТЕК's one channel (`dtek_ua`) is shared by Київ, Київщина, Дніпро and Одещина: a post goes to the place it opens with.

A channel that cannot be read leaves the region's last good file alone.

## Switching on

Off by default. On the server: `touch /var/lib/svitlo-mirror/news-on` (off: `rm`). `run.sh` then exports `SVITLO_OPERATOR_NEWS=1`.
The files are top-level `v1/*.json`, so the fast deploy carries them; no `firebase.json` change.

Regions with no channel here (Одеса apart, via ДТЕК) have no file: the app shows the section as empty for them.
