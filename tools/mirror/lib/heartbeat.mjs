/**
 * Which of the two mirror runners is publishing right now.
 *
 * The mirror runs on a Kyiv server every 5 minutes: several operators (Полтава, Чернівці, Вінниця,
 * Запоріжжя's site) drop connections from outside Ukraine, and GitHub's cron drops most of its
 * runs. GitHub Actions stays on as the fallback — but two writers deploying the whole site is how
 * Полтава's fresh copy gets overwritten by the US runner's restored old one, and how phones get
 * woken twice for one change. So exactly one of them publishes at a time.
 *
 * The Kyiv runner stamps a label on the live Hosting channel after every finished cycle. A label
 * is metadata: it creates no Hosting version and costs no storage, unlike a heartbeat deploy.
 * GitHub reads it first and stands down while it is fresh.
 */

import { accessToken } from './google-auth.mjs';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const API = 'https://firebasehosting.googleapis.com/v1beta1';
export const LABEL = 'kyiv-runner';

/**
 * Four missed 5-minute cycles. Long enough that one slow cycle (an operator timing out) does not
 * bring GitHub in; short enough that a dead server costs a quarter of an hour, not an evening.
 */
export const MAX_AGE_SECONDS = 20 * 60;

/** Seconds since the Kyiv runner last finished a cycle, or null when it never has. */
export function beatAge(labels, nowSeconds) {
  const value = Number(labels?.[LABEL]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return nowSeconds - value;
}

/**
 * A beat from the future counts as stale: a clock that far wrong is a broken runner, and standing
 * GitHub down on its word could leave nobody publishing.
 */
export function isFresh(labels, nowSeconds, maxAge = MAX_AGE_SECONDS) {
  const age = beatAge(labels, nowSeconds);
  return age !== null && age >= -60 && age <= maxAge;
}

function channelUrl(site) {
  return `${API}/sites/${site}/channels/live`;
}

/**
 * Both sides read the time off Google's `Date` header rather than their own clocks, so a server
 * clock that drifts cannot make a live runner look dead, or a dead one alive.
 */
function serverSeconds(response) {
  const at = Date.parse(response.headers.get('date') ?? '');
  return Number.isFinite(at) ? Math.floor(at / 1000) : Math.floor(Date.now() / 1000);
}

/** @returns {Promise<{labels: object, nowSeconds: number}>} */
export async function readLabels({ credentialsPath, site }) {
  const { token } = await accessToken(credentialsPath, SCOPE);
  const response = await fetch(channelUrl(site), { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`channel read: HTTP ${response.status} ${await response.text()}`);
  return { labels: (await response.json()).labels ?? {}, nowSeconds: serverSeconds(response) };
}

/**
 * Merges the beat into whatever labels are already there rather than replacing them. `clear`
 * writes 0, which reads as "no beat": GitHub takes over on its next run instead of in 20 minutes.
 */
export async function writeBeat({ credentialsPath, site, clear = false }) {
  const { token } = await accessToken(credentialsPath, SCOPE);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const current = await fetch(channelUrl(site), { headers });
  if (!current.ok) throw new Error(`channel read: HTTP ${current.status} ${await current.text()}`);
  const nowSeconds = serverSeconds(current);
  const labels = { ...((await current.json()).labels ?? {}), [LABEL]: clear ? '0' : String(nowSeconds) };
  const response = await fetch(`${channelUrl(site)}?updateMask=labels`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ labels })
  });
  if (!response.ok) throw new Error(`channel write: HTTP ${response.status} ${await response.text()}`);
}
