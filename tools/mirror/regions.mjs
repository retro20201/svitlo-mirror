/**
 * `note` is rendered to the user in the picker INSTEAD of the per-status explanation, so it must
 * read as a fact about the operator, not as a implementation detail. Anything technical belongs in
 * a comment here. Sources, for the record: Харків/Запоріжжя/Черкаси/Кіровоград come from the operators'
 * own Telegram channels, Тернопіль from api-poweron.toe.com.ua, Івано-Франківськ from be-svitlo.oe.if.ua
 * (the API behind the operator's svitlo.oe.if.ua), Львів from the schedule text at api.loe.lviv.ua,
 * Волинь from the picture its api-voe-poweron.inneti.net publishes.
 * Херсон's schedule page answers 200 with an empty body, and has since December 2023.
 *
 * Registry of every region the app can offer, and where its schedule comes from.
 *
 * `status` is published to the app in `index.json`, so a region can be switched on without an
 * App Store release — and, just as importantly, a region whose source breaks can be switched
 * back off the same way.
 *
 *   live      — an adapter produces a usable schedule right now
 *   seasonal  — the operator publishes a queue×hour table only while restrictions are in force.
 *               Out of season the page is an address-lookup form with nothing to parse, so an
 *               adapter cannot be written *or verified* until schedules return. `probe.mjs`
 *               watches these and reports the moment one starts publishing.
 *   blocked   — the operator deliberately blocks automated access. Verified 2026-08-27 with
 *               Playwright: headless, headed, and a real Chrome driven over CDP all get
 *               Cloudflare's "Sorry, you have been blocked" — a hard block, not a JS challenge
 *               that waiting solves. Getting in would mean defeating an anti-bot measure the
 *               operator put up on purpose, on their bandwidth. Not a scraping problem: the way
 *               in is asking them for access, the same conclusion reached about the aggregator's
 *               disallowed API.
 *   noFeed    — the operator does not publish a machine-readable queue schedule at all
 *               (PDF/XLSX/images only, or address lookup instead of queues)
 *   occupied  — no schedule exists to publish
 */
