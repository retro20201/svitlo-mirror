/**
 * Reads the reports phones have written to Firestore, counts them (crowd.mjs) and puts the result where the app looks:
 * `v1/crowd.json`. Firestore's REST API with the mirror's service account, like the pushes — no SDK.
 *
 * Reads are what Firestore's free plan counts (50 000 a day), so this asks once in five minutes, only for the last twenty
 * minutes, and never for more than a few hundred reports. A failure of any kind leaves the file as it was and the schedules
 * untouched: this is a line of text under them, not part of them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessToken } from './google-auth.mjs';
import { aggregate, WINDOW_MS } from './crowd.mjs';

const SCOPE = 'https://www.googleapis.com/auth/datastore';
const PROJECT = 'koly-svitlo';
const DOCUMENTS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
/** How often Firestore is asked, and how often the old reports are swept. */
export const ASK_EVERY_MS = 5 * 60_000;
export const SWEEP_EVERY_MS = 30 * 60_000;
/** Reports are kept this long after they stop counting, then deleted. */
export const KEEP_MS = 3 * 60 * 60_000;
const LIMIT = 300;
const CALL_MS = 20_000;

/** `runQuery` rows → `{ d, r, q, s, t }` with `t` in milliseconds. A row without a document, or without a time, is dropped. */
export function parseRows(rows) {
  const reports = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const fields = row?.document?.fields;
    if (!fields) continue;
    const t = Date.parse(fields.t?.timestampValue ?? '');
    if (!Number.isFinite(t)) continue;
    reports.push({
      d: fields.d?.stringValue, r: fields.r?.stringValue, q: fields.q?.stringValue, s: fields.s?.stringValue, t,
      name: row.document.name
    });
  }
  return reports;
}

async function call(token, path, body, fetchImpl) {
  const response = await fetchImpl(`${DOCUMENTS}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(CALL_MS),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Firestore ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

const timestamp = (ms) => ({ timestampValue: new Date(ms).toISOString() });

export async function fetchRecent({ credentialsPath, nowMs, fetchImpl = fetch }) {
  const { token } = await accessToken(credentialsPath, SCOPE);
  const rows = await call(token, ':runQuery', {
    structuredQuery: {
      from: [{ collectionId: 'reports' }],
      where: { fieldFilter: { field: { fieldPath: 't' }, op: 'GREATER_THAN_OR_EQUAL', value: timestamp(nowMs - WINDOW_MS) } },
      orderBy: [{ field: { fieldPath: 't' }, direction: 'DESCENDING' }],
      limit: LIMIT
    }
  }, fetchImpl);
  return parseRows(rows);
}

/** Deletes reports older than `KEEP_MS`, a few hundred at a time. @returns {Promise<number>} how many. */
export async function sweep({ credentialsPath, nowMs, fetchImpl = fetch }) {
  const { token } = await accessToken(credentialsPath, SCOPE);
  const rows = await call(token, ':runQuery', {
    structuredQuery: {
      from: [{ collectionId: 'reports' }],
      where: { fieldFilter: { field: { fieldPath: 't' }, op: 'LESS_THAN', value: timestamp(nowMs - KEEP_MS) } },
      limit: LIMIT
    }
  }, fetchImpl);
  const names = parseRows(rows).map((report) => report.name);
  if (names.length === 0) return 0;
  await call(token, ':batchWrite', { writes: names.map((name) => ({ delete: name })) }, fetchImpl);
  return names.length;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/**
 * One turn of the mirror's cycle. Asks Firestore if it has been five minutes, writes `crowd.json` when what it says changed.
 * @returns {Promise<{ written: boolean, asked: boolean, reports?: number, swept?: number }>}
 */
export async function publishCrowd({
  outDir, credentialsPath, known, nowMs = Date.now(), fetchImpl = fetch,
  stateFile = process.env.CROWD_STATE_FILE || join(tmpdir(), 'svitlo-crowd-state.json')
}) {
  const state = (await readJson(stateFile)) ?? {};
  if (nowMs - (state.askedAt ?? 0) < ASK_EVERY_MS) return { written: false, asked: false };
  // Stamped before asking: a Firestore that fails or times out is not asked again every cycle.
  state.askedAt = nowMs;
  await writeFile(stateFile, JSON.stringify(state), 'utf8');

  const reports = await fetchRecent({ credentialsPath, nowMs, fetchImpl });
  const { queues } = aggregate(reports, nowMs, { known });
  const file = join(outDir, 'crowd.json');
  const before = await readJson(file);
  const same = before && JSON.stringify(before.queues) === JSON.stringify(queues);
  if (!same) await writeFile(file, JSON.stringify({ generatedAt: new Date(nowMs).toISOString(), queues }), 'utf8');

  let swept;
  if (nowMs - (state.sweptAt ?? 0) >= SWEEP_EVERY_MS) {
    state.sweptAt = nowMs;
    await writeFile(stateFile, JSON.stringify(state), 'utf8');
    swept = await sweep({ credentialsPath, nowMs, fetchImpl });
  }
  return { written: !same, asked: true, reports: reports.length, swept };
}
