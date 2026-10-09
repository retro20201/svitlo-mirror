/**
 * A Google OAuth access token from a service-account key: one signed JWT assertion and one POST.
 *
 * No SDK, for the same reason as everything else here — a dependency would have to be audited on
 * every run, and this is the whole exchange.
 */

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Tokens already exchanged, per key file and scope, until five minutes before they expire. One
 * news wave is a hundred-odd sends from four workers at once; without this each would sign and
 * exchange its own assertion. The promise is kept, not the token, so the four share the first.
 */
const tokens = new Map();
const EARLY_SECONDS = 300;
/**
 * The whole exchange, body included. Without it a connection that opens and then never answers
 * waits on undici's five-minute default — past run.sh's `timeout`, with a news wave or a heartbeat
 * held up behind it.
 */
const EXCHANGE_MS = 15_000;

/** @returns {Promise<{token: string, projectId: string}>} */
export function accessToken(credentialsPath, scope) {
  const key = `${credentialsPath}\n${scope}`;
  const held = tokens.get(key);
  if (held && (held.until === undefined || Date.now() < held.until)) return held.promise;
  const entry = {};
  entry.promise = exchange(credentialsPath, scope).then(
    ({ token, projectId, exp }) => {
      entry.until = (exp - EARLY_SECONDS) * 1000;
      return { token, projectId };
    },
    (error) => {
      // A failed exchange is not remembered: the next caller tries again.
      if (tokens.get(key) === entry) tokens.delete(key);
      throw error;
    }
  );
  tokens.set(key, entry);
  return entry.promise;
}

async function exchange(credentialsPath, scope) {
  const account = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: account.client_email,
    scope,
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
    signal: AbortSignal.timeout(EXCHANGE_MS),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: HTTP ${response.status} ${await response.text()}`);
  }
  return { token: (await response.json()).access_token, projectId: account.project_id, exp: claim.exp };
}
