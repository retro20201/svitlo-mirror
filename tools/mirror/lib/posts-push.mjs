/**
 * «Новий пост оператора»: one visible alert to the people who asked for it, when an operator's channel says something about the
 * light that the app's news screen did not have a moment ago. They go to `n_<region>` and nowhere else, and only to those who
 * switched «Нові пости оператора» on (the app subscribes by that switch, off by default).
 *
 * Pure: no files, no network, the clock passed in. send-posts.mjs reads the feeds being served (`v1/news-<region>.json`, which
 * lib/operator-posts.mjs writes) and a ledger, and does the sending.
 *
 * Three rules, because a push is the one thing in this app that can wake someone, and the operators post a lot:
 * - a region the ledger has not seen is adopted silently: whatever is in its feed on the first read is not news;
 * - only the newest of the new posts is announced, and only if it is hours old at most — a feed read after a gap does not
 *   announce yesterday; the others are marked seen all the same;
 * - at most one alert per region in three hours. A post held back by that is dropped, not queued: a banner an hour late for a
 *   post about a cut that is already over does more harm than none.
 */

export const postsTopic = (region) => `n_${region}`;

/** Visible alerts of this kind leave to `n_` topics and no other. */
export const isPostsTopic = (topic) => typeof topic === 'string' && /^n_[a-z0-9-]+$/.test(topic);

export const MIN_GAP_MS = 3 * 60 * 60 * 1000;
export const FRESH_MS = 6 * 60 * 60 * 1000;
/** A post stamped this far ahead of the clock is not trusted to be fresh. */
const CLOCK_SLACK_MS = 5 * 60 * 1000;
/** How many ids a region remembers: the feed keeps a dozen, so this outlives every post in it several times over. */
export const SEEN_CAP = 60;
/** Alerts are dropped by APNs when this long has passed: a post is news for an afternoon. */
const EXPIRES_AFTER_S = 12 * 60 * 60;

export const emptyPostsLedger = () => ({ v: 1, regions: {} });

export const isPostsLedger = (value) => Boolean(value) && typeof value === 'object' && value.v === 1 &&
  Boolean(value.regions) && typeof value.regions === 'object' && !Array.isArray(value.regions);

// `hourCycle: 'h23'`, never `hour12: false`: under Node 20's ICU the latter writes midnight as "24".
const KYIV_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' });

/** From ten in the evening to seven in the morning by the Kyiv clock a banner arrives without a sound. */
export function isNight(now = new Date()) {
  const hour = Number(KYIV_HOUR.format(now));
  return hour >= 22 || hour < 7;
}

/**
 * What to do with a region's feed. Returns `{ action, entry, post?, night?, held? }` and changes nothing: `entry` is what the
 * ledger should hold for the region once the action has been carried out — kept back by the caller when a send is to be tried
 * again, so that the post is still new next time.
 *
 *   adopt — first sight of the region: everything in the feed is taken as seen
 *   none  — nothing new
 *   skip  — new posts, none worth a banner (too old, or too soon after the last one); all are marked seen
 *   send  — announce `post`
 */
export function decide({ region, items, ledger, now = new Date() }) {
  const ids = items.map((item) => item.id);
  const held = ledger.regions[region];
  if (!held) return { action: 'adopt', entry: { seen: ids.slice(0, SEEN_CAP), lastSentAt: null } };

  const known = new Set(held.seen);
  const fresh = items.filter((item) => !known.has(item.id));
  const seen = [...ids, ...held.seen.filter((id) => !ids.includes(id))].slice(0, SEEN_CAP);
  const entry = { seen, lastSentAt: held.lastSentAt ?? null };
  if (!fresh.length) return { action: 'none', entry };

  const newest = fresh.reduce((best, item) => (Date.parse(item.at) > Date.parse(best.at) ? item : best));
  const age = now.getTime() - Date.parse(newest.at);
  if (!Number.isFinite(age) || age > FRESH_MS || age < -CLOCK_SLACK_MS) {
    return { action: 'skip', reason: 'old', post: newest, entry };
  }
  if (held.lastSentAt !== null && now.getTime() - held.lastSentAt < MIN_GAP_MS) {
    return { action: 'skip', reason: 'gap', post: newest, entry };
  }
  return {
    action: 'send', post: newest, night: isNight(now), held: held.seen,
    entry: { seen, lastSentAt: now.getTime() }
  };
}

/** The FCM v1 request. Every `data` value is a string, as FCM requires; the link is the news screen of the app. */
export function buildMessage({ region, post, night }, now = new Date()) {
  return {
    message: {
      topic: postsTopic(region),
      data: { type: 'operator_post', region, campaign: 'operator_post', deep_link: 'svitlo://news' },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
          // A banner for a newer post replaces the one before it, not stacks on it.
          'apns-collapse-id': `post_${region}`,
          'apns-expiration': String(Math.floor(now.getTime() / 1000) + EXPIRES_AFTER_S)
        },
        payload: {
          aps: {
            alert: { title: 'Новини оператора', body: post.title },
            ...(night ? {} : { sound: 'default' }),
            'thread-id': `operator_post.${region}`,
            'interruption-level': night ? 'passive' : 'active'
          }
        }
      }
    }
  };
}
