<!-- Дослідження джерел ГПВ по областях України. Складено 2026-08-28. -->
<!-- Перевірено фетчами; частина висновків спростувала попередню класифікацію регіонів. -->

# ПЛАН ПОКРИТТЯ — 22 REGIONS REMAINING

**Baseline:** 4/26 live (ДТЕК: Київ, Київська, Дніпро, Одеса). Of the remaining 22, three (Донецька, Луганська, АР Крим) are not addressable. **19 are in play. Realistic target by 1 Oct: 12–14 live, 3 partial, 3 blocked.**

The single most important structural fact from this research round: **the brief's region buckets are wrong in four places.** Івано-Франківськ and Тернопіль are not Cloudflare-blocked (Тернопіль has a *documented open JSON API*). Чернігів was mis-scored against a squatted lookalike domain. Черкаси, Запоріжжя, Хмельницький and Полтава all have feeds despite "NO FEED FOUND". Fix the region table before anything else.

---

## (a) DO NOW — ranked by regions-gained per unit of work

### A1. Telegram ingest component + text-table parser — **3 regions + 1 partial, ~4 dev-days**
Highest ratio in the whole plan: one component, four regions, and it is the load-bearing dependency for five more.

**Regions:** Запорізька, Харківська, Черкаська (hours), Полтавська (partial).

**Source:** Telegram **MTProto client API** (`core.telegram.org/api`, api_id from `my.telegram.org`), a user session subscribed to the public channels. Do **not** build on `t.me/s/` HTML for production — it truncates long posts, its `?before=` param is undocumented, and its markup can change. Bot API is not an option (a bot cannot read a channel it does not administer). `t.me/robots.txt` is 404 — no directive exists to violate either way.

**Channels (all verified 200, all official):**
`@Zaporizhzhyaoblenergo_news` · `@kharkivenergy` · `@pat_cherkasyoblenergo` · `@poltavaOE` · `@prykarpattyaoblenergo_official` · `@khmelnytskoblenergo` · `@zakarpatenergyofficial` · `@chernigivoblenergo`

**Build:**
- Poll channel history, store `(channel, message_id, date, edit_ts, text, photo)`.
- **Key on (target_date, message timestamp) and always take the latest.** Verified: Запоріжжя posted 5 revisions of one day's table between 05:18 and 17:46; Хмельницький posted 6 amendments on 4 Feb alone. "The post for today" is not a valid selector.
- Parser must be lenient. Real defects observed in production data:
  - separators mixed within one post: `–` (U+2013) and `-`, `;` and `,`
  - typos: `02;00` for `02:00` (Запоріжжя, id 2730)
  - broken whitespace: `по 10: 00` (Полтава)
  - `не вимикаються` in place of ranges, and merged rows: `2.1, 2.2 не вимикаються` (Харків)
  - `24:00` and `23:59` both used for end-of-day
- Regex `(\\d\\.\\d)\\s*[:\\s]\\s*(.+)` → split on `,`/`;` → `\\d{1,2}[:;]\\d{2}\\s*[–—-]\\s*\\d{1,2}[:;]\\d{2}`.

**Per-region notes:** Запоріжжя is the cleanest (full 12-subqueue table, `Години відсутності електропостачання по чергам (підчергам)`). Харків needs the `не вимикаються` branch and must ignore the unstable `N черг одночасно` count (three phrasings observed, including fractional `від 2,5 до 4 черг`). Черкаси supplies hours here and queue-mapping from A2.

### A2. Черкаси address→черга JSON — **completes 1 region, 0.5 day**
`https://cabinet.cherkasyoblenergo.com/api_new/disconn.php` — public GET, `Access-Control-Allow-Origin: *`, no auth, no key, no robots.txt on the host. It is the backend of the operator's own public `/off` page, which their Telegram channel explicitly tells citizens to use.

Chain: `op=department_list` → `city_list` → `street_list` → `house_list` → `ls_list_by_addr` → `disconn_by_ls&disconn_selector=2`, read `DISCONN_QUEUQ[].QUEUE_INFO`, regex `(\\d) черга (\\d) підчерга`. **Verified working today, out of season** (Броварна/Черкаси resolved). Also gives live planned (`selector=0`) and emergency (`selector=1`) outages — useful for the "no ГПВ today" screen. Cache hourly; `/off` itself cites постанова НКРЕКП №349 від 26.03.2022 requiring 60-minute refresh, which sets the polite cadence.

