import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// Spring 2026 onward: tables that list only the subqueues switched off, the stacked "⚡ Черга"
// layout, revisions that restate only what is still ahead, posts edited in place, and withdrawals.
// Verbatim from the channels' public preview pages (link and messenger footers dropped).

const KHARKIV_1862 = {
  id: 1862,
  postedAt: '2026-03-12T19:27:22+00:00',
  text: `‼️⚡️ За вказівкою НЕК "Укренерго" у зв'язку зі складною ситуацією в Об’єднаній енергосистемі, яка склалася через ворожі обстріли, у п'ятницю, 13 березня, з 17:00 до 22:00 у Харківській області будуть діяти графіки погодинних відключень (ГПВ). 

Години відсутності електропостачання по чергам/підчергам з урахуванням часу на перемикання (орієнтовно):

2.1 20:30-22:00
2.2 20:30-22:00
5.1 17:00-20:30
5.2 17:00-20:30

Перелік адрес за чергами - тут.

➡️ ДЛЯ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ з 17:00 до 23:00 діятимуть графіки обмеження потужності (ГОП). 

⚠️ Ситуація в енергосистемі постійно змінюється, тож слідкуйте за оновленнями на офіційних ресурсах "Харківобленерго".`
};

const KHARKIV_1467 = {
  id: 1467,
  postedAt: '2025-10-30T06:34:31+00:00',
  text: `‼️⚡️ Увага! У Харківській області графіки аварійних відключень замінено на графіки погодинних вимкнень

Відповідно до команди НЕК "Укренерго" для стабілізації ситуації в Об'єднаній енергосистемі будуть вимикатися одночасно:

08:00-10:00 - 1,5 черги, 
10:00-14:00 - 1 черга
14:00-19:00 - 2 черги.

Години відсутності електропостачання по чергам/підчергам з урахуванням часу на перемикання (орієнтовно):

1.1 14:00-16:00
1.2 14:00-16:00
2.1 14:00-16:00
2.2 14:00-16:00
3.1 16:00-19:00
3.2 8:00-10:00, 16:00-19:00
4.1 8:00-10:00
4.2 8:00-10:00
5.1, 5.2 не вимикаються
6.1 10:00-14:00
6.2 10:00-14:00

Перелік адрес за чергами - у прикріпленому повідомленні.

➡️ ДЛЯ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ з 08:00 до 19:00 будуть діяти графіки обмеження потужності (ГОП).

⚠️ Ситуація в енергосистемі постійно змінюється, тож слідкуйте за оновленнями на офіційних ресурсах "Харківобленерго".`
};

const KHARKIV_1469 = {
  id: 1469,
  postedAt: '2025-10-30T08:32:26+00:00',
  text: `‼️⚡️ Оновлено! Графіки погодинних відключень у Харківській області скасовано до 14:00

☝️ Будьте уважні: ситуація в енергосистемі постійно змінюється. Слідкуйте за оновленнями на офіційних ресурсах АТ "Харківобленерго".`
};

const ZAPO_3087 = {
  id: 3087,
  postedAt: '2026-04-09T17:26:01+00:00',
  text: `За командою НЕК "Укренерго" оновлено ГПВ на 09 квітня:

⚡ Черга 1.1
 з 09:00 до 14:00

⚡ Черга 1.2
 з 18:00 до 22:30

⚡ Черга 2.1
 з 13:30 до 18:30

⚡ Черга 2.2
 з 13:30 до 16:30
 з 23:30 до 24:00

⚡ Черга 3.1
 з 18:00 до 22:30

⚡ Черга 3.2
 з 08:30 до 13:30

⚡ Черга 4.1
 з 13:30 до 18:30

⚡ Черга 4.2
 з 13:30 до 18:30

⚡ Черга 5.1
 з 09:00 до 10:30
 з 18:00 до 22:30

⚡ Черга 5.2
 з 09:00 до 14:00

⚡ Черга 6.1
 з 06:30 до 09:30
 з 23:30 до 24:00

⚡ Черга 6.2
 з 06:30 до 09:30
 з 18:30 до 22:30

⚡ Черга 6.1
 з 06:30 до 09:30
 з 23:30 до 24:00

⚡ Черга 6.2
 з 06:30 до 09:30
 з 18:30 до 22:30`
};

