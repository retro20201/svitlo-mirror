import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePosts, parseGpvPost, scheduleFromPosts } from './lib/telegram.mjs';
import { kyivDayStart } from './lib/canonical.mjs';

// Every fixture below is a real post, copied verbatim out of what https://t.me/s/<channel>
// actually returned. Nothing here touches the network: the operators are out of season and would
// have nothing to say today anyway, so the hour parsing is pinned against the last one
// (Nov 2025 – Feb 2026), which is still readable in the channels' archives.

/**
 * A message as t.me/s/kharkivenergy serves it, with only the avatar image, the SVG bubble tail and
 * the reactions strip removed — everything the parser reads (the `data-post` id, the text div with
 * its entities and `<br/>`s, the footer `<time>`) is untouched.
 */
const KHARKIV_1485_HTML = `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="kharkivenergy/1485" data-view="eyJjIjotMjAwOTA3MTc0NSwicCI6MTQ4NSwidCI6MTc4NzkyOTg1OSwiaCI6ImIzM2MzZDg2ZDA2NzQ3NjMyYyJ9">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/kharkivenergy"><span dir="auto">Харківобленерго<i class="emoji" style="background-image:url('//telegram.org/img/emoji/40/E29AA1.png')"><b>⚡️</b></i>Новини</span></a></div>
<div class="tgme_widget_message_text js-message_text" dir="auto"><i class="emoji" style="background-image:url('//telegram.org/img/emoji/40/E280BC.png')"><b>‼️</b></i> Відповідно до розпорядження НЕК &quot;Укренерго&quot; з метою забезпечення стабільної роботи Об’єднаної енергосистеми у п&#39;ятницю, 7 листопада, у Харківській області будуть діяти графіки погодинних вимкнень (ГПВ).<br/><br/>З 08:00 до 21:00 застосовуватиметься 1 черга відключень. <br/><br/>Таким чином години відсутності електропостачання по чергам/підчергам з урахуванням часу на перемикання (орієнтовно):<br/><br/>1.1 10:00-14:00 <br/>1.2 10:00-14:00<br/>2.1, 2.2 не вимикаються<br/>3.1 14:00-17:00<br/>3.2 14:00-17:00<br/>4.1, 4.2 не вимикаються<br/>5.1 17:00-21:00<br/>5.2 17:00-21:00<br/>6.1 08:00-10:00<br/>6.2 08:00-10:00<br/><br/>Дізнатися свою підчергу можна <a href="https://t.me/kharkivenergy/1445" target="_blank" rel="noopener">тут</a>.<br/><br/>➡️ ДЛЯ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ з 08:00 до 22:00 діятимуть графіки обмеження потужності (ГОП). <br/><br/>⚠️ Ситуація в енергосистемі постійно змінюється, тож слідкуйте за оновленнями на офіційних ресурсах &quot;Харківобленерго&quot;.</div>
<div class="tgme_widget_message_footer compact js-message_footer">
  <div class="tgme_widget_message_info short js-message_info">
    <span class="tgme_widget_message_views">79.8K</span><span class="copyonly"> views</span><span class="tgme_widget_message_meta">edited &nbsp;<a class="tgme_widget_message_date" href="https://t.me/kharkivenergy/1485"><time datetime="2025-11-06T18:55:40+00:00" class="time">18:55</time></a></span>
  </div>
</div>
  </div>
</div></div>`;

