import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { regionById, indexEntry } from './regions.mjs';
import { readerOf } from './lib/dtek-emergency.mjs';
import { kyivDayStart } from './lib/canonical.mjs';
import { withChannelEmergency } from './sources/dtek.mjs';
import { fetchRegion as fetchSumy } from './sources/sumy.mjs';
import { fetchRegion as fetchChernihiv } from './sources/chernihiv.mjs';

// «Графіки аварійних відключень» on the operators' own channels, read for Суми and Чернігів as Харків, Черкаси and Житомир already
// are. The posts are the channels' own, 6–10 November 2026, when Укренерго said that the published schedules did not apply in
// Сумська область: «О 17:50 за командою НЕК "Укренерго" на Сумщині введено графіки аварійних відключень у повному обсязі»,
// «⚠️ За вказівкою НЕК "Укренерго", у Чернігівській області застосовано 5 черг Графіка аварійних відключень (ГАВ)».

const POSTS = JSON.parse(readFileSync(new URL('./emergency-own-channels.fixture-2026-11-10.json', import.meta.url), 'utf8'));
const at = (iso) => new Date(iso);

/** `fact.emergency` the region would carry at `iso`, told from the posts the channel had then. */
async function emergencyAt(id, iso) {
  const posts = POSTS[id].filter((post) => post.postedAt <= iso.replace('Z', '+00:00'));
  const result = await withChannelEmergency({ regionId: id, fact: { data: {} } }, regionById(id), {
    read: readerOf(posts), now: at(iso), log: () => {}
  });
  return result.fact.emergency;
}

test('both regions name their own channel, and the index says they carry the signal', () => {
  assert.deepEqual(regionById('sumy').emergencyTelegram, { area: 'own', channel: 'SumyEnergo', maxAgeHours: 12 });
  assert.deepEqual(regionById('chernihiv').emergencyTelegram, { area: 'own', channel: 'chernigivoblenergo', maxAgeHours: 36 });
  assert.equal(indexEntry(regionById('sumy')).emergencySignal, true);
  assert.equal(indexEntry(regionById('chernihiv')).emergencySignal, true);
});

test('Суми: told from the first «ГАВ введені», and still on the next morning', async () => {
  const day = (iso) => [kyivDayStart(at(iso))];
  assert.deepEqual(await emergencyAt('sumy', '2026-11-08T12:30:00Z'), day('2026-11-08T12:30:00Z'), '«О 14:00 ГАВ введені в повному обсязі»');
  assert.deepEqual(await emergencyAt('sumy', '2026-11-09T08:00:00Z'), day('2026-11-09T08:00:00Z'), '«о 09:44 введені графіки аварійних відключень для 1-5 черг»');
  assert.deepEqual(await emergencyAt('sumy', '2026-11-09T17:00:00Z'), day('2026-11-09T17:00:00Z'), '«О 17:50 … у повному обсязі - для 1-10 черг»');
  assert.deepEqual(await emergencyAt('sumy', '2026-11-10T08:00:00Z'), day('2026-11-10T08:00:00Z'), '«о 09:07 введені … для 1-5 черг»');
});

test('Суми: an order is believed for twelve hours, and the channel never writes its end', async () => {
  // «О 17:50 … у повному обсязі» (9 November) is the last word until 07:14 on the 10th
  assert.deepEqual(await emergencyAt('sumy', '2026-11-10T03:00:00Z'), [kyivDayStart(at('2026-11-10T03:00:00Z'))], '9 hours on');
  assert.equal(await emergencyAt('sumy', '2026-11-10T06:30:00Z'), undefined, '12 hours after 15:54 UTC and before the next order: not believed any more');
  assert.equal(await emergencyAt('sumy', '2026-11-12T08:00:00Z'), undefined);
});

test('Чернігів: on from «застосовано 5 черг Графіка аварійних відключень (ГАВ)», off when a day and a half has passed', async () => {
  const day = (iso) => [kyivDayStart(at(iso))];
  assert.deepEqual(await emergencyAt('chernihiv', '2026-11-06T12:00:00Z'), day('2026-11-06T12:00:00Z'));
  assert.deepEqual(await emergencyAt('chernihiv', '2026-11-07T15:00:00Z'), day('2026-11-07T15:00:00Z'));
  assert.equal(await emergencyAt('chernihiv', '2026-11-09T08:00:00Z'), undefined, '36 hours after the last post about it (7 November 14:01)');
});