const ZAPO_3085 = {
  id: 3085,
  postedAt: '2026-04-09T06:23:43+00:00',
  text: `ОНОВЛЕНО о 20:20
За вказівкою НЕК “Укренерго” оновлено ГПВ на 9 квітня.

Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):

1.1: 09:00 - 14:00
1.2: 18:00 - 22:30
2.1: 13:30 - 18:30
2.2: 13:30 - 16:30, 23:30 - 24:00
3.1: 18:00 - 22:30
3.2: 08:30 - 13:30
4.1: 13:30 - 18:30
4.2: 13:30 - 18:30
5.1: 09:00 - 10:30, 18:00 - 22:30
5.2: 09:00 - 14:00
6.1: 06:30 - 09:30, 23:30 - 24:00
6.2: 06:30 - 09:30, 18:30 - 22:30`
};

const ZAPO_3084 = {
  id: 3084,
  postedAt: '2026-04-09T05:28:51+00:00',
  text: `За вказівкою НЕК “Укренерго” оновлено ГПВ на 9 квітня.

Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):

1.1: 09:00 - 11:30
1.2: 18:00 - 22:30
3.1: 18:00 - 22:30
3.2: 08:30 - 11:30
4.1: 13:30 - 18:30
4.2: 14:30 - 18:30
5.2: 09:00 - 14:00
6.1: 06:30 - 09:30
6.2: 06:30 - 09:30`
};

const ZAPO_3317 = {
  id: 3317,
  postedAt: '2026-07-01T11:58:33+00:00',
  text: `За вказівкою НЕК “Укренерго” оновлено ГПВ на 01 липня.

Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):

2.2: 17:30 - 19:30
4.1: 19:00 - 22:00`
};

const ZAPO_3318 = {
  id: 3318,
  postedAt: '2026-07-01T14:32:03+00:00',
  text: `За вказівкою НЕК “Укренерго” оновлено ГПВ на 01 липня.

Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):

4.1: 19:00 - 22:00`
};

const ZAPO_3314 = {
  id: 3314,
  postedAt: '2026-06-30T17:37:32+00:00',
  text: `Відповідно до команди НЕК «Укренерго», з метою стабілізації ситуації в Об’єднаній енергосистемі, 01 липня по Запорізькій області будуть застосовані графіки погодинних відключень (ГПВ).

Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):

2.2: 16:30 - 19:30
3.1: 16:30 - 19:30
3.2: 19:00 - 22:00
4.1: 19:00 - 22:00

Також з 17:00 до 22:00 діятимуть графіки обмеження потужності (ГОП) в повному обсязі (5 черг).

Перелік адрес для кожної черги на нашому сайті на сторінці Стабілізаційні відключення`
};

const ZAPO_3057 = {
  id: 3057,
  postedAt: '2026-03-31T17:38:52+00:00',
  text: `За інформацією НЕК "укренерго", завтра, 01 квітня, по Запорізькій області застосування графіків погодинних відключень (ГПВ) не заплановано.
З 12:00 до 17:00 для промисловості та бізнесу діятимуть графіки обмеження потужності (ГОП) у повному обсязі (п'ять черг).`
};

