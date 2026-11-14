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

## Вінниччина: the operator's site instead of a channel

АТ «Вінницяобленерго» has no public Telegram channel, so `lib/voe-news.mjs` reads the first page of `www.voe.com.ua/news` and
writes `news-vinnytsia.json` in the same shape. Its daily cards «Введення ГПВ» / «Зміни по ГПВ» become headlines with the day
and the hours in them («Введення ГПВ: 14.11 з 06:00 до 24:00»); «ГОП» (limits for businesses) and what is not about the power
are left out. It matters more here than elsewhere: the черги's hours are behind the operator's address search, which turns this
server away, so this line is the only thing the app can say about a day's outages in the region.

* Under the same switch (`news-on`). The site is asked on the slow turn only — one page in five and a half minutes — with the
  mirror's own user agent; it answers a Ukrainian address only, so this runs from the Kyiv server.
* The list dates a card by the day, so `at` is when the card was first seen, kept inside that day; a card already served keeps
  its `at`. Between turns, and when the site cannot be read, the served feed is put back unchanged.
* A page that answers without cards is treated as not read (a changed layout or a challenge page), never as an empty feed.
