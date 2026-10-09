/**
 * Wakes the phones of one region after its published schedule changes, and sends what every
 * other FCM message here sends.
 *
 * A `region-*` push carries no user-facing text — only `{type: "schedule", region}` — and the app
 * turns that into a refetch and a re-armed local alert queue. Pushing the warning itself would put
 * the server in charge of deciding what someone's queue is doing, and make it wrong the moment the
 * two disagree. Local alerts already work with no signal; this exists purely so they are armed
 * against today's plan rather than yesterday's. Every build since 1.0 subscribes to it, and it
 * stays silent for all of them.
 *
 * Visible text goes only to the opt-in topics of «Новий графік і зміни» and «Аварійні
 * відключення» — `q_<region>_<queue>`, `s_<region>`, `e_<region>` (lib/news.mjs, send-news.mjs) —
 * and is composed from the same served file the phone then opens, never from a fetch of its own.
 * The one other banner is the hand-run `send-push.mjs --visible` delivery test.
 *
 * Uses FCM HTTP v1 with a service-account JWT. No SDK: the whole exchange is one signed assertion
 * and one POST, and a dependency here would have to be audited on every CI run.
 */

import { accessToken } from './google-auth.mjs';
import { kyivDayStart } from './canonical.mjs';

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** FCM topic names allow a restricted character set; keep this in step with the app. */
export function topicFor(regionId) {
  return 'region-' + regionId.replace(/\./g, '-');
}

/**
 * True when the change is one a phone needs to hear about.
 *
 * `lastUpdated` moves on every mirror run and `preset` barely moves at all; neither changes what
 * anyone's evening looks like. Only `fact` — the schedule actually published for a given day —
 * is worth spending a wake-up on, for every phone in the oblast at once.
 */
export function affectsSchedule(previous, next, now = new Date()) {
  // No file yet, `[]` (what ДТЕК sends out of season) and `{}` all mean "no published day". A
  // region seen for the first time with nothing published is not news: treating the missing
  // file as different woke Львів's, Кропивницький's and Волинь's phones on every run.
  // Only today and later, in a fixed order. Yesterday dropping off at Kyiv midnight (Тернопіль's
  // at 00:00 UTC) changed the whole object and woke every phone in the oblast to refetch what it
  // already had; so did a YASNO-merged day that listed the same queues in another order. `quiet`
  // is left out on purpose: no shipped build reads it, so it is nothing to wake a phone for.
  const today = kyivDayStart(now);
  const fact = (payload) => {
    const data = payload?.fact?.data;
    if (!data || Array.isArray(data)) return '[]';
    const days = Object.keys(data).filter((day) => Number(day) >= today).sort((a, b) => a - b);
    return days.length
      ? JSON.stringify(days.map((day) => [day, Object.keys(data[day] ?? {}).sort().map((queue) => [queue, data[day][queue]])]))
      : '[]';
  };
  // Days the operator declares emergency outages on (YASNO's `EmergencyShutdowns`): the app warns
  // that the schedule may not hold, and that warning is worth a wake-up as soon as it appears.
  // Only today's and later: yesterday's flag dropping off at midnight changes nothing on a phone.
  const emergency = (payload) => JSON.stringify((payload?.fact?.emergency ?? []).filter((day) => day >= today));
  return fact(previous) !== fact(next) || emergency(previous) !== emergency(next);
}

/**
 * @param {object} [options]
 * @param {{title: string, body: string}} [options.visible] Adds a user-visible alert. Only for
 *   proving delivery by hand: `region-*` pushes are silent, because the phone decides what to
 *   say from the schedule it holds. A visible test push is the one way to confirm the
 *   FCM → APNs → device leg without reading the device log, which needs root.
 */
export async function notifyRegion(regionId, { credentialsPath, dryRun = false, visible } = {}) {
  const topic = topicFor(regionId);
  if (dryRun || !credentialsPath) {
    console.log(`[push] would notify ${topic}`);
    return { topic, sent: false };
  }

  const message = {
    message: {
      topic,
      data: { type: 'schedule', region: regionId },
      apns: visible
        ? {
            headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
            payload: {
              aps: {
                alert: { title: visible.title, body: visible.body },
                sound: 'default',
                'content-available': 1
              }
            }
          }
        : {
            // Silent: no alert, no sound. `content-available` is what gets the app woken to
            // refetch, and `apns-priority: 5` is required for it — a silent push sent at 10
            // is rejected.
            headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
            payload: { aps: { 'content-available': 1 } }
          }
    }
  };

  const result = await sendFcm(message, { credentialsPath });
  if (!result.ok) throw new Error(`FCM ${result.status}: ${result.body}`);
  console.log(`[push] notified ${topic}`);
  return { topic, sent: true };
}

/**
 * Failures before a byte of the request left this server: the name did not resolve, or the
 * connection was refused or never made. Nothing reached FCM, so asking again is safe.
 */
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * One FCM HTTP v1 send. Never throws over the answer: an HTTP error or a dropped connection comes
 * back as `{ ok: false, status, retryable, unknown, retryAfterMs, body }` (status 0 for no answer at
 * all), so a caller sending a hundred messages decides per message instead of losing the batch. A
 * token that cannot be had still throws — nothing can be sent without one.
 *
 * No answer is not no delivery. Our own timeout, a reset or a socket closed mid-request may each
 * follow a request FCM accepted and passed on, and FCM v1 has no idempotency key: `unknown` says
 * so, and such a send is not `retryable` — sent again, a banner would ring twice. Only a failure
 * to connect at all is.
 */
export async function sendFcm(message, { credentialsPath, signal } = {}) {
  const { token, projectId } = await accessToken(credentialsPath, FCM_SCOPE);
  let response;
  try {
    response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(message)
    });
  } catch (error) {
    // undici rejects with `fetch failed` and the socket's own error as its cause; an aborted signal
    // rejects with the signal's reason, a `TimeoutError` for AbortSignal.timeout.
    const code = error?.cause?.code ?? error?.code;
    const unsent = NOT_SENT.has(code);
    const why = error?.name === 'TimeoutError' ? 'timeout' : code ?? error?.cause?.message ?? error?.message;
    return { ok: false, status: 0, retryable: unsent, unknown: !unsent, retryAfterMs: null, body: why };
  }
  let body = '';
  try {
    body = await response.text();
  } catch (error) {
    body = error.message;
  }
  return {
    ok: response.ok,
    status: response.status,
    // FCM's own advice: back off and retry on 429 and 5xx; any other refusal repeats itself.
    retryable: response.status === 429 || response.status >= 500,
    unknown: false,
    retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    body
  };
}

/** `Retry-After` as seconds or as an HTTP date, in ms from now; null when absent or unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
