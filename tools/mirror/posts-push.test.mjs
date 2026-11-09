import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decide, buildMessage, emptyPostsLedger, isNight, isPostsTopic, postsTopic, MIN_GAP_MS, SEEN_CAP
} from './lib/posts-push.mjs';
import { run, parseArgs, sendPost, TopicRefused } from './send-posts.mjs';

// The sender for «Новий пост оператора», offline: the feeds are files made here, `send` is a stand-in for FCM.

// November: Kyiv is on winter time, UTC+2 (the clocks went back on 25 October).
const at = (local) => new Date(`${local.replace(' ', 'T')}:00+02:00`);
const NOON = at('2026-11-09 12:00');
const post = (id, minutesAgo, title = `Пост ${id}`, now = NOON) => ({
  id, at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(), title, excerpt: '', url: `https://t.me/x/${id}`
});
const ledgerWith = (region, seen, lastSentAt = null) => ({ v: 1, regions: { [region]: { seen, lastSentAt } } });

test('a region the ledger has not seen is adopted silently, whatever its feed holds', () => {
  const result = decide({ region: 'sumy', items: [post('1', 10), post('2', 20)], ledger: emptyPostsLedger(), now: NOON });
  assert.equal(result.action, 'adopt');
  assert.deepEqual(result.entry, { seen: ['1', '2'], lastSentAt: null });
});

test('nothing new, nothing said', () => {
  const result = decide({ region: 'sumy', items: [post('1', 10)], ledger: ledgerWith('sumy', ['1']), now: NOON });
  assert.equal(result.action, 'none');
});

test('a new post is announced, and the ledger then holds it as seen and the time of the send', () => {
  const result = decide({ region: 'sumy', items: [post('2', 5), post('1', 90)], ledger: ledgerWith('sumy', ['1']), now: NOON });
  assert.equal(result.action, 'send');
  assert.equal(result.post.id, '2');
  assert.deepEqual(result.entry, { seen: ['2', '1'], lastSentAt: NOON.getTime() });
});

test('of several new posts only the newest is announced, and all are marked seen', () => {
  const result = decide({
    region: 'sumy', items: [post('4', 5), post('3', 30), post('2', 50), post('1', 400)], ledger: ledgerWith('sumy', ['1']), now: NOON
  });
  assert.equal(result.action, 'send');
  assert.equal(result.post.id, '4');
  assert.deepEqual(result.entry.seen.slice(0, 4), ['4', '3', '2', '1']);
});

test('a post that is hours old when first seen is not news, but it is seen', () => {
  const result = decide({ region: 'sumy', items: [post('2', 7 * 60), post('1', 900)], ledger: ledgerWith('sumy', ['1']), now: NOON });
  assert.equal(result.action, 'skip');
  assert.equal(result.reason, 'old');
  assert.ok(result.entry.seen.includes('2'));
});

test('a post stamped well ahead of the clock is not trusted to be fresh', () => {
  const result = decide({ region: 'sumy', items: [post('2', -60), post('1', 90)], ledger: ledgerWith('sumy', ['1']), now: NOON });
  assert.equal(result.action, 'skip');
});

test('one alert per region in three hours: the next is dropped, not queued', () => {
  const last = NOON.getTime() - 2 * 3600_000;
  const held = decide({ region: 'sumy', items: [post('2', 5), post('1', 90)], ledger: ledgerWith('sumy', ['1'], last), now: NOON });
  assert.equal(held.action, 'skip');
  assert.equal(held.reason, 'gap');
  assert.equal(held.entry.lastSentAt, last, 'a dropped post does not restart the gap');

  const later = decide({
    region: 'sumy', items: [post('2', 5), post('1', 90)], ledger: ledgerWith('sumy', ['1'], NOON.getTime() - MIN_GAP_MS - 1), now: NOON
  });
  assert.equal(later.action, 'send');
});

test('the regions are independent', () => {
  const ledger = { v: 1, regions: { sumy: { seen: ['1'], lastSentAt: NOON.getTime() - 60_000 }, kyiv: { seen: ['9'], lastSentAt: null } } };
  assert.equal(decide({ region: 'kyiv', items: [post('10', 3), post('9', 80)], ledger, now: NOON }).action, 'send');
});