const KHARKIV_1498 = {
  id: 1498,
  postedAt: "2025-11-08T18:34:26+00:00",
  text: `‼️⚡️ За вказівкою НЕК "Укренерго" у зв'язку зі складною ситуацією в Об’єднаній енергосистемі через ворожі обстріли у неділю, 9 листопада, з 00:00 до 24:00 у Харківській області будуть діяти графіки погодинних відключень (ГПВ). Застосовуватимуться одночасно 4 черги відключень. 

Години відсутності електропостачання по чергам/підчергам з урахуванням часу на перемикання (орієнтовно):

1.1 01:00-08:00; 11:00-18:00; 21:00-24:00
1.2 01:00-08:00; 11:00-18:00; 21:00-24:00
2.1 01:00-08:00; 11:00-18:00; 21:00-24:00
2.2 01:00-08:00; 11:00-18:00; 21:00-24:00
3.1 04:00-11:00; 15:00-21:00
3.2 04:00-11:00; 15:00-21:00
4.1 04:00-11:00; 15:00-21:00
4.2 04:00-11:00; 15:00-21:00
5.1 00:00-04:00; 08:00-14:00; 18:00-24:00
5.2 00:00-04:00; 08:00-14:00; 18:00-24:00
6.1 00:00-04:00; 08:00-14:00; 18:00-24:00
6.2 00:00-04:00; 08:00-14:00; 18:00-24:00

Перелік адрес за чергами - тут.

⚠️ Ситуація в енергосистемі постійно змінюється, тож слідкуйте за оновленнями на офіційних ресурсах "Харківобленерго".`
};

const KHARKIV_1604 = {
  id: 1604,
  postedAt: "2025-12-20T10:36:06+00:00",
  text: `‼️⚡️ За вказівкою НЕК "Укренерго" у зв'язку зі складною ситуацією в Об’єднаній енергосистемі, яка склалася через ворожі обстріли, у суботу, 20 грудня, з 00:00 до 24:00 у Харківській області діють графіки погодинних відключень (ГПВ). 

Години відсутності електропостачання по чергам/підчергам з урахуванням часу на перемикання (орієнтовно):

1.1 04:00-10:00; 10:30-14:00; 18:00-21:00
1.2 07:00:14:00; 18:00-21:00
2.1 07:00:10:30; 14:30-21:00
2.2 07:00:10:30; 14:30-21:00
3.1 00:00-03:30; 07:00:10:30; 14:30-17:30; 21:00-24:00
3.2 00:00-03:30; 07:00:10:30; 14:30-17:30; 21:00-24:00
4.1 00:00-03:30; 14:30-17:30; 18:00-24:00
4.2 00:00-03:30; 10:30-17:30; 18:00-24:00
5.1 04:00-07:00; 10:30-17:30
5.2 04:00-07:00; 10:30-14:00
6.1 00:00-07:00; 10:30-14:00; 21:00-24:00
6.2 00:00-07:00; 10:30-14:00; 21:00-22:00

Перелік адрес за чергами - тут.

➡️ ДЛЯ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ з 00:00 до 24:00 діятимуть графіки обмеження потужності (ГОП). 

⚠️ Ситуація в енергосистемі постійно змінюється, тож слідкуйте за оновленнями на офіційних ресурсах "Харківобленерго".`
};

const KHARKIV_1787 = {
  id: 1787,
  postedAt: "2026-02-16T20:12:56+00:00",
  text: `‼️⚡️ За вказівкою НЕК "Укренерго" у зв'язку зі складною ситуацією в Об’єднаній енергосистемі, яка склалася через ворожі обстріли, у вівторок, 17 січня, з 00:00 до 24:00 у Харківській області будуть діяти графіки погодинних відключень (ГПВ). 

Години відсутності електропостачання по чергам/підчергам з урахуванням часу на перемикання (орієнтовно):

1.1 00:00-01:30; 05:00-12:00; 15:30-22:30
1.2 01:30-06:00; 07:00-12:00; 15:30-22:30
2.1 01:30-06:00; 07:00-12:00; 15:30-22:30
2.2 01:30-05:00; 06:00-12:00; 15:30-22:30
3.1 01:30-05:00; 08:30-15:30; 19:00-22:00
3.2 01:30-05:00; 08:30-15:30; 19:00-22:00
4.1 00:00-05:00; 08:30-15:30; 19:00-22:00
4.2 00:00-05:00; 08:30-15:30; 19:00-24:00
5.1 00:00-01:30; 05:00-08:30; 12:00-19:00; 22:00-24:00
5.2 00:00-01:30; 05:00-08:30; 12:00-19:00; 22:00-24:00
6.1 00:00-01:30; 05:00-08:30; 12:00-19:00; 22:00-24:00
6.2 00:00-01:30; 05:00-08:30; 12:00-19:00; 22:00-24:00

Перелік адрес за чергами - тут.

➡️ ДЛЯ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ з 00:00 до 24:00 діятимуть графіки обмеження потужності (ГОП). 

⚠️ Ситуація в енергосистемі постійно змінюється, тож слідкуйте за оновленнями на офіційних ресурсах "Харківобленерго".`
};

