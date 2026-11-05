# «За інформацією споживачів» — анонімні відмітки

What it is: people who switch on **Налаштування → Ділитися відмітками анонімно** (off by default) send one short report when they
mark «Світло зникло» / «Світло з’явилося». The mirror counts the reports of the last twenty minutes and publishes `v1/crowd.json`;
when several different devices say the same of a queue, the app writes a line under the schedule. It never changes the schedule.

## The pieces

| Piece | Where |
|---|---|
| The report and the rule «one an hour per device, place and state» | `firebase/firestore.rules` (the same rule as a function: `acceptedByRules` in `tools/mirror/lib/crowd.mjs`) |
| Counting (3 different devices, 20 minutes, a device's latest word, a contested queue says nothing) | `tools/mirror/lib/crowd.mjs` |
| Reading Firestore, writing `crowd.json`, sweeping reports older than 3 h | `tools/mirror/lib/crowd-fetch.mjs`, called from `mirror.mjs` when `SVITLO_CROWD_REPORTS=1` |
| Checking the live rules | `tools/mirror/crowd-smoke.mjs` |
| The privacy page | `firebase/public/privacy/index.html`, «Анонімні відмітки» |

## One report an hour from one device

The document's name is `<device>_<region>_<queue>_<state>_<hour>` and the rules demand exactly that name, with the hour taken from the
server's own time; updates are refused. So a second report for the same four things in the same hour is a second write to a name that
exists, and Firestore says no — whatever the app does. The app also remembers what it sent, so it does not even ask.

`<device>` is sixteen hex digits the app derives from a secret of its own and the day number: it changes every day, is linked to no
account, and cannot be turned back into the secret. Whoever invents device codes can still send many reports — which is why the line
under the schedule needs **three different devices**, is a soft signal, and is not a schedule.

## Switching it on (nothing here is done by merging)

1. Enable Firestore in `koly-svitlo`: `firebase firestore:databases:create "(default)" --location=eur3 --project koly-svitlo`
   (the API must be enabled first: <https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=koly-svitlo>).
   Free plan: 20 000 writes, 50 000 reads and 20 000 deletes a day. The mirror asks once in five minutes, for the last twenty minutes only.
2. Deploy the rules: `firebase deploy --only firestore:rules --project koly-svitlo`.
3. Check them as a phone would meet them: `FIREBASE_API_KEY=… GOOGLE_APPLICATION_CREDENTIALS=… node tools/mirror/crowd-smoke.mjs` — every line must say `ok`.
4. Give the mirror's service account the role **Cloud Datastore User** (it reads and deletes reports), and set `SVITLO_CROWD_REPORTS=1`
   and `CROWD_STATE_FILE=$STATE/crowd-state.json` in the server's unit / `run.sh`.
5. Publish the privacy page (a normal deploy), and answer App Privacy in App Store Connect **before the version that sends is submitted**:
   *Other Data* → *App Functionality*, **not** linked to the user, **not** used for tracking.

Without step 4 the mirror writes no `crowd.json` and the app shows nothing; without the switch in the app nothing is sent.
