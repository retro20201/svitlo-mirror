/**
 * Чернігівобленерго amends a day's table in free text, a line per change, under a stock banner:
 *
 *   🕗 З 22:00 до 24:00 додатково відключається черга 5/1.        → off 22:00–24:00
 *   🕗 Черга 1/1 – 21:30-24:00.  🕗 08:00-10:30 — черги 1/1, 1/2.  → off for those windows
 *   🕗 До 10:00 продовжуються відключення для черги 1/1.            → off from the post until 10:00
 *   🕗 Відключення у чергах 6/1 і 6/2 подовжується до 17:30.        → the same
 *   🕗 З 22:00 відключається черга 4/1.                             → possible from 22:00 on
 *
 * The last kind gives no end, so what follows the start is only "possible". A line that names a
 * черга but none of these shapes is not guessed at either: its черги are marked possible from the
 * moment of the post — the operator said something changes for them, and that is all that is known.
 * Lines about the volume of restrictions ("обсяг обмежень збільшиться на 0,5 черги") name no
 * черга and change nothing on their own.
 */
const T = String.raw`(\d{1,2})[:.](\d{2})`;
const QUEUE = /(\d)\s*\/\s*(\d)/g;
const slot = (h, m) => Math.min(48, Math.round((Number(h) * 60 + Number(m)) / 30));

const queuesIn = (text) => [...text.matchAll(QUEUE)].filter(([, a, b]) => a >= 1 && a <= 6 && (b === '1' || b === '2')).map(([, a, b]) => `GPV${a}.${b}`);

/** One line → its changes, `null` when it names no черга, or `{ unparsed }`. */
export function parseLine(line, postSlot) {
  const text = line.replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/Із\b/gi, 'З').trim();
  const queues = queuesIn(text);
  if (!queues.length) return null;
  const window = new RegExp(String.raw`(?:^|\D)(?:з\s+)?${T}\s*(?:-|до)\s*${T}`, 'i').exec(text);
  if (window) {
    const [, h1, m1, h2, m2] = window;
    const from = slot(h1, m1), to = slot(h2, m2) || 48;
    if (to > from) return queues.map((key) => ({ key, from, to, state: 'off' }));
  }
  const until = new RegExp(String.raw`(?:^до\s+${T}|(?:подовж|продовж)\S*\s+(?:\S+\s+){0,6}?до\s+${T}|до\s+${T}\s+(?:подовж|продовж))`, 'i').exec(text);
  if (until && /подовж|продовж/i.test(text)) {
    const [h, m] = until.slice(1).filter(Boolean);
    const to = slot(h, m) || 48;
    if (to > postSlot) return queues.map((key) => ({ key, from: postSlot, to, state: 'off' }));
    return [];
  }
  const start = new RegExp(String.raw`(?:^|\s)(?:з|о)\s+${T}|відключення\s+з\s+${T}`, 'i').exec(text);
  if (start && /відключ/i.test(text)) {
    const [h, m] = start.slice(1).filter(Boolean);
    return queues.map((key) => ({ key, from: slot(h, m), to: 48, state: 'possible' }));
  }
  return { unparsed: queues };
}

/** A caption → `{ changes, unparsed }` for the lines that change черги. */
export function parseAmendment(text, postSlot) {
  const changes = [];
  const unparsed = [];
  for (const line of text.split('\n')) {
    if (/особов|сайт|бот|Нагадуємо|https?:/i.test(line)) continue;
    const parsed = parseLine(line, postSlot);
    if (!parsed) continue;
    if (parsed.unparsed) {
      unparsed.push(line.trim());
      changes.push(...parsed.unparsed.map((key) => ({ key, from: postSlot, to: 48, state: 'possible' })));
    } else {
      changes.push(...parsed);
    }
  }
  return { changes, unparsed };
}
