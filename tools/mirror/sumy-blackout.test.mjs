import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEmergency } from './lib/dtek-emergency.mjs';
import { regionById } from './regions.mjs';

// A letter of 14 November 2026, 08:28: Сумська область, queue 6.1, the table has the light on until 18:00 and the light is off.
// At 06:58 the operator's channel had said «Маємо масштабне аварійне знеструмлення в частині Сумщини» — words the reader did not
// know, so nothing on the screen said the table might not hold. The posts are @SumyEnergo's own.

const post = (id, postedAt, text) => ({ id, postedAt, text });
const at = (iso) => new Date(iso);
const SUMY = regionById('sumy');
const hours = SUMY.emergencyTelegram.maxAgeHours;
const own = (posts, now) => readEmergency(posts, { now: at(now), area: 'own', maxAgeMs: hours * 3600 * 1000 });

const TAIL = ' ✅ Працюємо над відновленням розподілу електроенергії! 🔹 Інформацію щодо причин відключень за вашою адресою можна переглядати: ✅ в особистому кабінеті E-Svitlo; ✅ на сайті АТ "СУМИОБЛЕНЕРГО" у розділі "Відключення"; ✅ за номерами кол-центру: 0 800 300 247 або 0542 659 659.';
const P3776 = post(3776, '2026-10-22T15:02:00+00:00', `💡 Шановні споживачі електроенергії! Маємо аварійне знеструмлення.${TAIL}`);
const P3781 = post(3781, '2026-10-24T05:26:00+00:00', `💡 Шановні споживачі електроенергії! У частині Сумщини маємо знеструмлення через збройну агресію російської федерації.${TAIL}`);
const P3890 = post(3890, '2026-11-11T08:53:00+00:00', `💡 Шановні споживачі електроенергії! Маємо масштабне аварійне знеструмлення в частині Сумщини.${TAIL}`);
const P3897 = post(3897, '2026-11-13T07:59:00+00:00', `💡 Шановні споживачі електроенергії! Маємо масштабне знеструмлення в частині Сумщини через збройну агресію рф.${TAIL}`);
const P3901 = post(3901, '2026-11-13T19:02:00+00:00', 'Завтра, 14-11-2026, діятимуть графіки погодинних відключень відповідно до обсягів, доведених командою з НЕК "Укренерго". Переглянути актуальні ГПВ можна також: 1. На сайті АТ "СУМИОБЛЕНЕРГО" в розділі Споживачам-Відключення.');
const P3912 = post(3912, '2026-11-14T04:58:00+00:00', `💡 Шановні споживачі електроенергії! Маємо масштабне аварійне знеструмлення в частині Сумщини.${TAIL} Деталі не розголошуємо з безпекових міркувань.`);

test('«Маємо масштабне аварійне знеструмлення в частині Сумщини» is a warning, in the operator\'s words', () => {
  const morning = own([P3897, P3901, P3912], '2026-11-14T06:28:00Z');
  assert.equal(morning.active, true, 'the hour of the letter');
  assert.equal(morning.since, '2026-11-14T04:58:00+00:00');
  assert.equal(morning.note, 'масштабне аварійне знеструмлення в частині Сумщини');
  assert.equal(own([P3901], '2026-11-14T06:28:00Z').active, false, 'the evening post about tomorrow\'s table is nothing');
});

test('every way the channel has said it', () => {
  for (const [said, note] of [
    [P3776, 'аварійне знеструмлення'],
    [P3781, 'знеструмлення через збройну агресію російської федерації'],
    [P3890, 'масштабне аварійне знеструмлення в частині Сумщини'],
    [P3897, 'масштабне знеструмлення в частині Сумщини через збройну агресію рф']
  ]) {
    const reading = own([said], new Date(Date.parse(said.postedAt) + 30 * 60 * 1000).toISOString());
    assert.equal(reading.active, true, said.text.slice(0, 80));
    assert.equal(reading.note, note);
  }
});

test('it has no end said, so it stands for the region\'s own hours and no longer', () => {
  assert.equal(hours, 12);
  assert.equal(own([P3912], '2026-11-14T16:57:00Z').active, true);
  assert.equal(own([P3912], '2026-11-14T16:59:00Z').active, false, 'twelve hours on');
});

test('only on a channel of the operator\'s own', () => {
  const shared = post(1, '2026-11-14T04:58:00+00:00', 'Київщина: маємо знеструмлення в частині області через негоду.');
  assert.equal(readEmergency([shared], { now: at('2026-11-14T06:00:00Z'), area: 'oblast' }).active, false);
  assert.equal(readEmergency([shared], { now: at('2026-11-14T06:00:00Z'), area: 'own' }).active, true);
});

test('words about a blackout that are not an announcement of one', () => {
  const ongoing = post(3785, '2026-10-25T10:51:00+00:00', '💡 Шановні споживачі електроенергії! ❗️ Роботи з ліквідації наслідків ударів російської армії по енергетичних об’єктах на Сумщині тривають. ⏩ Станом на зараз частина споживачів усе ще залишається без електропостачання внаслідок учорашніх атак.');
  const explainer = post(3865, '2026-11-08T13:51:00+00:00', '💡 Чому у сусідів є світло, а у мене немає? Як розподіляються відключення? Світла немає понад добу, а будинок навпроти вже заживили?');
  assert.equal(own([ongoing], '2026-10-25T11:00:00Z').active, false);
  assert.equal(own([explainer], '2026-11-08T14:00:00Z').active, false);
});
