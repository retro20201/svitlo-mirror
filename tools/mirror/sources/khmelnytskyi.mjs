import { getText } from '../lib/http.mjs';
import { buildSnapshot, kyivDayStart } from '../lib/canonical.mjs';

/**
 * АТ «Хмельницькобленерго» — a picture, and only ever a picture.
 *
 * Checked across the whole of last season: their Telegram channel carries 118 photos and not one
 * text table, and the website publishes the same PNGs. There is no machine-readable schedule to
 * parse, so this adapter does not pretend otherwise — it carries the operator's own image through,
 * dated, and leaves the reading to the person.
 *
 * The archive page is the source rather than Telegram because it removes the one dangerous
 * ambiguity: every link there is captioned «Графік погодинних відключень DD.MM.YYYY», so a file is
 * known to *be* a schedule and known to be *for which day*. In the channel the same picture sits
 * among posts about meter readings, and telling them apart would be guesswork.
 *
 * `hoe.com.ua` serves no robots.txt at all (404), so nothing is disallowed.
 */
const BASE = 'https://hoe.com.ua';
const ARCHIVE = (year) => `${BASE}/page/arhiv-grafikiv-pogodinnih-vidkljuchen-${year}`;

/** `<a href="...png">Графік погодинних відключень 01.07.2026 (оновлення)</a>` */
const LINK = /<a[^>]+href="([^"]+\.(?:png|jpe?g|pdf))"[^>]*>([\s\S]*?)<\/a>/gi;
const LABEL_DATE = /(\d{2})\.(\d{2})\.(\d{4})/;

function absolute(href) {
  return href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** Kyiv midnight for a DD.MM.YYYY the operator printed, as epoch seconds. */
function dayStartFrom(day, month, year) {
  // Noon UTC lands on the intended calendar day in Kyiv whatever the offset, and `kyivDayStart`
  // then resolves the actual midnight — including the 25-hour day in October.
  return kyivDayStart(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12)));
}

export function parseArchive(html, pageUrl) {
  const byDay = new Map();
  for (const [, href, inner] of html.matchAll(LINK)) {
    const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/графік/i.test(label)) continue;          // the page carries other attachments too
    const when = LABEL_DATE.exec(label);
    if (!when) continue;

    const dayStart = dayStartFrom(when[1], when[2], when[3]);
    const isRevision = /оновлен/i.test(label);
    const sheet = {
      dayStart,
      imageUrl: absolute(href),
      sourceUrl: pageUrl,
      caption: label,
      isRevision
    };
    // A day is published once and then amended; the operator marks the amendments, and the last
    // one wins. Where nothing is marked, the file uploaded later wins — the upload stamp is baked
    // into the file name (fileYYYYMMDDHHMMSSmmm).
    const seen = byDay.get(dayStart);
    if (!seen || rank(sheet) >= rank(seen)) byDay.set(dayStart, sheet);
  }
  return [...byDay.values()].sort((a, b) => a.dayStart - b.dayStart);
}

function rank(sheet) {
  const stamp = /file(\d{14})/.exec(sheet.imageUrl)?.[1] ?? '0';
  return Number(stamp) + (sheet.isRevision ? 0.5 : 0);
}

export async function fetchRegion(region) {
  const year = new Date().getUTCFullYear();
  // At the turn of the year the current season spans two archive pages; a missing one is normal.
  const pages = await Promise.all(
    [year, year + 1].map(async (y) => {
      try {
        return { url: ARCHIVE(y), html: await getText(ARCHIVE(y)) };
      } catch {
        return null;
      }
    })
  );

  const today = kyivDayStart();
  const sheets = pages
    .filter(Boolean)
    .flatMap((p) => parseArchive(p.html, p.url))
    // Yesterday is still worth carrying: someone opening the app at 00:30 is usually asking about
    // the night that is still running.
    .filter((s) => s.dayStart >= today - 86400)
    .sort((a, b) => a.dayStart - b.dayStart)
    .slice(0, 3);

  return buildSnapshot({
    regionId: region.id,
    title: region.title,
    queues: {},
    todayEpoch: today,
    sheets,
    sheetBased: true,
    source: 'khmelnytskyi'
  });
}