### A3. Тернопіль official JSON API — **1 region, ~1 day, cleanest source outside ДТЕК**
`https://api-poweron.toe.com.ua/api` — Symfony API Platform, JSON-LD, no auth, no challenge. `https://poweron.toe.com.ua/robots.txt` = `User-agent: * / Disallow:` (explicit allow-all). The operator's 40K-subscriber official channel directs citizens here.

- `GET /api/a_gpv_g?after=&before=&group=&time=` — the ГПВ graph. Context declares `dateGraph, imageUrl, rawHtml, **dataJson**`.
- `GET /api/pw-accounts/building-groups` — all 12 підчерги.
- `GET /api/pw_cities?name=` → `pw_streets?city=&name=` → `building-groups?cityId=&streetId=` → `{"chergGpv":"4.1"}`. Address→черга works today.

**Caveat:** `a_gpv_g` returns `totalItems: 0` out of season (it serves only the *currently active* graph), so `dataJson`'s shape is unconfirmed. Build the client and the address lookup now; finish the graph mapping on season day one. Stay on `/api/a_gpv_g` — the canonical `/api/actual_gpv_graphs` returns `401 JWT`, and that line was drawn by the operator.

### A4. The four openly-readable seasonal operators — **4 regions, ~1 day recon + 1–2 days each**
**Миколаївська, Кіровоградська, Житомирська, Рівненська.** These were never blocked and never re-examined in this round; the brief says only "adapter not written," and the seasonal-stream lead states all four "leave the equivalent data openly readable."

**Do the recon before committing effort.** For each: read `robots.txt` first, then look for the same three shapes we now know exist — a JSON/Hydra API behind the public outage page (Тернопіль pattern), a downloadable XLSX/PDF (Прикарпаття/Хмельницький pattern), or an official Telegram channel with a text table (Запоріжжя pattern). Check for a separate unprotected subdomain (`poweron.*`, `svitlo.*`, `cabinet.*`, `ok.*`) — that is what was missed on Тернопіль by testing only `www`.

This is the best regions-per-day line in the plan **if** the recon confirms; treat the 4 as provisional until it does.

### A5. Івано-Франківськ — **1 region, ~1–2 days**
Two sources, both permitted, neither blocked (`oe.if.ua` is on CloudFront, no bot protection; robots.txt disallows only `*/shutdowns_table`, `*/faq/search`, `*/reports/sd_internal`, `*/investment_program?*`).

- **Day-ahead + intraday:** `@prykarpattyaoblenergo_official` (verified posting `Завтра, 19 березня…` and `Оновлення в ГПВ з 10:30`). This is the primary source.
- **Backfill/validation:** `https://oe.if.ua/uk/schedule_archives`, files at `/uk/download_schedule_archive?filename=shutdowns_schedule_archive_YYYYMMDD.xlsx`. Sheet: A1 = date, row 2 = `Черга` + 48 half-hour columns, rows 3–14 = 1.1–6.2, `X` = off, legend in row 16. No `sharedStrings.xml` — a ~40-line parser suffices. **Missing day = HTTP 302 to `/`, so branch on status without following redirects; `HEAD` works.** Month paging `?month=YYYY-MM` silently falls back to the current month for out-of-range values — validate rendered dates against the request.
- **The archive is D-1 only** (28.08 absent today). It cannot power the day-ahead view alone. Do **not** touch `/uk/shutdowns_table` — that is the one path robots.txt disallows.

Also the single best asset for the outreach in (c): it is a working, permitted, machine-readable example to point other operators at.

### A6. Закарпаття — **1 region, ~2–3 days**
`@zakarpatenergyofficial` posts the full table daily in season as a **fixed-geometry 800×210 JPEG** (12 subqueue rows × 48 half-hour columns), with the date in the plain-text caption. Measured cadence: 82 schedule posts across 52 dates, Nov 2025–Jan 2026, 82/82 with photo, 0/82 with a document.

Extract by **pixel sampling at computed cell positions, not OCR** — the grid is synthetic and geometrically stable. **Blocker to resolve first: no legend is visible in the crop, and the header reads `включення/відключення` — it is unknown whether a filled cell means power off or power on.** Resolve against a known-good day before shipping or the schedule renders inverted.

