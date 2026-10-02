/**
 * Whether a freshly fetched snapshot differs from the one phones are being served — which decides
 * whether the cycle writes the file, and so whether it deploys.
 *
 * The mirror's own timestamps never count. The operator's "updated at" stamp (`fact.update`,
 * `preset.updateFact`) counts only now and then: Рівне's and Житомир's pages restamp themselves
 * every half hour whether or not anything changed, and on a 5-minute cycle each restamp was a new
 * Hosting version of ~7.8 MB — the free tier's 10 GB in about a fortnight. The app shows the stamp
 * as «Оновлено …», so it is refreshed, just not more often than STAMP_REFRESH_MS.
 */

export const STAMP_REFRESH_MS = 6 * 3600 * 1000;

function fingerprint(snapshot, { stamps }) {
  const { lastUpdated, lastUpdateStatus, mirroredAt, ...rest } = snapshot;
  if (stamps) return JSON.stringify(rest);
  const { update, ...fact } = rest.fact ?? {};
  const { updateFact, ...preset } = rest.preset ?? {};
  return JSON.stringify({ ...rest, fact, preset });
}

/** @returns {boolean} true when the served copy can stay as it is. */
export function unchanged(previous, next, now = Date.now()) {
  if (!previous) return false;
  if (fingerprint(previous, { stamps: true }) === fingerprint(next, { stamps: true })) return true;
  if (fingerprint(previous, { stamps: false }) !== fingerprint(next, { stamps: false })) return false;
  // Only the stamp moved.
  const served = Date.parse(previous.mirroredAt ?? '');
  return Number.isFinite(served) && now - served < STAMP_REFRESH_MS;
}
