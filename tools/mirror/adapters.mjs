/** Region `source` → its adapter, loaded only when a run needs it. Shared by mirror.mjs and relay.mjs. */
export const ADAPTERS = {
  dtek: () => import('./sources/dtek.mjs'),
  mykolaiv: () => import('./sources/mykolaiv.mjs'),
  kharkiv: () => import('./sources/kharkiv.mjs'),
  zaporizhzhia: () => import('./sources/zaporizhzhia.mjs'),
  cherkasy: () => import('./sources/cherkasy.mjs'),
  ternopil: () => import('./sources/ternopil.mjs'),
  'ivano-frankivsk': () => import('./sources/ivano-frankivsk.mjs'),
  zhytomyr: () => import('./sources/zhytomyr.mjs'),
  rivne: () => import('./sources/rivne.mjs'),
  khmelnytskyi: () => import('./sources/khmelnytskyi.mjs'),
  lviv: () => import('./sources/lviv.mjs'),
  kirovohrad: () => import('./sources/kirovohrad.mjs'),
  volyn: () => import('./sources/volyn.mjs'),
  sumy: () => import('./sources/sumy.mjs'),
  zakarpattia: () => import('./sources/zakarpattia.mjs'),
  chernihiv: () => import('./sources/chernihiv.mjs'),
  poltava: () => import('./sources/poltava.mjs'),
  vinnytsia: () => import('./sources/vinnytsia.mjs'),
  chernivtsi: () => import('./sources/chernivtsi.mjs')
};
