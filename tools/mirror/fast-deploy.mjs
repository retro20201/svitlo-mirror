#!/usr/bin/env node
/**
 * Publishes the region files in seconds instead of a minute.
 *
 * `firebase deploy` hashes all 73 thousand files of the site on every cycle — the address
 * dictionaries are nearly all of them — and took a minute of every change's way to the phones.
 * Only the region files move from one cycle to the next, so on the Kyiv server a change is
 * published differently, through the Hosting REST API:
 *
 *   prepare  — clone the live version, files and config, on Firebase's side (about 17 s), started
 *              while the operators are still being read, so it is ready when they are done;
 *   release  — put this cycle's /v1/*.json into the clone (only the bytes Firebase has not seen
 *              are uploaded), finalize it and release it: a few seconds;
 *   discard  — delete a clone nothing was released from.
 *
 * Anything else on the site (a legal page, the dictionaries, firebase.json) still goes out by
 * `firebase deploy` (vps/run.sh decides). A release refuses if the live version moved since the
 * clone — GitHub's fallback publishing meanwhile — rather than undo it; run.sh then does a full
 * deploy.
 *
 *   node tools/mirror/fast-deploy.mjs prepare|release|discard <state.json> [message] | live
 */
import { readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken } from './lib/google-auth.mjs';

const API = 'https://firebasehosting.googleapis.com/v1beta1';
const SITE = 'koly-svitlo';
const SCOPE = 'https://www.googleapis.com/auth/firebase.hosting';
const V1 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'firebase', 'public', 'v1');

/** A JSON call to the Hosting API, throwing with the answer on anything but 2xx. */
export function hostingClient(token, fetchImpl = fetch) {
  return async (path, init = {}) => {
    const response = await fetchImpl(path.startsWith('https://') ? path : `${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) }
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${body.slice(0, 300)}`);
    return body ? JSON.parse(body) : {};
  };
}

/** The version the live channel serves — not the newest release, which may be a preview channel's. */
export async function liveVersion(call) {
  const channel = await call(`/sites/${SITE}/channels/live`);
  const name = channel?.release?.version?.name;
  if (!name) throw new Error('no live release found');
  return name;
}

/** Thrown when the live version is no longer the one cloned: someone else published meanwhile. */
export class LiveMoved extends Error {}

/** Clones the live version, unfinalized. Returns `{ source, version }`. */
export async function prepare(call, { timeoutMs = 150_000, pollMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const source = await liveVersion(call);
  let operation = await call(`/sites/${SITE}/versions:clone`, {
    method: 'POST',
    body: JSON.stringify({ sourceVersion: source, finalize: false })
  });
  const started = Date.now();
  while (!operation.done) {
    if (Date.now() - started > timeoutMs) throw new Error(`clone still running after ${timeoutMs} ms`);
    await sleep(pollMs);
    operation = await call(`/${operation.name}`);
  }
  if (operation.error) throw new Error(`clone failed: ${JSON.stringify(operation.error)}`);
  const version = operation.response?.name;
  if (!version) throw new Error('clone returned no version');
  return { source, version };
}

/** Hosting stores files gzipped and names them by the SHA-256 of the gzipped bytes. */
export function gzipped(content) {
  const bytes = gzipSync(Buffer.isBuffer(content) ? content : Buffer.from(content));
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * `files`: [site path, contents] pairs. Uploads only what Firebase asks for, finalizes and
 * releases the prepared clone.
 */
export async function release(call, upload, prepared, files, message) {
  // Released over a newer version, the clone would put back whatever that version changed.
  if (await liveVersion(call) !== prepared.source) throw new LiveMoved('the live version moved since the clone');
  const manifest = {};
  const bytesByHash = new Map();
  for (const [path, content] of files) {
    const { bytes, hash } = gzipped(content);
    manifest[path] = hash;
    bytesByHash.set(hash, bytes);
  }
  const { uploadRequiredHashes = [], uploadUrl } = await call(`/${prepared.version}:populateFiles`, {
    method: 'POST',
    body: JSON.stringify({ files: manifest })
  });
  for (const hash of uploadRequiredHashes) {
    const bytes = bytesByHash.get(hash);
    if (!bytes) throw new Error(`asked for a hash this release does not hold: ${hash}`);
    await upload(`${uploadUrl}/${hash}`, bytes);
  }
  await call(`/${prepared.version}?update_mask=status`, { method: 'PATCH', body: JSON.stringify({ status: 'FINALIZED' }) });
  await call(`/sites/${SITE}/releases?versionName=${encodeURIComponent(prepared.version)}`, {
    method: 'POST',
    body: JSON.stringify({ message })
  });
  return { uploaded: uploadRequiredHashes.length, files: files.length };
}

export async function discard(call, prepared) {
  await call(`/${prepared.version}`, { method: 'DELETE' });
}

/** This cycle's region files as the site serves them: /v1/<name>.json, never the dictionaries. */
export async function regionFiles(dir = V1) {
  const names = (await readdir(dir)).filter((name) => /^[a-z0-9-]+\.json$/.test(name)).sort();
  return Promise.all(names.map(async (name) => [`/v1/${name}`, await readFile(join(dir, name))]));
}

async function cli() {
  const [action, stateFile, message = 'kyiv fast'] = process.argv.slice(2);
  if (!['prepare', 'release', 'discard', 'live'].includes(action) || (action !== 'live' && !stateFile)) {
    console.error('usage: fast-deploy.mjs prepare|release|discard <state.json> [message] | live');
    process.exit(2);
  }
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentials) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
  const { token } = await accessToken(credentials, SCOPE);
  const call = hostingClient(token);

  // What the live channel serves now, for run.sh to remember after a full deploy.
  if (action === 'live') {
    console.log(await liveVersion(call));
    return;
  }
  if (action === 'prepare') {
    const prepared = await prepare(call);
    await writeFile(stateFile, JSON.stringify(prepared));
    console.log(`[fast] prepared ${prepared.version.split('/').pop()} from ${prepared.source.split('/').pop()}`);
    return;
  }
  const prepared = JSON.parse(await readFile(stateFile, 'utf8'));
  await rm(stateFile, { force: true });
  if (action === 'discard') {
    await discard(call, prepared);
    return;
  }
  const upload = async (url, bytes) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: bytes
    });
    if (!response.ok) throw new Error(`upload ${url.split('/').pop()}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  };
  try {
    const started = Date.now();
    const result = await release(call, upload, prepared, await regionFiles(), message);
    console.log(`[fast] released ${result.files} region files, ${result.uploaded} new, in ${Date.now() - started} ms`);
  } catch (error) {
    // Nothing was released: the clone is of no further use.
    await discard(call, prepared).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli().catch((error) => {
    console.error(`[fast] ${error.message}`);
    // 3: someone else published during this cycle — run.sh must not deploy over it.
    process.exit(error instanceof LiveMoved ? 3 : 1);
  });
}