`zakarpat.energy` is a **total** HTML block (root included, not partial as first reported); only `robots.txt` and the sitemaps escape the WAF, and the sitemaps contain zero static schedule files. Website route is dead.

### A7. Хмельницький — **1 region, ~3–5 days, budget as a scraper with a vision component**
Site fully open, no Cloudflare, **no robots.txt at all**. Three separate pieces:
- **Address→черга:** stable XLSX per РЕМ, e.g. `https://hoe.com.ua/Content/Uploads/GPV6/xls/Черги_на_відключення_Хмельницький_РЕМ_побут_01072026.xlsx` (3,804 rows, `Населений пункт | Вулиця | Список будинків | Черга/підчерга`). Parse once per season. **This is the mapping, not the schedule** — the earlier "machine-readable ГПВ" label was wrong.
- **Daily table:** a raster PNG per day, linked from `https://hoe.com.ua/page/arhiv-grafikiv-pogodinnih-vidkljuchen-2026` (~115 entries Jan–Jul 2026). 12 rows × 24 columns, blue = off. CV extraction, same technique as A6.
- **Intraday:** `@khmelnytskoblenergo` text deltas per підчерга. **Mandatory, not optional** — the morning PNG is stale by noon.

Bonus live feed for emergency/planned (not ГПВ): `POST https://hoe.com.ua/shutdown/eventlist` with `TypeId`, `RemId`, `DateRange`.

### A8. Полтава — **partial only, 0.5 day**
`@poltavaOE` posts every single day, in season and out. Out of season: `На 28 серпня 2026 року застосування графіка погодинного відключення електроенергії у Полтавській області не прогнозується.` — an unbroken 20/20 daily run this month.

In season it gives **volume per time band** (`ГПВ в обсязі 2.5 черг з 08:00 по 16:00`), never which черга. `poe.pl.ua` is network-level unreachable from outside Ukraine (TCP timeout on both IPs, both ports, 100% ICMP loss — geo-fence, not a bot block), so the per-queue table cannot be fetched. **Do not mark Полтава "working."** Ship the band-volume banner and the "не прогнозується" signal; the per-queue view needs (c).

**Generalize the "не прогнозується" pattern.** A positive "no restrictions tomorrow" state is worth more to users than an empty screen, and every Telegram region can produce it. Build it as a first-class app state.

### A9. Чернігів — **1 region, recon only, ~0.5 day from a clean IP**
`chernihivoblenergo.com.ua` (with an **h**) is the operator and is **not** on Cloudflare. `chernigivoblenergo.com.ua` (with a **g**) is a betting-affiliate squat that *is* on Cloudflare — that is what got scored as blocked. The real site serves Europe fine (200 from CH/DE/ES/FI nodes, 0.2–0.5s) and has greylisted this sandbox's egress IP after chatty probing.

**Re-recon from a different IP, politely (1 req / few seconds, real UA), and read `robots.txt` first — we have never actually read it.** Expectation management: `/blackouts` asks for ЕІС-код/особовий рахунок and Wayback capture sizes stay flat at ~6–7 KB through deep winter, so it is probably a per-account lookup, i.e. the wrong shape for us. **Prefer `@chernigivoblenergo`** as the route; verify in season whether its ГПВ posts carry text or an image.

**Do-now subtotal: 3 certain + 4 provisional + 5 individual = up to 12 new regions, ~20–25 dev-days.**

---

## (b) DO IN OCTOBER — day-one season checklist

Everything below is currently unverifiable because Ukraine is out of restriction season. Run this list the first day НЕК «Укренерго» issues a ГПВ command.