const CHERKASY_1627 = {
  id: 1627,
  postedAt: '2026-04-09T15:52:15+00:00',
  text: `Оновлений графік погодинних вимкнень на 9 квітня за командою НЕК «Укренерго». 

Години відсутності електропостачання: 

1.1 21:00 - 22:00

1.2 21:00 - 22:00

2.1 17:00 - 19:00

2.2 19:00 - 21:00

3.1 21:00 - 22:00

3.2 19:00 - 21:00

4.2 21:00 - 22:00

5.1 17:00 - 19:00

5.2 17:00 - 19:00

6.1 19:00 - 21:00

6.2 19:00 - 21:00

Перелік адрес, що знеструмлюються по чергах (підчергах) ГПВ можна переглянути за посиланням https://www.cherkasyoblenergo.com/off 

Причина застосування обмежень – наслідки російських ракетно-дронових атак на енергооб’єкти. Зверніть увагу, ситуація в енергосистемі може змінюватися, тому стежте за нашими оновленнями.
`
};

const CHERKASY_1631 = {
  id: 1631,
  postedAt: '2026-04-09T18:01:09+00:00',
  text: `Оновлений графік погодинних вимкнень на 9 квітня за командою НЕК «Укренерго». 

Години відсутності електропостачання: 

1.1 21:00 - 23:00

1.2 21:00 - 23:00

3.1 21:00 - 23:00

4.1 23:00 - 24:00

5.1 23:00 - 24:00

5.2 23:00 - 24:00

Перелік адрес, що знеструмлюються по чергах (підчергах) ГПВ можна переглянути за посиланням https://www.cherkasyoblenergo.com/off 

Причина застосування обмежень – наслідки російських ракетно-дронових атак на енергооб’єкти. Зверніть увагу, ситуація в енергосистемі може змінюватися, тому стежте за нашими оновленнями.
`
};

// Кропивницький (@SvitloKropyvnytskyiMisto): whole hours, "-" for a subqueue that stays on, and
// the day in digits only.

const KROP_1391 = {
  id: 1391,
  postedAt: '2026-02-04T18:53:15+00:00',
  text: `⚠ 05.02.2026 - Графік погодинних відключень

За розпорядженням НЕК "Укренерго" 05.02.2026 буде діяти наступний графік погодинних відключень (ГПВ):

Черга 1.1: 00-01, 02-04, 06-09, 10-13, 14-17, 18-20, 22-24
Черга 1.2: 02-05, 06-08, 10-13, 14-17, 18-21, 22-24
Черга 2.1: 02-04, 06-09, 10-13, 14-17, 18-20, 22-24
Черга 2.2: 02-04, 06-08, 09-12, 13-16, 17-20, 21-24
Черга 3.1: 02-04, 05-08, 09-12, 13-16, 17-20, 22-24
Черга 3.2: 01-04, 06-08, 10-12, 13-16, 17-20, 22-24
Черга 4.1: 00-03, 04-06, 08-11, 12-15, 16-19, 20-22
Черга 4.2: 00-02, 04-07, 08-11, 12-15, 16-19, 20-22
Черга 5.1: 00-02, 04-07, 08-10, 12-15, 16-19, 20-23
Черга 5.2: 00-02, 03-06, 08-10, 11-14, 15-18, 19-22
Черга 6.1: 00-02, 04-06, 07-10, 12-14, 15-18, 19-22, 23-24
Черга 6.2: 00-02, 04-06, 07-10, 11-14, 15-18, 19-22

ПрАТ "Кіровоградобленерго" вкотре нагадує щодо необхідності раціонального споживання електроенергії.`
};

const KROP_1700 = {
  id: 1700,
  postedAt: '2026-06-29T17:51:07+00:00',
  text: `⚡ 
За розпорядженням НЕК "Укренерго" 30.06.2026 буде застосовано  графік погодинних відключень (ГПВ):

Черга 1.1: 17-18
Черга 1.2: -
Черга 2.1: -
Черга 2.2: 20-22
Черга 3.1: -
Черга 3.2: -
Черга 4.1: 18-20
Черга 4.2: 18-20
Черга 5.1: -
Черга 5.2: -
Черга 6.1: -
Черга 6.2: -`
};

