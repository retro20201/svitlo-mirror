import { gpvSnapshot } from '../lib/telegram.mjs';

/**
 * ПрАТ «Кіровоградобленерго» — ГПВ tables from @SvitloKropyvnytskyiMisto (84.1K subscribers).
 *
 * The operator runs one channel per district and links every one of them from kiroe.com.ua; the
 * tables are oblast-wide, posted word for word to each (Олександрія's channel carried the same
 * twelve rows at the same minute on 1 липня 2026). Their own post of 1 жовтня 2026 says the
 * schedule reaches the channels "автоматично … одразу як тільки диспетчер вносить зміни", so the
 * city channel is read as the canonical copy. The website serves the same data over a tokenised
 * POST behind a session — a heavier door to the same room.
 *
 * Кропивницький's own wrinkles, all handled in `lib/telegram.mjs`:
 *  - whole hours with no minutes ("Черга 1.1: 00-01, 02-04"), half-hours only when needed;
 *  - "Черга 1.2: -" for a subqueue that stays on;
 *  - the day only in digits ("За розпорядженням НЕК «Укренерго» 05.02.2026…"), and a revision
 *    ("⚡ Зміни на 23:26 05.02.2026") restating all twelve rows.
 */
export async function fetchRegion(region) {
  return gpvSnapshot({ region, channel: 'SvitloKropyvnytskyiMisto', source: 'kirovohrad' });
}