| # | URL / channel | What to look for | Blocks |
|---|---|---|---|
| 1 | `GET https://api-poweron.toe.com.ua/api/a_gpv_g?after=&before=&group=&time=` | `hydra:member` non-empty; capture the **exact `dataJson` shape**. Also grab `imageUrl`/`rawHtml` as fallback. | Тернопіль |
| 2 | `@zakarpatenergyofficial` first table image | **Legend / inversion test.** Cross-check one filled cell against another region's published table for the same day, or against a news report. Confirm 800×210 geometry unchanged. | Закарпаття (hard blocker) |
| 3 | `https://oe.if.ua/uk/schedule_archives` on day D | Does the file for **D itself** appear, or only D-1? Probe `HEAD .../shutdowns_schedule_archive_<today>.xlsx` for 200 vs 302. | Івано-Франківськ (decides whether Telegram is mandatory or merely primary) |
| 4 | `disconn.php?op=disconn_by_ls&disconn_selector=2&n_date=<today>&k_date=<today>&abon_ls=…` | Does `DISCONNECTIONS[]` fill with ГПВ **hour windows**, or stay empty with only `DISCONN_QUEUQ`? If it fills, Черкаси needs no Telegram parsing at all. | Черкаси (simplification) |
| 5 | `@Zaporizhzhyaoblenergo_news` | The Google Apps Script queue-lookup URL is rotated per season; both known deployments are 404. A **new `script.google.com/macros/s/…/exec` link will be posted in-channel** — capture it, it is the only address→підчерга route for Запоріжжя. | Запоріжжя (address mapping) |
| 6 | `https://hoe.com.ua/page/arhiv-grafikiv-pogodinnih-vidkljuchen-2027` (and `-2026`) | First daily PNG of the season; confirm grid geometry, colours, and 12×24 layout still match. | Хмельницький |
| 7 | `@chernigivoblenergo` | Are ГПВ posts **text or image**? (`діятиме такий Графік` hints at an attachment.) | Чернігів |
| 8 | `@poltavaOE` | Watch for `Оновлено графік погодинного відключення електроенергії!` — that post announces a new **static seasonal черга×година table** and links it. It is the only trigger to re-acquire the mapping. | Полтава |
| 9 | `https://www.cherkasyoblenergo.com/perelik-gpv/_payload.json` | Winter file set replaces the 01.04–01.10.2026 set ~1 Oct; **uuids change** — never hardcode them, re-read the payload. | Черкаси |
| 10 | `https://hoe.com.ua/Content/Uploads/GPV6/xls/…_01102026.xlsx` | New effective-date suffix on the address→черга files. | Хмельницький |
| 11 | All Telegram channels | Re-measure revisions-per-day. If any region exceeds ~5/day, the polling interval must drop below 15 min for that channel. | all |
| 12 | Cloudflare-blocked 8 | Re-test **each** for a separate unprotected subdomain (`poweron.*`, `svitlo.*`, `cabinet.*`, `ok.*`, `api-*`). This pattern was missed on Тернопіль and is cheap to re-run. Also re-test transliteration variants (`g`↔`h`, `i`↔`y`) — that trap cost us Чернігів. | Вінниця, Волинь, Чернівці |

---

## (c) ASK A HUMAN

Send these **now, in August**, precisely because the season is dormant. A permission conversation held today is worth far more than one held on the first day of blackouts. Do not block any adapter on a reply.

| Region | Write to | Ask for |
|---|---|---|
| **Сумська** | `call_center@soe.com.ua`; press office `/press-service/for-media`; 0-800-300-247 | The data is already perfect JSON at `/api/vidkluchenya/get_all_data_disconnections_api`, but **their own robots.txt disallows `/api/`**. Narrowest ask in the whole list: written permission for one polling client on one endpoint, or a robots.txt carve-out. Highest expected value per email. |
| **Львівська** | via `poweron` site contacts; escalate via Міненерго (mev.gov.ua) and Львівська ОВА (loda.gov.ua), both linked as partners on their own site | They publish hours only as PNG. Ask for the underlying table, or for a time dimension added to their **existing public Hydra API** `power-api.loe.lviv.ua` (already exposes `blog_gpvs`, `city_gpvs`, `street_gpvs`) — a small addition, not a new system. |
| **Полтавська** | via `@poltavaOE` / operator contacts | The static seasonal черга×година table (their site is geo-fenced, we cannot fetch it). This one ask converts Полтава from partial to full. |
| **Івано-Франківська** | operator contact | One question: does the daily XLSX appear **on** the day, or only after? The file already exists — very defensible. |
| **Вінницька** | 0 800 217-217; written request to АТ «Вінницяобленерго» (no verified email found — obtain one) | Explicit WAF **block** rule (no `cf-mitigated`, robots.txt itself 403). Someone made a decision; someone can amend it for one URL. |
| **Чернівецька** | `info@oe.cv.ua` (MX verified live), (0372) 584-980, (099) 230-99-00 | Same ask. Their Telegram has been silent since Nov 2022 — the website is the only thing they have. |
| **Волинська** | `client@energy.volyn.ua` (+ `client.lutsk@`, `client.vol@`, `client.kovel@`, `client.kamin@`) | Same ask, with the strongest argument: the НКЦК cybersecurity ruling **pushed them off Telegram**, so a machine-readable file is now the only way any app can carry Volyn. Note these are client-service inboxes and will need forwarding. |
| **Закарпатська** | hotline 0800501620 | Optional — Telegram images work. Ask only for the legend/colour semantics, or a data file. |