const ZAPO_2582 = {
  id: 2582,
  postedAt: "2025-12-10T17:51:15+00:00",
  text: `11 ГРУДНЯ ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ ДІЯТИМУТЬ ГПВ
Відповідно до команди НЕК «Укренерго», з метою стабілізації ситуації в Об’єднанійх енергосистемі, 11 грудня по Запорізькій області будуть застосовані графіки погодинних відключень (ГПВ).
Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):
1.1: 03:00 - 08:00, 12:00 – 17:00, 21:00 – 24:00
1.2: 03:00 – 08:00, 12:00 – 17:00, 21:00 – 24:00
2.1: 00:00 - 03:30, 07:30 – 12:30, 16:30 – 21:30
2.2: 00:00 – 03:30, 07:30 – 12:30, 16:30 – 21:30
3.1: 03:00 – 08:00, 12:00 – 17:00, 21:00 – 24:00
3.2: 03:00 – 08:00, 12:00 – 17:00, 21:00 – 24:00
4.1: 00:00 – 03:30, 07:30 – 12:30, 16:30 – 21:30
4.2: 00:00 – 03:30, 07:30 – 12:30, 16:30 – 21:30
5.1: 03:00 – 08:00, 12:00 – 17:00, 21:00 – 24:00
5.2: 03:00 – 08:00, 12:00 – 17:00, 21:00 – 24:00
6.1: 00:00 – 03:30, 07:30 – 12:30, 16:30 – 21:30
6.2: 00:00 - 03:30, 07:30 – 12:30, 16:30 – 21:30
Також з 00:00 до 24:00 діятимуть графіки обмеження потужності (ГОП) в повному обсязі (5 черг).
УВАГА! НЕК «Укренерго»  попереджає: «час та обсяг застосування обмежень (прим. тобто, кількість черг, що мають вимикатися одночасно у певний проміжок доби) можуть змінитись».
Згідно з чинним законодавством, команди НЕК «Укренерго» є обов’язковими до виконання для операторів системи розподілу (обленерго). Тож, якщо матимемо нові вказівки від НЕК «Укренерго», відповідним чином перероблятимемо графік та інформуватимемо вас про зміни на наших інформаційних ресурсах протягом робочого дня та на нашому сайті на сторінці Стабілізаційні відключення у цілодобовому режимі.
Також на цій сторінці оприлюднені переліки адрес для кожної з черг та форми для мешканців м. Запоріжжя «Дізнатися свою чергу за адресою» та «Дізнатися причину відсутності електропостачання».`
};