test('before the channel said anything, the region carries no signal', async () => {
  assert.equal(await emergencyAt('chernihiv', '2026-11-05T12:00:00Z'), undefined);
});

// --- the adapters themselves: the snapshot they return carries the signal when the channel declares it

const fixture = (name) => readFileSync(new URL(`./${name}`, import.meta.url));
const sumyPage = [
  `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="SumyEnergo/2980">`,
  `<a class="tgme_widget_message_photo_wrap" href="https://t.me/SumyEnergo/2980" style="width:460px;background-image:url('https://cdn.example/2985.jpg')"></a>`,
  `<div class="tgme_widget_message_text js-message_text" dir="auto">Завтра, 21 січня, діятимуть графіки погодинних відключень.</div>`,
  `<div class="tgme_widget_message_footer"><time datetime="2026-01-20T18:29:20+00:00" class="time">x</time></div></div></div>`
].join('');

test('Суми\'s adapter returns the schedule with the emergency on top of it when its channel says so, and without it when it does not', async () => {
  const now = new Date('2026-01-21T08:00:00Z');
  const options = (readEmergency) => ({
    now, spacing: 0, fetchPage: async () => sumyPage, fetchImage: async () => fixture('sumy.fixture-2985.jpg'), readEmergency
  });
  const on = await fetchSumy({ ...regionById('sumy') }, options(async () => ({ active: true, since: '2026-01-21T07:00:00+00:00', note: null })));
  assert.deepEqual(on.fact.emergency, [kyivDayStart(now)]);
  assert.ok(Object.keys(on.fact.data).length > 0, 'the table is still there');

  const off = await fetchSumy({ ...regionById('sumy') }, options(async () => ({ active: false, since: null, note: null })));
  assert.equal(off.fact.emergency, undefined);

  // a region object without the setting (the older tests' own) reads no channel for it
  const bare = await fetchSumy({ id: 'sumy', title: 'Сумська область' }, { ...options(async () => assert.fail('not asked')) });
  assert.equal(bare.fact.emergency, undefined);
});

test('Чернігів\'s adapter is asked for the emergency only when the region carries the setting', async () => {
  let asked = 0;
  const html = `<div class="tgme_widget_message_wrap"></div>`;
  const options = { now: new Date('2026-01-14T22:30:00Z'), spacing: 0, fetchPage: async () => html, fetchImage: async () => assert.fail('no picture'), readEmergency: async () => { asked++; return { active: false }; } };
  await fetchChernihiv({ id: 'chernihiv', title: 'Чернігівська область', previous: { fact: { data: {} } } }, options).catch(() => {});
  assert.equal(asked, 0, 'no setting, no reading');
});

test('the short «ГАВ введені» / «введено ГАВ» is an order, and «не введено ГАВ» is not', () => {
  const read = (text) => readerOf([{ id: 1, postedAt: '2026-11-08T12:00:00+00:00', text }])({ area: 'own', now: at('2026-11-08T12:30:00Z'), maxAgeMs: 36 * 3600 * 1000 });
  return Promise.all([
    read('О 14:00 ГАВ введені в повному обсязі (для 1-10 черг).').then((r) => assert.equal(r.active, true)),
    read('О 17:09 введено ГАВ для 6-10 черг.').then((r) => assert.equal(r.active, true)),
    read('О 10:28 додатково введено ГАВ для 6-10 черг.').then((r) => assert.equal(r.active, true)),
    read('Сьогодні не введено ГАВ, діють лише графіки погодинних відключень.').then((r) => assert.equal(r.active, false)),
    read('Про те, що таке ГАВ, ми розповідали вчора.').then((r) => assert.equal(r.active, false)),
    read('О 16:00 ГАВ скасовано.').then((r) => assert.equal(r.active, false))
  ]);
});