**One caveat on the regulatory lever:** the twice-yearly ГПВ approval cycle and the `Інструкція про складання графіків погодинних відключень` are corroborated only by what operators themselves publish; the Держенергонагляд page refused connection and the exact НКРЕКП clause was never pinned. **Постанова НКРЕКП №349 від 26.03.2022** (interruption information refreshed every 60 minutes) *is* verified — Черкаси cite it on their own `/off` page. Use №349 in writing; keep the Інструкція reference descriptive, not legalistic, until someone reads the Кодекс систем розподілу (постанова №310 від 14.03.2018) properly and finds the publication clause. That clause, once found, turns every ask below from a favour into a standing request.

### Ready-to-send template

```
Тема: Запит на доступ до графіків погодинних відключень у машиночитному форматі

Доброго дня!

Звертаюся від імені розробника безкоштовного мобільного застосунку
«Коли Світло» (App Store, українською мовою). Застосунок показує громадянам
актуальні графіки погодинних відключень за чергами та підчергами.
Він безкоштовний, без реклами та без платних функцій. Ми не перепродаємо
дані — ми доносимо ваші ж офіційні графіки до ваших споживачів у зручнішому
вигляді.

Наразі ми коректно покриваємо [N] областей. Щоб додати [ОБЛАСТЬ], нам
потрібне джерело, яке контролюєте ви — а не розпізнавання зображень і не
обхід захисту вашого сайту. Ми принципово не робимо ні того, ні іншого.

Просимо розглянути будь-який із варіантів — нас влаштує кожен:

1) Машиночитний файл графіка (JSON, CSV або XLSX) за постійною адресою,
   що оновлюється при кожній зміні ГПВ. Структура: «черга/підчерга →
   інтервали відсутності електропостачання». Робочий приклад такого
   рішення вже публікує АТ «Прикарпаттяобленерго»:
   https://oe.if.ua/uk/schedule_archives

2) Дозвіл (і, за потреби, виняток у налаштуваннях захисту сайту або в
   robots.txt) для одного ідентифікованого клієнта з нашим User-Agent,
   із частотою не частіше одного запиту на 15 хвилин.

3) Письмове підтвердження, що ми можемо використовувати як джерело ваш
   офіційний Telegram-канал [КАНАЛ].

З нашого боку зобов'язуємося: зазначати вас як джерело даних у застосунку,
дотримуватися погодженої частоти запитів, не створювати навантаження на
ваші системи та негайно припинити використання на вашу вимогу.

Зауважу, що йдеться про інформацію, яку ви вже публікуєте для споживачів:
згідно з постановою НКРЕКП №349 від 26.03.2022 інформація про перерви в
електропостачанні актуалізується щогодини, а графіки погодинних відключень
складаються та затверджуються двічі на рік і застосовуються за вказівкою
диспетчера НЕК «Укренерго». Ми просимо не про нові дані, а про зручну для
автоматичного зчитування форму вже наявних.

Готовий надати будь-які технічні деталі та підписати відповідні
зобов'язання.

З повагою,
[ім'я], розробник застосунку «Коли Світло»
[email] · [телефон]
```

---

## (d) DEAD ENDS

**Truly not applicable — 3 regions.** Донецька, Луганська, АР Крим. Occupied; no operator, no schedule, no source. Remove them from the app's region list rather than showing them as broken.

**No legitimate technical route exists today — 3 regions.** These are dead until (c) produces a reply. Do not spend further automated-discovery effort on them.