const ZAPO_2584 = {
  id: 2584,
  postedAt: "2025-12-10T18:55:16+00:00",
  text: `ОНОВЛЕНО ГПВ НА 10 ГРУДНЯ
За вказівкою НЕК «Укренерго» оновлено ГПВ на 10 грудня.
Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):
1.1: 00:00 - 05:00, 09:00 – 14:00, 18:00 – 23:00
1.2: 00:00 – 05:00, 09:00 – 14:00, 18:00 – 23:00
2.1: 00:00 - 00:30, 05:30 – 09:30, 13:30 – 18:30, 22:30 – 24:00
2.2: 00:00 – 00:30, 04:30 – 09:30, 13:30 – 18:30, 22:30 – 24:00
3.1: 00:00 – 05:00, 09:00 – 14:00, 18:00 – 23:00
3.2: 00:00 – 05:00, 09:00 – 14:00, 18:00 – 23:00
4.1: 00:00 – 00:30, 04:30 – 09:30, 13:30 – 18:30, 22:30 – 24:00
4.2: 00:00 – 00:30, 04:30 – 09:30, 13:30 – 18:30, 22:30 – 24:00
5.1: 00:00 – 05:00, 09:00 – 14:00, 18:00 – 23:00
5.2: 00:00 – 05:00, 09:00 – 14:00, 18:00 – 23:00
6.1: 00:00 – 00:30, 04:30 – 09:30, 13:30 – 18:30, 22:30 - 24:00
6.2: 00:00 - 00:30, 04:30 – 09:30, 13:30 – 18:30, 22:30 - 24:00`
};

const ZAPO_2731 = {
  id: 2731,
  postedAt: "2026-01-10T18:04:30+00:00",
  text: `11 СІЧНЯ ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ ДІЯТИМУТЬ ГПВ
Відповідно до команди НЕК «Укренерго», з метою стабілізації ситуації в Об’єднаній енергосистемі, 11 січня по Запорізькій області будуть застосовані графіки погодинних відключень (ГПВ).
Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):
1.1: 00:00 – 00:30, 06:00 – 11:00, 15:00 – 20:00
1.2: 06:00 – 11:00, 15:00 – 20:00
2.1: 01:30 - 06:30, 10:30 – 15:30,  19:30 – 22:30
2.2: 04:30 - 06:30, 10:30 – 15:30,  19:30 – 24:00
3.1: 00:00 - 02;00, 06:00 – 11:00, 15:00 – 20:00
3.2: 00:00 – 02:00, 06:00 – 11:00, 15:00 – 20:00
4.1: 01:30 - 06:30, 10:30 – 15:30, 19:30 – 24:00
4.2: 10:30 – 15:30, 19:30 - 24:00
5.1: 00:00 – 00:30, 06:00 – 11:00, 15:00 – 20:00
5.2: 00:00 - 02:00, 07:30 – 11:00, 15:00 – 20:00
6.1: 04:30 - 06:30, 10:30 – 15:30, 19:30 – 24:00
6.2: 01:30 – 06:30, 10:30 – 15:30,  19:30 – 24:00
Також з 00:00 до 24:00 діятимуть графіки обмеження потужності (ГОП) в повному обсязі (5 черг).
Якщо матимемо нові вказівки від НЕК «Укренерго», відповідним чином перероблятимемо графік та інформуватимемо вас про зміни на наших інформаційних ресурсах протягом робочого дня та на нашому сайті на сторінці Стабілізаційні відключення у цілодобовому режимі.
Також на цій сторінці оприлюднені переліки адрес для кожної з черг та форми для мешканців м. Запоріжжя «Дізнатися свою чергу за адресою» та «Дізнатися причину відсутності електропостачання».`
};

const ZAPO_2396 = {
  id: 2396,
  postedAt: "2025-11-01T21:47:53+00:00",
  text: `02 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ ДІЯТИМУТЬ ГПВ
Відповідно до команди НЕК «Укренерго», з метою стабілізації ситуації в Об’єднаній енергосистемі, 02 листопада по Запорізькій області будуть застосовані графіки погодинних відключень (ГПВ). Одночасно вимикатимуться: з 08:00 до 11:00 та з 15:00 до 16:00 - 0,5 черги, з 19:00 до 22:00 - 1 черга, з 16:00 до 19:00 – 1,5 черги.
Години відсутності електропостачання по чергам (підчергам) (з урахуванням часу на перемикання):
1.1, 1.2:  не вимикається
2.1: не вимикається
2.2: 14:30 – 17:00
3.1: 17:00 – 19:30
3.2: 07:30 – 10:00
4.1: 17:00 – 20:30
4.2: 17:00 – 20:30
5.1: не вимикається
5.2: 10:00 – 11:30
6.1: 20:30 – 22:30
6.2: 20:30 – 22:30
Перелік адрес для кожної з черг
Дізнатися свою чергу за адресою (для м. Запоріжжя):

Також з 08:00 до 11:00 та з 15:00 до 22:00 діятимуть графіки обмеження потужності (ГОП) в повному обсязі (5 черг).

УВАГА! З 23:00 до 07:00 актуальні графіки - на нашому сайті`
};

