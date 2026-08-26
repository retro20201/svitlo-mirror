/**
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
 *   blocked   — the operator's site refuses automated access (403 even to a real browser)
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

  // --- live: first-party APIs found on the operators' own sites
  { id: 'mykolaiv',      title: 'Миколаївська область', subtitle: 'область',         operator: 'АТ «Миколаївобленерго»',                  source: 'mykolaiv', status: 'live' },

  // --- planned: publishes a queue schedule, adapter still to write
  { id: 'lviv',          title: 'Львівська область',   subtitle: 'область',          operator: 'ПрАТ «Львівобленерго»',        source: null, status: 'seasonal', probe: 'https://poweron.loe.lviv.ua/shedule-off' },
  { id: 'kirovohrad',    title: 'Кіровоградська область', subtitle: 'область',       operator: 'АТ «Кіровоградобленерго»',     source: null, status: 'seasonal', probe: 'https://kiroe.com.ua/energy' },
  { id: 'zhytomyr',      title: 'Житомирська область', subtitle: 'область',          operator: 'АТ «Житомиробленерго»',        source: null, status: 'seasonal', probe: 'https://www.ztoe.com.ua/' },
  { id: 'sumy',          title: 'Сумська область',     subtitle: 'область',          operator: 'АТ «Сумиобленерго»',           source: null, status: 'seasonal', probe: 'https://www.soe.com.ua/' },
  { id: 'rivne',         title: 'Рівненська область',  subtitle: 'область',          operator: 'АТ «Рівнеобленерго»',          source: null, status: 'seasonal', probe: 'https://www.ez.rv.ua/grafiky-pogodynnyh-vidklyuchen/' },

  // --- blocked: the site 403s every automated request, browser headers included
  { id: 'vinnytsia',     title: 'Вінницька область',   subtitle: 'область',          operator: 'АТ «Вінницяобленерго»',                   source: null, status: 'blocked' },
  { id: 'volyn',         title: 'Волинська область',   subtitle: 'область',          operator: 'ПрАТ «Волиньобленерго»',                  source: null, status: 'blocked' },
  { id: 'ivano-frankivsk', title: 'Івано-Франківська область', subtitle: 'область',  operator: 'АТ «Прикарпаттяобленерго»',               source: null, status: 'blocked' },
  { id: 'ternopil',      title: 'Тернопільська область', subtitle: 'область',        operator: 'АТ «Тернопільобленерго»',                 source: null, status: 'blocked' },
  { id: 'kharkiv',       title: 'Харківська область',  subtitle: 'область',          operator: 'АТ «Харківобленерго»',                    source: null, status: 'blocked' },
  { id: 'chernivtsi',    title: 'Чернівецька область', subtitle: 'область',          operator: 'АТ «Чернівціобленерго»',                  source: null, status: 'blocked' },
  { id: 'chernihiv',     title: 'Чернігівська область', subtitle: 'область',         operator: 'АТ «Чернігівобленерго»',                  source: null, status: 'blocked' },
  { id: 'zakarpattia',   title: 'Закарпатська область', subtitle: 'область',         operator: 'АТ «Закарпаттяобленерго»',                source: null, status: 'blocked' },

  // --- noFeed: nothing machine-readable to parse
  { id: 'khmelnytskyi',  title: 'Хмельницька область', subtitle: 'область',          operator: 'АТ «Хмельницькобленерго»',                source: null, status: 'noFeed', note: 'черги лише у PDF/XLSX' },
  { id: 'cherkasy',      title: 'Черкаська область',   subtitle: 'область',          operator: 'АТ «Черкасиобленерго»',                   source: null, status: 'noFeed', note: 'пошук за особовим рахунком, без таблиці черг' },
  { id: 'zaporizhzhia',  title: 'Запорізька область',  subtitle: 'область',          operator: 'АТ «Запоріжжяобленерго»',                 source: null, status: 'noFeed', note: 'сайт не відповідає' },
  { id: 'poltava',       title: 'Полтавська область',  subtitle: 'область',          operator: 'АТ «Полтаваобленерго»',                   source: null, status: 'noFeed', note: 'сайт не відповідає' },
  { id: 'kherson',       title: 'Херсонська область',  subtitle: 'область',          operator: 'АТ «Херсонобленерго»',                    source: null, status: 'noFeed', note: 'сайт не відповідає' },

  // --- occupied
  { id: 'donetsk',       title: 'Донецька область',    subtitle: 'область',          operator: 'ДТЕК Донецькі електромережі',             source: null, status: 'occupied' },
  { id: 'luhansk',       title: 'Луганська область',   subtitle: 'область',          operator: '—',                                       source: null, status: 'occupied' },
  { id: 'crimea',        title: 'АР Крим',             subtitle: 'автономна республіка', operator: '—',                                   source: null, status: 'occupied' }
];

export const LIVE_REGIONS = REGIONS.filter((region) => region.status === 'live');

export function regionById(id) {
  return REGIONS.find((region) => region.id === id) ?? null;
}