test('the ledger keeps a bounded number of ids', () => {
  const ids = Array.from({ length: SEEN_CAP + 30 }, (_, i) => `old${i}`);
  const result = decide({ region: 'sumy', items: [post('new', 3)], ledger: ledgerWith('sumy', ids), now: NOON });
  assert.equal(result.entry.seen.length, SEEN_CAP);
  assert.equal(result.entry.seen[0], 'new');
});

test('night is ten in the evening to seven in the morning by the Kyiv clock, midnight included', () => {
  assert.equal(isNight(at('2026-11-09 21:59')), false);
  assert.equal(isNight(at('2026-11-09 22:00')), true);
  assert.equal(isNight(at('2026-11-10 00:30')), true, 'Node 20 writes midnight as 24 under hour12:false');
  assert.equal(isNight(at('2026-11-10 06:59')), true);
  assert.equal(isNight(at('2026-11-10 07:00')), false);
});

test('the message goes to the region’s n_ topic, opens the news screen, replaces the one before and has no sound at night', () => {
  const day = buildMessage({ region: 'kyiv-region', post: post('2', 5, 'Тривають екстрені відключення.'), night: false }, NOON);
  assert.equal(day.message.topic, 'n_kyiv-region');
  assert.equal(day.message.data.deep_link, 'svitlo://news');
  assert.equal(day.message.apns.payload.aps.alert.body, 'Тривають екстрені відключення.');
  assert.equal(day.message.apns.payload.aps.sound, 'default');
  assert.equal(day.message.apns.payload.aps['interruption-level'], 'active');
  assert.equal(day.message.apns.headers['apns-collapse-id'], 'post_kyiv-region');
  assert.ok(Object.values(day.message.data).every((value) => typeof value === 'string'));

  const night = buildMessage({ region: 'kyiv', post: post('2', 5), night: true }, NOON);
  assert.equal(night.message.apns.payload.aps.sound, undefined);
  assert.equal(night.message.apns.payload.aps['interruption-level'], 'passive');
});

test('only n_ topics are ever sent to', async () => {
  assert.equal(postsTopic('sumy'), 'n_sumy');
  for (const bad of ['region-kyiv', 'q_kyiv_GPV1-1', 'e_kyiv', 's_kyiv', 'dev_alerts', 'n_', '', undefined]) {
    assert.equal(isPostsTopic(bad), false, String(bad));
    await assert.rejects(sendPost({ message: { topic: bad } }), TopicRefused);
  }
  assert.equal(isPostsTopic('n_kyiv-region'), true);
});

test('arguments: any mode but exactly "on" is shadow', () => {
  assert.equal(parseArgs(['--mode', 'on']).mode, 'on');
  for (const value of ['ON', 'on ', 'yes', '']) assert.equal(parseArgs(['--mode', value]).mode, 'shadow');
  assert.equal(parseArgs([]).mode, 'shadow');
});

// --- The sender end to end.

const folders = [];
after(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });

function served(feeds) {
  const folder = mkdtempSync(join(tmpdir(), 'posts-push-'));
  folders.push(folder);
  const dir = join(folder, 'v1');
  mkdirSync(dir);
  for (const [region, items] of Object.entries(feeds)) writeFileSync(join(dir, `news-${region}.json`), JSON.stringify({ items }));
  return { dir, ledgerPath: join(folder, 'posts-ledger.json') };
}

function fcm(results = []) {
  const sent = [];
  const send = async (message) => {
    sent.push(message);
    return results.shift() ?? { ok: true, status: 200, retryable: false, unknown: false, body: '{}' };
  };
  return { sent, send };
}

const lines = () => { const out = []; return { out, print: (text) => out.push(text) }; };