const ZAPO_2895 = {
  id: 2895,
  postedAt: "2026-02-18T10:27:58+00:00",
  text: `У переліку адрес, залучених до ГПВ, відбулися зміни

Відповідно до розробленого Запорізькою ОВА переліку об’єктів критичної інфраструктури, що був оновлений згідно чинних законодавчих і нормативних актів та доведений до АТ «Запоріжжяобленерго», в переліку адрес, які беруть участь у Графіках погодинних відключень по Запорізькій області, відбулися певні зміни.

Будь ласка, перевірте свою адресу за посиланнями:
🔹Дізнатися свою чергу по м. Запоріжжя (за адресою)

✅Запорізький район:
🔹1.1
🔹1.2
🔹2.1
🔹2.2
🔹3.1
🔹3.2
🔹4.1
🔹4.2
🔹5.1
🔹5.2
🔹6.1
🔹6.2

УВАГА! За низкою адрес встановлені часові інтервали, протягом яких ГПВ не застосовуються*. Це пов’язано із графіком роботи об’єктів критичної інфраструктури, що знаходяться з ними на одній лінії.
*Для мешканців Запоріжжя ці інтервали відображаються у формі «Дізнатися свою чергу по м. Запоріжжя»`
};

const CHERKASY_1385 = {
  id: 1385,
  postedAt: "2026-01-31T19:49:14+00:00",
  text: `Через постійні ворожі обстріли та наслідки попередніх масованих ракетно-дронових атак по Черкаській області 1 лютого за командою НЕК «Укренерго» застосовуватимуться графіки погодинних вимкнень (ГПВ).

Години відсутності електропостачання:

1.1: 00:30 – 04:00, 06:00 – 10:00, 12:00 – 16:00, 18:00 – 22:00

1.2: 01:30 – 05:30, 07:30 – 11:30, 13:30 – 17:30, 19:30 – 22:30

2.1: 00:00 – 00:30, 03:00 – 06:30, 08:30 – 12:30, 14:30 – 18:30, 20:30 – 00:00 

2.2: 00:00 – 01:30, 04:00 – 07:30, 09:30 – 13:30, 15:30 – 19:30, 21:30 – 00:00 

3.1: 00:00 – 02:30, 05:00 – 08:30, 10:30 – 14:30, 16:30 – 20:00, 22:30 – 00:00

3.2: 00:00 – 01:00, 03:30 – 07:30, 09:30 – 13:30, 15:30 – 19:30, 21:30 – 00:00 

4.1: 02:30 – 06:00, 08:00 – 12:00, 14:00 – 18:00, 20:00 – 23:30

4.2: 00:00 – 03:00, 05:30 – 09:30, 11:30 – 15:30, 17:30 – 21:30, 23:30 – 00:00 

5.1: 00:00 – 02:00, 04:30 – 08:00, 10:00 – 14:00, 16:00 – 20:00, 22:00 – 00:00

5.2: 02:00 – 05:00, 07:30 – 11:30, 13:30 – 17:30, 19:30 – 23:30

6.1: 01:00 – 04:30, 06:30 – 10:30, 12:30 – 16:30, 18:30 – 22:00

6.2: 00:00 – 03:30, 06:00 – 09:30, 11:30 – 15:30, 17:30 – 21:30, 23:30 – 00:00

Перелік адрес, що знеструмлюються по чергах (підчергах) ГПВ можна переглянути за посиланням https://www.cherkasyoblenergo.com/off

Зверніть увагу, ситуація в енергосистемі може змінюватися, тому стежте за нашими оновленнями.`
};

