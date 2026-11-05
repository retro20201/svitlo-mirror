#!/usr/bin/env node
/**
 * After the Firestore rules (`firebase/firestore.rules`) are deployed: checks that the live rules do what they say, as a phone
 * would meet them — with the app's API key and nothing else.
 *
 *   FIREBASE_API_KEY=… GOOGLE_APPLICATION_CREDENTIALS=… node tools/mirror/crowd-smoke.mjs
 *
 * It writes one report with a device code of its own (`ffffffffffffffff` + a random tail never matches a real phone's pattern,
 * so it is nothing to the count: the region `smoke-test` is not one the mirror knows), then tries what the rules must refuse,
 * and deletes what it wrote.
 */
import { accessToken } from './lib/google-auth.mjs';
import { reportId } from './lib/crowd.mjs';

const PROJECT = 'koly-svitlo';
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const KEY = process.env.FIREBASE_API_KEY;
if (!KEY) { console.error('FIREBASE_API_KEY is not set (GoogleService-Info.plist: API_KEY)'); process.exit(2); }

const device = Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const report = { d: device, r: 'smoke-test', q: 'GPV0.0', s: 'on' };

/** The same call the app makes: a commit with the server's time as `t`. */
async function write(id, fields) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:commit?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ios-bundle-identifier': 'com.app.svitlo' },
    body: JSON.stringify({ writes: [{
      update: { name: `${DOCS}/reports/${id}`, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: v }])) },
      updateTransforms: [{ fieldPath: 't', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: false }
    }] })
  });
  return response.status;
}

const results = [];
const check = (name, got, want) => { results.push({ name, ok: want.includes(got), got }); };
const id = reportId(report, Date.now());

check('a well-formed report is accepted', await write(id, report), [200]);
check('the same report again in the same hour is refused', await write(id, report), [403, 409]);
check('another state is another report', await write(reportId({ ...report, s: 'off' }, Date.now()), { ...report, s: 'off' }), [200]);
check('a name that is not the report is refused', await write(`${device}_x`, report), [403]);
check('an unknown field is refused', await write(id + 'x', { ...report, extra: 'y' }), [403]);
check('a bad state is refused', await write(reportId({ ...report, s: 'maybe' }, Date.now()), { ...report, s: 'maybe' }), [403]);
const read = await fetch(`https://firestore.googleapis.com/v1/${DOCS}/reports/${id}?key=${KEY}`, { headers: { 'x-ios-bundle-identifier': 'com.app.svitlo' } });
check('a phone cannot read a report back', read.status, [403]);

// What was written is removed with the mirror's own key.
const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credentials) {
  const { token } = await accessToken(credentials, 'https://www.googleapis.com/auth/datastore');
  for (const name of [id, reportId({ ...report, s: 'off' }, Date.now())]) {
    await fetch(`https://firestore.googleapis.com/v1/${DOCS}/reports/${name}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  }
}

for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.got})`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
