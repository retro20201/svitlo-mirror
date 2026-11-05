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

## Switching it on

Done on 2026-11-05 (the first four; the last two wait for the release that sends):

1. Firestore enabled in `koly-svitlo`: the Firebase CLI enables the API by itself on `firebase deploy --only firestore:rules`, then the
   database needs a minute for the API to spread: `firebase firestore:databases:create "(default)" --location=eur3 --project koly-svitlo`.
   Free plan: 20 000 writes, 50 000 reads and 20 000 deletes a day. The mirror asks once in five minutes, for the last twenty minutes only.
2. The rules: `firebase deploy --only firestore:rules --project koly-svitlo` (from this folder: `firebase.json` has the `firestore` key).
   A new ruleset takes up to a minute to reach every server; a report refused right after a deploy is not a bug.
3. Checked as a phone meets them: `FIREBASE_API_KEY=… node tools/mirror/crowd-smoke.mjs` — every line must say `ok` (the repeat is a 409).
   The app's key is `API_KEY` in `GoogleService-Info.plist`. The smoke test leaves its documents behind when it has no service
   account: delete them with `firebase firestore:delete --all-collections --force --project koly-svitlo` while the database is only tests.
4. The server's own account needed no new role: the account in `/root/.config/svitlo-mirror/service-account.json` reads, creates and
   deletes in Firestore. On the server the count is **switched on and off by a file**: `touch /var/lib/svitlo-mirror/crowd-on` /
   `rm` it (`vps/run.sh` exports `SVITLO_CROWD_REPORTS=1` while it exists, and `CROWD_STATE_FILE`).
5. The privacy page (`feature/crowd-privacy`) goes out with the app version that has the switch, and App Privacy in App Store Connect is
   answered **before that version is submitted**: *Other Data* → *App Functionality*, **not** linked to the user, **not** used for tracking.
6. The app side needs the version (1.8) in the store: older apps send nothing and never read `crowd.json`.

Without the file on the server the mirror writes no `crowd.json` and the app shows nothing; without the switch in the app nothing is sent.

## Lessons from switching it on

- **Write the name check in `firestore.rules` on ONE line.** With its `+` at the start of a continuation line the rules compiled and then
  refused every report. There is no emulator here (no Java): `crowd-smoke.mjs` against the live rules is the test.
- In rules, `int / int` is integer division, `math.floor` gives a float (so `int(...)` before `string(...)`), and `string(int)` is digits.
