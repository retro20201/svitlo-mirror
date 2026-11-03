import test from 'node:test';
import assert from 'node:assert/strict';
import { readEmergency } from './lib/dtek-emergency.mjs';
import { withChannelEmergency } from './sources/dtek.mjs';
import { kyivDayStart } from './lib/canonical.mjs';
import { REGIONS } from './regions.mjs';

// @pat_cherkasyoblenergo, 1–3 November 2026, in the operator's words (the tables shortened to their first rows).
const post = (id, postedAt, text) => ({ id, postedAt, text });
const ORDER = 'Через наслідки попередніх масованих ракетно-дронових атак';
const POSTS = [
  post(1938, '2026-11-01T17:21:02+00:00', 'Відповідно до команди НЕК "Укренерго" для промисловості та бізнесу Черкаської області 2 листопада з 06:00 до 24:00 будуть застосовані графіки обмеження потужності (ГОП).'),
  post(1939, '2026-11-01T18:26:08+00:00', 'Через постійні ворожі обстріли та наслідки попередніх ракетно-дронових атак за розпорядженням НЕК «Укренерго» 2 листопада з 06:00 до 24:00 у Черкаській області будуть застосовані графіки погодинних відключень (ГПВ).\n\nГодини відсутності електропостачання:\n\n1.1 00:00 - 02:00, 06:00 - 08:00'),
  post(1940, '2026-11-02T06:56:31+00:00', `${ORDER} 2 листопада з 08:52 по Черкаській області застосовані графіки аварійних відключень (ГАВ) за командою НЕК "Укренерго".\n\nТакож продовжують діяти графіки погодинних відключень (ГПВ).\n\nПросимо з розумінням поставитися до вжитих заходів, спрямованих на збереження енергосистеми України.`),
  post(1941, '2026-11-02T12:59:51+00:00', '💡У мене пропало світло поза графіком. Хто і коли його поверне?\n\nПричини можуть бути різними. Також через роботу в критичних умовах в електромережах можуть відбуватись технічні аварії.'),
  post(1949, '2026-11-02T20:30:49+00:00', 'Через постійні ворожі обстріли та наслідки попередніх ракетно-дронових атак за розпорядженням НЕК «Укренерго» 3 листопада з 00:00 до 24:00 у Черкаській області будуть застосовані графіки погодинних відключень (ГПВ).\n\nГодини відсутності електропостачання:\n\n1.1 00:00 - 02:00, 06:00 - 08:00'),
  post(1950, '2026-11-03T00:54:56+00:00', 'Оновлення графіка погодинних відключень (ГПВ) на 3 листопада\n\nГодини відсутності електропостачання:\n\n1.1 04:00 - 08:00, 10:00 - 14:00, 16:00 - 20:00'),
  post(1951, '2026-11-03T01:18:29+00:00', `${ORDER} 3 листопада з 03:16 по Черкаській області застосовані графіки аварійних відключень (ГАВ) за командою НЕК "Укренерго".\n\nТакож продовжують діяти графіки погодинних відключень (ГПВ).`)
];
const at = (iso) => new Date(iso);
const own = (now, posts = POSTS) => readEmergency(posts, { now: at(now), area: 'own' });

test('«застосовані графіки аварійних відключень (ГАВ)» is on from the post that says so', () => {
  const during = own('2026-11-03T06:20:00Z');
  assert.equal(during.active, true);
  assert.equal(during.since, '2026-11-03T01:18:29+00:00');
  assert.equal(during.note, null, 'the whole oblast: no districts to name');
});

test('the same words on the day before count as well, and are believed for twelve hours', () => {
  assert.equal(own('2026-11-02T10:00:00Z').active, true);
  assert.equal(own('2026-11-02T18:00:00Z').active, true, '11 h 04 min after the post');
  assert.equal(own('2026-11-02T20:00:00Z').active, false, '13 h after, with nothing to renew it');
});

test('before the post, and on the evening of the 1st, the schedule stands alone', () => {
  assert.equal(own('2026-11-02T06:00:00Z').active, false);
  assert.equal(own('2026-11-01T19:00:00Z').active, false);
});

test('schedule posts, a limit for business and an explainer are no orders', () => {
  const quiet = POSTS.filter((p) => ![1940, 1951].includes(p.id));
  assert.equal(own('2026-11-03T06:20:00Z', quiet).active, false);
});

test('the operator saying the ГАВ are over ends them', () => {
  const over = [...POSTS, post(1952, '2026-11-03T04:30:00+00:00', 'Графіки аварійних відключень (ГАВ) скасовано. Продовжують діяти ГПВ.')];
  assert.equal(own('2026-11-03T04:00:00Z', over).active, true);
  assert.equal(own('2026-11-03T05:00:00Z', over).active, false);
  const lifted = [...POSTS, post(1953, '2026-11-03T04:30:00+00:00', 'Скасовано графіки аварійних відключень, діють лише ГПВ.')];
  assert.equal(own('2026-11-03T05:00:00Z', lifted).active, false);
});

test('Черкащина puts today into fact.emergency and leaves the table as the operator published it', async () => {
  const now = at('2026-11-03T06:20:00Z');
  const today = kyivDayStart(now);
  const region = REGIONS.find((r) => r.id === 'cherkasy');
  assert.deepEqual(region.emergencyTelegram, { area: 'own' });
  const snapshot = { regionId: 'cherkasy', fact: { data: { [today]: { 'GPV2.1': { 5: 'no' } } }, update: '03.11.2026 02:54' } };
  const read = async ({ area, now: when }) => readEmergency(POSTS, { area, now: when });
  const result = await withChannelEmergency(structuredClone(snapshot), region, { read, now, log: () => {} });
  assert.deepEqual(result.fact.emergency, [today]);
  assert.deepEqual(result.fact.data, snapshot.fact.data);
  assert.equal('emergencyNote' in result.fact, false);
});
