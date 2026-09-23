/**
 * `note` is rendered to the user in the picker INSTEAD of the per-status explanation, so it must
 * read as a fact about the operator, not as a implementation detail. Anything technical belongs in
 * a comment here. Sources, for the record: Харків/Запоріжжя/Черкаси come from the operators' own
 * Telegram channels, Тернопіль from api-poweron.toe.com.ua, Івано-Франківськ from the daily XLSX
 * archive. Кіровоград serves its schedule only over POST, which Cloudflare challenges; Херсон's
 * schedule page answers 200 with an empty body out of season.
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
  // Checked 2026-09-13: while no queue schedule is published, people here are still switched off —
  // for the pre-winter repair campaign, street by street. Those lists go out daily and only as
  // photos in the operator's channel, so they are neither mirrored nor parsed. The picker renders
  // `note` as plain text, so the channel is named for search rather than linked.
  { id: 'mykolaiv',      title: 'Миколаївська область', subtitle: 'область',         operator: 'АТ «Миколаївобленерго»',                  source: 'mykolaiv', status: 'seasonal',
    note: 'графік публікують лише під час обмежень; планові ремонтні відключення за адресами — щодня в Telegram-каналі оператора @mk_energy_ua' },

  // --- planned: publishes a queue schedule, adapter still to write
  { id: 'lviv',          title: 'Львівська область',   subtitle: 'область',          operator: 'ПрАТ «Львівобленерго»',        source: null, status: 'seasonal', probe: 'https://poweron.loe.lviv.ua/shedule-off' },
  { id: 'kirovohrad',    title: 'Кіровоградська область', subtitle: 'область',       operator: 'АТ «Кіровоградобленерго»',     source: null, status: 'seasonal', probe: 'https://kiroe.com.ua/energy'  },
  { id: 'zhytomyr',      title: 'Житомирська область', subtitle: 'область',          operator: 'АТ «Житомиробленерго»',        source: 'zhytomyr', status: 'seasonal', probe: 'https://www.ztoe.com.ua/' },
  { id: 'sumy',          title: 'Сумська область',     subtitle: 'область',          operator: 'АТ «Сумиобленерго»',           source: null, status: 'seasonal', probe: 'https://www.soe.com.ua/' },
  { id: 'rivne',         title: 'Рівненська область',  subtitle: 'область',          operator: 'АТ «Рівнеобленерго»',          source: 'rivne', status: 'seasonal', probe: 'https://www.ez.rv.ua/grafiky-pogodynnyh-vidklyuchen/' },

  // --- blocked: the site 403s every automated request, browser headers included
  { id: 'vinnytsia',     title: 'Вінницька область',   subtitle: 'область',          operator: 'АТ «Вінницяобленерго»',                   source: null, status: 'blocked' },
  { id: 'volyn',         title: 'Волинська область',   subtitle: 'область',          operator: 'ПрАТ «Волиньобленерго»',                  source: null, status: 'blocked' },
  // Their day-ahead table is at /uk/shutdowns_table, which their robots.txt disallows, and the
  // dedicated schedule site is behind Cloudflare. What is permitted is the archive — yesterday's
  // sheet. That is a real source, but it can never answer "when is my light going off today",
  // so `archiveOnly` keeps the region from being offered as working on the strength of it.
  // Lift the flag when the day-ahead Telegram adapter exists, or when the operator starts
  // publishing the file on the day it applies — which is exactly what to ask them for.
  { id: 'ivano-frankivsk', title: 'Івано-Франківська область', subtitle: 'область',  operator: 'АТ «Прикарпаттяобленерго»',               source: 'ivano-frankivsk', status: 'seasonal', archiveOnly: true,
    note: 'оператор викладає графік лише постфактум, наступного дня — підключимо, щойно зʼявиться графік на день уперед' },
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
  { id: 'kherson',      title: 'Херсонська область',  subtitle: 'область',          operator: 'АТ «Херсонобленерго»',                    source: null, status: 'seasonal' },

  // --- occupied
  { id: 'donetsk',       title: 'Донецька область',    subtitle: 'область',          operator: 'ДТЕК Донецькі електромережі',             source: null, status: 'occupied' },
  { id: 'luhansk',       title: 'Луганська область',   subtitle: 'область',          operator: '—',                                       source: null, status: 'occupied' },
  { id: 'crimea',        title: 'АР Крим',             subtitle: 'автономна республіка', operator: '—',                                   source: null, status: 'occupied' }
];


export function regionById(id) {
  return REGIONS.find((region) => region.id === id) ?? null;
}