const POLTAVA_3079 = {
  id: 3079,
  postedAt: "2025-11-16T06:43:52+00:00",
  text: `Зміни щодо відключень!

У зв'язку зі складною ситуацією в енергосистемі України, в Полтавській області 16 листопада 2025 року, отримана команда НЕК "Укренерго" з 9:00 до 10: 00 застосувати 2,5 черги ГПВ.`
};

/** Europe/Kyiv midnight for a plain `YYYY-MM-DD`, so expectations read as calendar days. */
function kyivDay(iso) {
  return kyivDayStart(new Date(`${iso}T12:00:00Z`));
}

function hoursOf(post, queue) {
  return parseGpvPost(post).queues[queue];
}

/** `{ 3: 'no', 4: 'no' }` → the hours that are anything but plain "світло є". */
function outageHours(hours) {
  return Object.fromEntries(Object.entries(hours).filter(([, state]) => state !== 'yes'));
}

test('a post is read out of the preview markup, entities and all', () => {
  const [post] = parsePosts(KHARKIV_1485_HTML, 'kharkivenergy');
  assert.equal(post.id, 1485);
  assert.equal(post.postedAt, '2025-11-06T18:55:40+00:00');
  // `&quot;`, `&#39;` and the `<a>` around "тут" all have to disappear without eating the text.
  assert.match(post.text, /розпорядження НЕК "Укренерго"/);
  assert.match(post.text, /у п'ятницю, 7 листопада/);
  assert.match(post.text, /^1\.1 10:00-14:00\s*$/m);
  assert.match(post.text, /Дізнатися свою підчергу можна тут\./);
});

test('the day a post is about is the day it names, not the day it was posted', () => {
  const [post] = parsePosts(KHARKIV_1485_HTML, 'kharkivenergy');
  // Posted late on 6 листопада, for 7 листопада.
  assert.equal(parseGpvPost(post).epoch, kyivDay('2025-11-07'));
});

test('a queue named twice on one row is idle in both halves of it', () => {
  const [post] = parsePosts(KHARKIV_1485_HTML, 'kharkivenergy');
  // "2.1, 2.2 не вимикаються" — a merged row, and a statement, not an absence of data.
  const parsed = parseGpvPost(post);
  assert.deepEqual(outageHours(parsed.queues['GPV2.1']), {});
  assert.deepEqual(outageHours(parsed.queues['GPV2.2']), {});
  assert.deepEqual(outageHours(parsed.queues['GPV4.1']), {});
  // ...while the queues that do switch off still do.
  assert.deepEqual(outageHours(parsed.queues['GPV1.1']), { 11: 'no', 12: 'no', 13: 'no', 14: 'no' });
  assert.deepEqual(outageHours(parsed.queues['GPV6.1']), { 9: 'no', 10: 'no' });
});

test('semicolon-separated ranges ending at 24:00', () => {
  // 1.1 01:00-08:00; 11:00-18:00; 21:00-24:00
  const parsed = parseGpvPost(KHARKIV_1498);
  assert.equal(parsed.epoch, kyivDay('2025-11-09'));
  assert.deepEqual(outageHours(parsed.queues['GPV1.1']), {
    2: 'no', 3: 'no', 4: 'no', 5: 'no', 6: 'no', 7: 'no', 8: 'no',
    12: 'no', 13: 'no', 14: 'no', 15: 'no', 16: 'no', 17: 'no', 18: 'no',
    22: 'no', 23: 'no', 24: 'no'
  });
  // 5.1 00:00-04:00; 08:00-14:00; 18:00-24:00 — a window that starts at midnight, not ends there.
  const midnight = outageHours(parsed.queues['GPV5.1']);
  assert.equal(midnight['1'], 'no');
  assert.equal(midnight['5'], undefined);
});

test('a dash typed as a colon still reads as a range', () => {
  // 1.2 07:00:14:00; 18:00-21:00 — Харківобленерго, 20 грудня 2025.
  assert.deepEqual(outageHours(hoursOf(KHARKIV_1604, 'GPV1.2')), {
    8: 'no', 9: 'no', 10: 'no', 11: 'no', 12: 'no', 13: 'no', 14: 'no',
    19: 'no', 20: 'no', 21: 'no'
  });
});

test('a semicolon typed inside a time still reads as a time', () => {
  // 3.1: 00:00 - 02;00, 06:00 – 11:00, 15:00 – 20:00 — Запоріжжяобленерго, 11 січня 2026.
  assert.deepEqual(outageHours(hoursOf(ZAPO_2731, 'GPV3.1')), {
    1: 'no', 2: 'no',
    7: 'no', 8: 'no', 9: 'no', 10: 'no', 11: 'no',
    16: 'no', 17: 'no', 18: 'no', 19: 'no', 20: 'no'
  });
  // ...and the ';' that separates two ranges is still a separator.
  assert.deepEqual(outageHours(hoursOf(KHARKIV_1498, 'GPV3.1')), {
    5: 'no', 6: 'no', 7: 'no', 8: 'no', 9: 'no', 10: 'no', 11: 'no',
    16: 'no', 17: 'no', 18: 'no', 19: 'no', 20: 'no', 21: 'no'
  });
});

test('half-hour boundaries survive as first/second-half codes', () => {
  // 1.1: 00:00 – 00:30 … and 2.1: 01:30 - 06:30, 10:30 – 15:30, 19:30 – 22:30
  assert.equal(hoursOf(ZAPO_2731, 'GPV1.1')['1'], 'first');
  assert.deepEqual(outageHours(hoursOf(ZAPO_2731, 'GPV2.1')), {
    2: 'second', 3: 'no', 4: 'no', 5: 'no', 6: 'no', 7: 'first',
    11: 'second', 12: 'no', 13: 'no', 14: 'no', 15: 'no', 16: 'first',
    20: 'second', 21: 'no', 22: 'no', 23: 'first'
  });
});

test('a day closed with 00:00 means midnight, not an empty range', () => {
  // Черкасиобленерго write the last window of 1 лютого as "20:30 – 00:00".
  const parsed = parseGpvPost(CHERKASY_1385);
  assert.equal(parsed.epoch, kyivDay('2026-02-01'));
  assert.deepEqual(outageHours(parsed.queues['GPV2.1']), {
    1: 'first', 4: 'no', 5: 'no', 6: 'no', 7: 'first',
    9: 'second', 10: 'no', 11: 'no', 12: 'no', 13: 'first',
    15: 'second', 16: 'no', 17: 'no', 18: 'no', 19: 'first',
    21: 'second', 22: 'no', 23: 'no', 24: 'no'
  });
});

test('"не вимикається" merged onto one row, singular', () => {
  // "1.1, 1.2:  не вимикається" — same statement as Харків's plural, two spaces after the colon.
  const parsed = parseGpvPost(ZAPO_2396);
  assert.equal(parsed.epoch, kyivDay('2025-11-02'));
  assert.deepEqual(outageHours(parsed.queues['GPV1.1']), {});
  assert.deepEqual(outageHours(parsed.queues['GPV1.2']), {});
  assert.deepEqual(outageHours(parsed.queues['GPV2.2']), { 15: 'second', 16: 'no', 17: 'no' });
});

test('a queue label on a colon-terminated row is not mistaken for a time', () => {
  // The repair for "з 06: 00" must not turn "2.1: 06:00 – 09:30" into the time "1:06". This is the
  // regression that rule buys, since the stray space itself only ever shows up in prose.
  assert.deepEqual(outageHours(hoursOf(ZAPO_2396, 'GPV3.2')), { 8: 'second', 9: 'no', 10: 'no' });
});

test('the newest post is not the newest table for a given day', () => {
  // Запоріжжя posted 11 грудня's plan at 17:51 and then amended 10 грудня's at 18:55. Reading the
  // last post as "today" would file yesterday's amendment as tomorrow.
  const schedule = scheduleFromPosts([ZAPO_2582, ZAPO_2584], { since: 0 });
  assert.deepEqual(Object.keys(schedule.fact).map(Number).sort(), [
    kyivDay('2025-12-10'), kyivDay('2025-12-11')
  ]);
  // 10 грудня, 2.1: 00:00 - 00:30, 05:30 – 09:30, 13:30 – 18:30, 22:30 – 24:00
  assert.deepEqual(outageHours(schedule.fact[kyivDay('2025-12-10')]['GPV2.1']), {
    1: 'first', 6: 'second', 7: 'no', 8: 'no', 9: 'no', 10: 'first',
    14: 'second', 15: 'no', 16: 'no', 17: 'no', 18: 'no', 19: 'first',
    23: 'second', 24: 'no'
  });
  // 11 грудня, 2.1: 00:00 - 03:30, 07:30 – 12:30, 16:30 – 21:30
  assert.deepEqual(outageHours(schedule.fact[kyivDay('2025-12-11')]['GPV2.1']), {
    1: 'no', 2: 'no', 3: 'no', 4: 'first',
    8: 'second', 9: 'no', 10: 'no', 11: 'no', 12: 'no', 13: 'first',
    17: 'second', 18: 'no', 19: 'no', 20: 'no', 21: 'no', 22: 'first'
  });
  assert.equal(schedule.update, '2025-12-10T18:55:16+00:00');
});

test('a day already published is only replaced by a later post for that same day', () => {
  const before = scheduleFromPosts([ZAPO_2582], { since: 0 });
  const after = scheduleFromPosts([ZAPO_2582, ZAPO_2584], { since: 0 });
  assert.deepEqual(
    after.fact[kyivDay('2025-12-11')],
    before.fact[kyivDay('2025-12-11')]
  );
});

test('days older than the cutoff are dropped rather than accumulated', () => {
  assert.deepEqual(scheduleFromPosts([ZAPO_2582, ZAPO_2584]).fact, {});
});

test('queue keys are reported so a region can be named out of season', () => {
  const schedule = scheduleFromPosts([KHARKIV_1498], { since: 0 });
  assert.deepEqual(schedule.queues, [
    'GPV1.1', 'GPV1.2', 'GPV2.1', 'GPV2.2', 'GPV3.1', 'GPV3.2',
    'GPV4.1', 'GPV4.2', 'GPV5.1', 'GPV5.2', 'GPV6.1', 'GPV6.2'
  ]);
});

test('nothing to read is an empty schedule, not a failure', () => {
  assert.deepEqual(scheduleFromPosts([]), { fact: {}, queues: [], update: null });
});

test('an address list carrying queue labels is not a schedule', () => {
  // Twelve lines reading "🔹1.1" … "🔹6.2", and not one hour among them.
  assert.equal(parseGpvPost(ZAPO_2895), null);
});

test('an aggregate "N черг" announcement is not a schedule', () => {
  // Полтаваобленерго only ever publish the count of queues switching together — never which hours
  // apply to which subqueue. There is nothing here for the app to show.
  assert.equal(parseGpvPost(POLTAVA_3079), null);
  assert.match(POLTAVA_3079.text, /2,5 черги/);
});

test('a post naming a day a month away is treated as a typo, not as that day', () => {
  // Харків announced 17 лютого 2026 as "у вівторок, 17 січня". Filing a table under the wrong day
  // is worse than filing none.
  assert.equal(parseGpvPost(KHARKIV_1787), null);
});