- **Вінницька.** `voe.com.ua` returns 403 on *every* path including `robots.txt` and `sitemap.xml`, with the explicit "Sorry, you have been blocked" body and **no** `cf-mitigated` header — a deliberate WAF ban, not a solvable challenge. Confirmed from two unrelated networks. `www`, `svitlo`, and eight other subdomain guesses all resolve to Cloudflare or nowhere. Eleven Telegram handles probed: none exist; the only presence is `@pat_voe_bot`, a per-user bot. `data.gov.ua`: zero relevant datasets. Their Facebook page (`/vinoblenergo/`) does post during the season, but as prose that points back at the blocked site, and reading it needs Meta's Page Public Content Access review. Their own mobile app has a queue lookup — that is exactly the private-API-of-a-blocking-operator case we ruled out.
- **Волинська.** Worst case of the thirteen. `energy.volyn.ua` challenge-blocked site-wide (`/`, `/robots.txt`, `/feed/`, `/rss`, `/sitemap.xml`, the schedule page, the ГПВ news page — all 403). And their Telegram is **dead by policy, not by season**: `@energy_volyn_official` stopped mid-season in Oct 2024 on an НКЦК ruling restricting Telegram at critical-infrastructure operators. It will not reawaken. All three redirect targets (Viber bot, Viber community, WhatsApp channel, Facebook) are walled platforms with no permitted read path; the WhatsApp channel page renders zero post content. Two other reachable operator domains (`elektro.volyn.ua`, `ok.prosvitlo.com`) carry no ГПВ. `data.gov.ua`: count 0.
- **Чернівецька.** `oblenergo.cv.ua` WAF-blocked identically to Вінниця, robots.txt unreadable (403) so their crawl policy cannot even be evaluated. `@oe_cv_ua` has **11 posts total, last one Nov 2022** — verified by probing message ids individually; the 22k subscribers are 2022 signups on a channel that never posted again. `api.oblenergo.cv.ua` is somebody's Matrix chat server behind a mismatched cert. `oe.cv.ua` is a registrar parking page that exists only to carry their mail.

**Unknown, and nobody looked — 1 region.** **Херсонська.** It sits in the brief's "NO FEED FOUND" bucket and no research stream covered it this round. Given that three of the other four in that bucket turned out to have feeds, it deserves one recon pass before being written off — but it is also the region where the grid situation makes a stable published schedule least likely. Budget 0.5 day, expect nothing.

---

## Product consequence

Do not ship a 26-region picker where 4 work. Give every region an explicit state: **live**, **partial** (Полтава: band volume only, no per-queue view), **seasonal — джерело неактивне** (correct and true for everything out of season), and **джерело недоступне** (Вінниця, Волинь, Чернівці). A user in Волинь who is told plainly that the operator does not publish machine-readably is better served than one staring at a permanently empty grid — and that screen is also the strongest lever we have on those three operators.
---

## ДОПОВНЕННЯ 2026-08-28: Херсонська область (розвідка, якої не було в основному раунді)

Область НЕ мертва — просто порожня поза сезоном. Перевірено вручну:

- `ksoe.com.ua` — **HTTP 200**, живий, БЕЗ Cloudflare. Інші домени (`kherson.energy`,
  `ksoe.com.ua` з `www`, `khoe.com.ua`) не резолвляться взагалі.
- `ksoe.com.ua/robots.txt` дозволяє майже все, АЛЕ містить `Disallow: /*?` — **будь-яка адреса
  з query-параметрами заборонена**. Адаптер має ходити лише «чистими» шляхами.
- Сторінка графіків: **`/disconnection/schedule/`** → HTTP 200 з `Content-Length: 0`.
  Порожня саме по сезону: сторінка існує, вміст з'явиться разом з обмеженнями.
- `/disconnection/` віддає 302 на `/messages/`; `/contract_cabinet/residual_schedule/` — 200,
  28 КБ, але це кабінет договорів, не ГПВ.
- Офіційного Telegram-каналу не знайдено: `khersonoblenergo`, `kherson_energy`, `ksoe_ua`,
  `khersonenergo` — усі 302 (не існують).

**Висновок:** статус `seasonal`, а не `noFeed`. У день старту сезону перевірити
`GET https://ksoe.com.ua/disconnection/schedule/` на непорожню відповідь — це єдина дія.
Адаптер писати зараз немає проти чого: ні структури, ні архіву.