const KROP_1702 = {
  id: 1702,
  postedAt: '2026-06-30T13:28:49+00:00',
  text: `⚡ Зміни на 16:28 30.06.2026 до графіка погодинних відключень

За розпорядженням НЕК "Укренерго" 30.06.2026 внесено зміни до графіка погодинних відключень (ГПВ):

Черга 1.1: -
Черга 1.2: -
Черга 2.1: -
Черга 2.2: 20-22
Черга 3.1: -
Черга 3.2: -
Черга 4.1: 18-20
Черга 4.2: 19-20
Черга 5.1: -
Черга 5.2: -
Черга 6.1: -
Черга 6.2: -`
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
  assert.deepEqual(scheduleFromPosts([]), { fact: {}, halves: {}, queues: [], update: null });
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

test('a table listing only the switched-off subqueues is a whole day', () => {
  // Харків, 13 березня 2026: four rows under the usual header. The other eight subqueues are not
  // missing — they stay on, and say so, rather than reading as "no schedule for this queue".
  const parsed = parseGpvPost(KHARKIV_1862);
  assert.equal(parsed.epoch, kyivDay('2026-03-13'));
  assert.equal(Object.keys(parsed.queues).length, 12);
  assert.deepEqual(outageHours(parsed.queues['GPV2.1']), { 21: 'second', 22: 'no' });
  assert.deepEqual(outageHours(parsed.queues['GPV5.2']), { 18: 'no', 19: 'no', 20: 'no', 21: 'first' });
  assert.deepEqual(outageHours(parsed.queues['GPV1.1']), {});
});

test('a stacked "⚡ Черга" table reads like any other', () => {
  // Запоріжжя, 9 квітня 2026, 20:26: label on one line, "з 13:30 до 16:30" under it, no header.
  const parsed = parseGpvPost(ZAPO_3087);
  assert.equal(parsed.epoch, kyivDay('2026-04-09'));
  assert.deepEqual(outageHours(parsed.queues['GPV2.2']), {
    14: 'second', 15: 'no', 16: 'no', 17: 'first', 24: 'second'
  });
  assert.deepEqual(outageHours(parsed.queues['GPV1.1']), { 10: 'no', 11: 'no', 12: 'no', 13: 'no', 14: 'no' });
});

test('a revision speaks from the moment it goes out', () => {
  // Черкаси, 9 квітня 2026. At 18:52 the day still had 5.1 17:00–19:00 and 4.2 21:00–22:00; the
  // 21:01 revision lists only what is ongoing or ahead — no 5.1 morning, no 4.2 at all.
  const day = scheduleFromPosts([CHERKASY_1627, CHERKASY_1631], { since: 0 }).fact[kyivDay('2026-04-09')];
  // Already happened, so the revision's silence about it does not erase it...
  assert.deepEqual(outageHours(day['GPV5.1']), { 18: 'no', 19: 'no', 24: 'no' });
  // ...but a window still ahead that the revision leaves out is withdrawn.
  assert.deepEqual(outageHours(day['GPV4.2']), {});
  assert.deepEqual(outageHours(day['GPV1.1']), { 22: 'no', 23: 'no' });
  assert.deepEqual(outageHours(day['GPV4.1']), { 24: 'no' });
});

test('revisions that drop subqueues switch them back on from then', () => {
  // Запоріжжя, 1 липня 2026: four subqueues the evening before, two at 14:58, one at 17:32.
  const day = scheduleFromPosts([ZAPO_3314, ZAPO_3317, ZAPO_3318], { since: 0 }).fact[kyivDay('2026-07-01')];
  assert.deepEqual(outageHours(day['GPV3.2']), {});
  assert.deepEqual(outageHours(day['GPV2.2']), {});
  assert.deepEqual(outageHours(day['GPV4.1']), { 20: 'no', 21: 'no', 22: 'no' });
});

test('a post edited in place counts from its edit, in force from when it went out', () => {
  // #3085 went out at 09:23 and was edited to the 20:20 version. That version, not 08:28's 1.1
  // 09:00–11:30, is the operator's word for the hours after 09:23.
  const schedule = scheduleFromPosts([ZAPO_3084, ZAPO_3085], { since: 0 });
  assert.deepEqual(outageHours(schedule.fact[kyivDay('2026-04-09')]['GPV1.1']), {
    10: 'no', 11: 'no', 12: 'no', 13: 'no', 14: 'no'
  });
  assert.equal(schedule.update, '2026-04-09T17:20:00.000Z');
});

test('a dateless same-day table, then hours cancelled until a stated time', () => {
  // Харків, 30 жовтня 2025: ГАВ "замінено на графіки погодинних" at 08:34 with no date, then at
  // 10:32 "скасовано до 14:00". 6.1 had 10:00–14:00: only the half-hour already gone stays off.
  const day = scheduleFromPosts([KHARKIV_1467, KHARKIV_1469], { since: 0 }).fact[kyivDay('2025-10-30')];
  assert.deepEqual(outageHours(day['GPV6.1']), { 11: 'first' });
  assert.deepEqual(outageHours(day['GPV3.2']), {
    9: 'no', 10: 'no', 17: 'no', 18: 'no', 19: 'no'
  });
  assert.deepEqual(outageHours(day['GPV1.1']), { 15: 'no', 16: 'no' });
});

test('"не заплановано" withdraws hours, and alone publishes nothing', () => {
  // Запоріжжя, 31 березня 2026: no ГПВ tomorrow. With no table for that day there is nothing to
  // take back, and an empty day says the same as no day.
  assert.deepEqual(parseGpvPost(ZAPO_3057).withdrawn, { until: 48 });
  assert.deepEqual(scheduleFromPosts([ZAPO_3057], { since: 0 }).fact, {});
});

test('whole hours, a digits-only date, and "-" for a subqueue that stays on', () => {
  // Кропивницький, 5 лютого 2026: "Черга 1.1: 00-01, 02-04, 06-09, …".
  const parsed = parseGpvPost(KROP_1391);
  assert.equal(parsed.epoch, kyivDay('2026-02-05'));
  assert.deepEqual(outageHours(parsed.queues['GPV1.1']), {
    1: 'no', 3: 'no', 4: 'no', 7: 'no', 8: 'no', 9: 'no', 11: 'no', 12: 'no', 13: 'no',
    15: 'no', 16: 'no', 17: 'no', 19: 'no', 20: 'no', 23: 'no', 24: 'no'
  });
  // 30 червня 2026: "Черга 1.2: -" is a statement, so the table counts its row.
  const june = parseGpvPost(KROP_1700);
  assert.equal(june.epoch, kyivDay('2026-06-30'));
  assert.deepEqual(outageHours(june.queues['GPV1.2']), {});
  assert.deepEqual(outageHours(june.queues['GPV4.1']), { 19: 'no', 20: 'no' });
});

test('a Кропивницький revision restating the day takes over from when it was posted', () => {
  // 16:28 on 30 червня: 1.1 17-18 dropped, 4.2 shortened to 19-20.
  const day = scheduleFromPosts([KROP_1700, KROP_1702], { since: 0 }).fact[kyivDay('2026-06-30')];
  assert.deepEqual(outageHours(day['GPV1.1']), {});
  assert.deepEqual(outageHours(day['GPV4.2']), { 20: 'no' });
  assert.deepEqual(outageHours(day['GPV2.2']), { 21: 'no', 22: 'no' });
});

test('a stacked window written "з 22:30 - 24:00" is not lost (Запоріжжя #3089, 5.2)', () => {
  const posts = JSON.parse(readFileSync(new URL('./zaporizhzhia.fixture-channel-2026-04.json', import.meta.url), 'utf8'));
  const version = parseGpvPost(posts.find((post) => post.id === 3089));
  const off = version.halves['GPV5.2'].flatMap((state, slot) => (state === 'off' ? [slot] : []));
  assert.deepEqual(off, [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 45, 46, 47]);
});
