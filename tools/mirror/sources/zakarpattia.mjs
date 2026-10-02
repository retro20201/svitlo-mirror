import { dayOfPost } from '../lib/telegram.mjs';
import { pictureChannelSnapshot } from '../lib/picture-channel.mjs';
import { readZakarpattiaPicture } from '../lib/zakarpattia-picture.mjs';
import { NATIONAL_QUEUES } from '../lib/canonical.mjs';

/**
 * ПрАТ «Закарпаттяобленерго» — the ГПВ grid it posts to @zakarpatenergyofficial.
 *
 * The same picture is on its own API (api-outage-zakarpat-energy.inneti.net, the "today" and
 * "tomorrow" options), but nothing there says which day a picture is for — the option's date is
 * when it was uploaded. The channel posts it with a caption that does: "графік погодинних
 * включень/відключень електроенергії на 30.10.2025", "Змінено графік … на 24.12.2025".
 *
 * Read by colour (`lib/zakarpattia-picture.mjs`). Checked on the season's 140 posts: all read; the
 * six whose full-size originals the Wayback Machine kept decode cell for cell the same from
 * either, and a 17.01.2026 grid sampled independently from its original agrees row for row.
 */
const CHANNEL = 'zakarpatenergyofficial';

export function scheduleDay(post) {
  if (!/графік\S*\s+погодинних\s+включень|змінено\s+графік/i.test(post.text)) return null;
  return dayOfPost(post);
}

export async function fetchRegion(region, options = {}) {
  return pictureChannelSnapshot(region, {
    channel: CHANNEL,
    source: 'zakarpattia',
    dayOf: scheduleDay,
    read: (bytes) => {
      const result = readZakarpattiaPicture(bytes);
      if (result.error) return result;
      return { halves: Object.fromEntries(NATIONAL_QUEUES.map((label, i) => [`GPV${label}`, result.rows[i]])) };
    },
    ...options
  });
}