test('first run adopts every feed, second run announces only what is new, a third announces nothing again', async () => {
  const { dir, ledgerPath } = served({ sumy: [post('1', 30)], kyiv: [post('7', 40)], ua: [post('9', 1)] });
  const { sent, send } = fcm();
  const log = lines();

  const first = await run({ served: dir, ledgerPath, mode: 'on', now: NOON, send, print: log.print });
  assert.deepEqual(first, { adopted: 2, none: 0, skipped: 0, sent: 0, failed: 0 }, 'the country’s headlines are not an operator’s post');
  assert.equal(sent.length, 0);

  writeFileSync(join(dir, 'news-sumy.json'), JSON.stringify({ items: [post('2', 2), post('1', 32)] }));
  const second = await run({ served: dir, ledgerPath, mode: 'on', now: NOON, send, print: log.print });
  assert.equal(second.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.topic, 'n_sumy');

  const third = await run({ served: dir, ledgerPath, mode: 'on', now: NOON, send, print: log.print });
  assert.equal(third.sent, 0);
  assert.equal(sent.length, 1, 'the same post is never announced twice');
});

test('in shadow nothing leaves, and switching to on afterwards sends no backlog', async () => {
  const { dir, ledgerPath } = served({ sumy: [post('1', 30)] });
  const { sent, send } = fcm();
  await run({ served: dir, ledgerPath, mode: 'shadow', now: NOON, send, print: () => {} });
  writeFileSync(join(dir, 'news-sumy.json'), JSON.stringify({ items: [post('2', 2), post('1', 32)] }));
  const shadow = await run({ served: dir, ledgerPath, mode: 'shadow', now: NOON, send, print: () => {} });
  assert.equal(shadow.sent, 1, 'decided and recorded as sent');
  assert.equal(sent.length, 0);

  const on = await run({ served: dir, ledgerPath, mode: 'on', now: NOON, send, print: () => {} });
  assert.equal(on.sent, 0);
  assert.equal(sent.length, 0);
});

test('a send refused with a 5xx is tried again next cycle; one whose answer was never seen is not', async () => {
  const { dir, ledgerPath } = served({ sumy: [post('1', 30)] });
  await run({ served: dir, ledgerPath, mode: 'on', now: NOON, send: fcm().send, print: () => {} });
  writeFileSync(join(dir, 'news-sumy.json'), JSON.stringify({ items: [post('2', 2), post('1', 32)] }));

  const refused = fcm([{ ok: false, status: 503, retryable: true, unknown: false, body: 'unavailable' }]);
  const first = await run({ served: dir, ledgerPath, mode: 'on', now: NOON, send: refused.send, print: () => {} });
  assert.equal(first.failed, 1);
  const again = fcm();
  const second = await run({ served: dir, ledgerPath, mode: 'on', now: new Date(NOON.getTime() + 2 * 60_000), send: again.send, print: () => {} });
  assert.equal(second.sent, 1, 'still new, because the ledger was not moved on');

  const { dir: dir2, ledgerPath: ledger2 } = served({ sumy: [post('1', 30)] });
  await run({ served: dir2, ledgerPath: ledger2, mode: 'on', now: NOON, send: fcm().send, print: () => {} });
  writeFileSync(join(dir2, 'news-sumy.json'), JSON.stringify({ items: [post('2', 2), post('1', 32)] }));
  const lost = fcm([{ ok: false, status: 0, retryable: false, unknown: true, body: 'timeout' }]);
  await run({ served: dir2, ledgerPath: ledger2, mode: 'on', now: NOON, send: lost.send, print: () => {} });
  const after = fcm();
  const next = await run({ served: dir2, ledgerPath: ledger2, mode: 'on', now: new Date(NOON.getTime() + 2 * 60_000), send: after.send, print: () => {} });
  assert.equal(next.sent, 0);
  assert.equal(after.sent.length, 0, 'FCM has no idempotency key: a lost banner is better than a repeated one');
});

test('a missing or unreadable feed leaves its region alone, and an unreadable ledger is set aside', async () => {
  const { dir, ledgerPath } = served({ sumy: [post('1', 30)] });
  writeFileSync(join(dir, 'news-broken.json'), 'not json');
  writeFileSync(ledgerPath, '{ nonsense');
  const log = lines();
  const counts = await run({ served: dir, ledgerPath, mode: 'on', now: NOON, send: fcm().send, print: log.print });
  assert.equal(counts.adopted, 1);
  assert.ok(log.out.some((line) => line.includes('unreadable — moved to')));
  const saved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.deepEqual(Object.keys(saved.regions), ['sumy']);
  assert.ok(existsSync(ledgerPath));
});
