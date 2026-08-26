/**
 * Wakes the phones of one region after its published schedule changes.
 *
 * The message carries no user-facing text — only `{type: "schedule", region}` — and the app turns
 * that into a refetch and a re-armed local alert queue. Pushing the warning itself would put the
 * server in charge of deciding what someone's queue is doing, and make it wrong the moment the
 * two disagree. Local alerts already work with no signal; this exists purely so they are armed
 * against today's plan rather than yesterday's.
 *
 * Uses FCM HTTP v1 with a service-account JWT. No SDK: the whole exchange is one signed assertion
 * and one POST, and a dependency here would have to be audited on every CI run.
 */

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function accessToken(credentialsPath) {
  const account = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: account.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claim))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(account.private_key, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: HTTP ${response.status} ${await response.text()}`);
  }
  return { token: (await response.json()).access_token, projectId: account.project_id };
}

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
export function affectsSchedule(previous, next) {
  const fact = (payload) => JSON.stringify(payload?.fact?.data ?? null);
  return fact(previous) !== fact(next);
}

export async function notifyRegion(regionId, { credentialsPath, dryRun = false } = {}) {
  const topic = topicFor(regionId);
  if (dryRun || !credentialsPath) {
    console.log(`[push] would notify ${topic}`);
    return { topic, sent: false };
  }

  const { token, projectId } = await accessToken(credentialsPath);
  const message = {
    message: {
      topic,
      data: { type: 'schedule', region: regionId },
      apns: {
        // Silent: no alert, no sound. `content-available` is what gets the app woken to refetch,
        // and `apns-priority: 5` is required for it — a silent push sent at 10 is rejected.
        headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
        payload: { aps: { 'content-available': 1 } }
      }
    }
  };

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(message)
    }
  );
  if (!response.ok) {
    throw new Error(`FCM ${response.status}: ${await response.text()}`);
  }
  console.log(`[push] notified ${topic}`);
  return { topic, sent: true };
}
