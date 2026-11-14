/** Region `source` → its adapter, loaded only when a run needs it. Shared by mirror.mjs and relay.mjs. */
export const ADAPTERS = {
  // A region with `cekQueues` (regions.mjs) has the hours of another operator's queues put into what its adapter read
  // (lib/cek-in-dnipro.mjs); an adapter that throws, throws as before, with whatever it offered as a fallback.
  dtek: async () => {
    const dtek = await import('./sources/dtek.mjs');
    const { withCekQueues } = await import('./lib/cek-in-dnipro.mjs');
    return {
      ...dtek,
      fetchRegion: async (region) => (region.cekQueues ? withCekQueues(await dtek.fetchRegion(region)) : dtek.fetchRegion(region))
    };
  },
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
  chernivtsi: () => import('./sources/chernivtsi.mjs'),
  cek: () => import('./sources/cek.mjs')
};