export const REGIONS = [
  // --- live: ДТЕК's DisconSchedule, the richest source we have (weekly preset + half-hours)
  { id: 'kyiv',          title: 'Київ',                subtitle: 'місто',            operator: 'ДТЕК Київські електромережі',            source: 'dtek',     status: 'live' },
  { id: 'kyiv-region',   title: 'Київська область',    subtitle: 'область',          operator: 'ДТЕК Київські регіональні електромережі', source: 'dtek',    status: 'live' },
  { id: 'dnipro',        title: 'Дніпро',              subtitle: 'місто та область', operator: 'ДТЕК Дніпровські електромережі',          source: 'dtek',    status: 'live' },
  { id: 'odesa',         title: 'Одеса',               subtitle: 'місто та область', operator: 'ДТЕК Одеські електромережі',              source: 'dtek',    status: 'live' },

  // --- seasonal: the API answers, but out of season it returns queue names with no hours,
  //     so the app must not offer it as a working region until schedules come back
  // Only the 12 ГПВ підчерги (`/api/outage-queue/by-type/3`) carry hours, and they are the national
  // 1.1–6.2. ГАВ and СГАВ (types 1 and 2) are live on/off tiles on the operator's page, not
  // schedules, so they are not offered as queues (checked against their /js/app.js on 2026-10-01).
  // Checked 2026-09-13: while no queue schedule is published, people here are still switched off —
  // for the pre-winter repair campaign, street by street. Those lists go out daily and only as
  // photos in the operator's channel, so they are neither mirrored nor parsed. The picker renders
  // `note` as plain text, so the channel is named for search rather than linked.
  { id: 'mykolaiv',      title: 'Миколаївська область', subtitle: 'область',         operator: 'АТ «Миколаївобленерго»',                  source: 'mykolaiv', status: 'seasonal',
    note: 'графік публікують лише під час обмежень; планові ремонтні відключення за адресами — щодня в Telegram-каналі оператора @mk_energy_ua' },

  // --- planned: publishes a queue schedule, adapter still to write
  // Read from the text under their schedule picture (api.loe.lviv.ua, menu items 238 and 256). The
  // probe it replaces watched /shedule-off, a client-side route of their React app: the server
  // answers it with the same 1 195-byte empty shell as the home page, so it could never fire.
  { id: 'lviv',          title: 'Львівська область',   subtitle: 'область',          operator: 'ПрАТ «Львівобленерго»',        source: 'lviv', status: 'seasonal' },
  // Read from the operator's district Telegram channels, which carry the oblast-wide table verbatim.
  { id: 'kirovohrad',    title: 'Кіровоградська область', subtitle: 'область',       operator: 'АТ «Кіровоградобленерго»',     source: 'kirovohrad', status: 'seasonal' },
  { id: 'zhytomyr',      title: 'Житомирська область', subtitle: 'область',          operator: 'АТ «Житомиробленерго»',        source: 'zhytomyr', status: 'seasonal', probe: 'https://www.ztoe.com.ua/' },
  { id: 'sumy',          title: 'Сумська область',     subtitle: 'область',          operator: 'АТ «Сумиобленерго»',           source: null, status: 'seasonal', probe: 'https://www.soe.com.ua/' },
  { id: 'rivne',         title: 'Рівненська область',  subtitle: 'область',          operator: 'АТ «Рівнеобленерго»',          source: 'rivne', status: 'seasonal', probe: 'https://www.ez.rv.ua/grafiky-pogodynnyh-vidklyuchen/' },

  // --- blocked: the site 403s every automated request, browser headers included
  { id: 'vinnytsia',     title: 'Вінницька область',   subtitle: 'область',          operator: 'АТ «Вінницяобленерго»',                   source: null, status: 'blocked' },
  // energy.volyn.ua answers only Ukrainian IPs, but its schedule is an iframe of the operator's
  // «poweron» service, whose API hands out the day's picture — read by colour, see sources/volyn.mjs.
  { id: 'volyn',         title: 'Волинська область',   subtitle: 'область',          operator: 'ПрАТ «Волиньобленерго»',                  source: 'volyn', status: 'seasonal' },
  // Day-ahead from be-svitlo.oe.if.ua, the open API behind the operator's own svitlo.oe.if.ua —
  // checked 2026-10-01: CloudFront, robots.txt `Allow: /`, no Cloudflare challenge any more.
  // /uk/shutdowns_table on oe.if.ua stays untouched (its robots.txt disallows it). Out of season the
  // API answers `[]`, so the region reports itself seasonal until today or tomorrow is published.
  { id: 'ivano-frankivsk', title: 'Івано-Франківська область', subtitle: 'область',  operator: 'АТ «Прикарпаттяобленерго»',               source: 'ivano-frankivsk', status: 'seasonal' },
  { id: 'ternopil',      title: 'Тернопільська область', subtitle: 'область',        operator: 'АТ «Тернопільобленерго»',                 source: 'ternopil', status: 'seasonal' },
  { id: 'kharkiv',       title: 'Харківська область',  subtitle: 'область',          operator: 'АТ «Харківобленерго»',                    source: 'kharkiv', status: 'seasonal' },
  { id: 'chernivtsi',    title: 'Чернівецька область', subtitle: 'область',          operator: 'АТ «Чернівціобленерго»',                  source: null, status: 'blocked' },
  { id: 'chernihiv',     title: 'Чернігівська область', subtitle: 'область',         operator: 'АТ «Чернігівобленерго»',                  source: null, status: 'blocked' },
  { id: 'zakarpattia',   title: 'Закарпатська область', subtitle: 'область',         operator: 'АТ «Закарпаттяобленерго»',                source: null, status: 'blocked' },

  // --- noFeed: nothing machine-readable to parse
  { id: 'khmelnytskyi',  title: 'Хмельницька область', subtitle: 'область',          operator: 'АТ «Хмельницькобленерго»',                source: 'khmelnytskyi', status: 'seasonal' , note: 'оператор публікує графік лише зображенням' },
  { id: 'cherkasy',      title: 'Черкаська область',   subtitle: 'область',          operator: 'АТ «Черкасиобленерго»',                   source: 'cherkasy', status: 'seasonal' },
  { id: 'zaporizhzhia',  title: 'Запорізька область',  subtitle: 'область',          operator: 'АТ «Запоріжжяобленерго»',                 source: 'zaporizhzhia', status: 'seasonal' },
  { id: 'poltava',       title: 'Полтавська область',  subtitle: 'область',          operator: 'АТ «Полтаваобленерго»',                   source: null, status: 'noFeed' , note: 'оператор публікує лише кількість черг, без таблиці підчерг' },
  // Checked 2026-10-01 from a Kyiv IP: the operator's whole «Відключення» section has answered 200
  // with an empty body since December 2023, winter 2025–26 included, and neither its channel nor
  // the ОВА's has ever carried an hourly table by черга. Outages there follow the shelling.
  // `seasonal` promised a season that does not come.
  { id: 'kherson',      title: 'Херсонська область',  subtitle: 'область',          operator: 'АТ «Херсонобленерго»',                    source: null, status: 'noFeed', note: 'оператор не публікує графіків відключень за чергами' },

  // --- occupied
  { id: 'donetsk',       title: 'Донецька область',    subtitle: 'область',          operator: 'ДТЕК Донецькі електромережі',             source: null, status: 'occupied' },
  { id: 'luhansk',       title: 'Луганська область',   subtitle: 'область',          operator: '—',                                       source: null, status: 'occupied' },
  { id: 'crimea',        title: 'АР Крим',             subtitle: 'автономна республіка', operator: '—',                                   source: null, status: 'occupied' }
];


export function regionById(id) {
  return REGIONS.find((region) => region.id === id) ?? null;
}
