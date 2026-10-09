#!/usr/bin/env bash
# One mirror cycle on the Kyiv server — the steps of .github/workflows/mirror.yml, from a Ukrainian
# address. Started by svitlo-mirror.timer every 2 minutes; see README.md in this folder.
#
# The whole body is one function, called on the last line: bash reads a script as it runs, and a
# manual `git pull` mid-cycle would otherwise rewrite the lines still to come.
set -uo pipefail

REPO=/root/svitlo-mirror
FIREBASE=/root/svitlo-mirror-tools/node_modules/.bin/firebase
STATE=/var/lib/svitlo-mirror
export GOOGLE_APPLICATION_CREDENTIALS=/root/.config/svitlo-mirror/service-account.json

main() {
  cd "$REPO" || exit 1

  # The unit has already brought the tree to origin/main (ExecStartPre), outside this file, so a
  # broken push of this script is repaired by the next push rather than locking the server out.
  # CI starts from a clean checkout; so does this. A file left behind would be deployed.
  git clean -fdq -- firebase/public || { echo "[sync] clean failed — not publishing"; exit 1; }
  local head
  head=$(git rev-parse HEAD)

  # The suite takes ~10 s of this server's single core, so it runs once per commit, not per cycle.
  # A commit that fails it never publishes, here or on GitHub.
  if [ "$(cat "$STATE/tested" 2>/dev/null)" != "$head" ]; then
    if node --test $(find tools -name '*.test.mjs') > "$STATE/test.log" 2>&1; then
      echo "$head" > "$STATE/tested"
      echo "[tests] passed at ${head:0:9}"
    else
      echo "[tests] FAILED at ${head:0:9} — not publishing"
      tail -40 "$STATE/test.log"
      exit 1
    fi
  fi

  # Start from what phones are being served, exactly as CI does: the committed files are a seed,
  # and comparing against them would look like a change — and a push — on every cycle.
  # A 404 is a region not published yet. Anything else — the site unreachable from here, or a body
  # cut off after its 200 — would leave the stale seed or a broken file as the baseline: every
  # region would look changed, and their phones woken.
  local regions name file code rc
  regions=$(node --input-type=module -e "import { REGIONS } from './tools/mirror/regions.mjs'; console.log(REGIONS.filter((r) => r.source).map((r) => r.id).join(' '))")
  for name in index $regions; do
    file="firebase/public/v1/$name.json"
    code=$(curl -sS --retry 2 --max-time 30 -o "$file.served" -w '%{http_code}' "https://koly-svitlo.web.app/v1/$name.json")
    rc=$?
    if [ "$rc" = "0" ] && [ "$code" = "200" ] \
      && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file.served"; then
      mv "$file.served" "$file"
    elif [ "$rc" = "0" ] && [ "$code" = "404" ]; then
      rm -f "$file.served"
    else
      rm -f "$file.served"
      echo "[restore] $name: HTTP ${code:-none}, curl $rc — not publishing from an unknown baseline"
      exit 1
    fi
  done

  # Anything on the site besides the region files — a legal page, the address dictionaries,
  # firebase.json — goes out by a full `firebase deploy`, once per change of it, whether or not a
  # region moved. Fingerprinted from git's own blob ids: the checkout is shallow, so no diff.
  local fingerprint full=false
  fingerprint=$(git ls-tree -r "$head" -- firebase.json firebase/public \
    | grep -vE $'\tfirebase/public/v1/[^/]+\\.json$' | sha256sum | cut -c1-64)
  [ "$(cat "$STATE/site-deployed" 2>/dev/null)" = "$fingerprint" ] || full=true

  # The fast path (fast-deploy.mjs): clone the live site on Firebase's side while the operators
  # are read, so a change is out in seconds. A clone left by a cycle that died is deleted first.
  local prepared="$STATE/prepared.json" preparing=""
  if [ -s "$prepared" ]; then
    node tools/mirror/fast-deploy.mjs discard "$prepared" > /dev/null 2>&1 || rm -f "$prepared"
  fi
  if [ "$full" = "false" ]; then
    node tools/mirror/fast-deploy.mjs prepare "$prepared" > "$STATE/prepare.log" 2>&1 &
    preparing=$!
  fi

  # GitHub's copies of regions this server has been failing (lib/relay.mjs). A missing branch or a
  # failed fetch just means there are none; mirror.mjs uses them only where its own read fails.
  rm -rf "$STATE/relay" && mkdir -p "$STATE/relay"
  if timeout 30 git fetch -q --depth 1 origin relay 2>/dev/null; then
    git archive FETCH_HEAD | tar -x -C "$STATE/relay"
  fi

  # Regions with nothing published are read on the slow turn (lib/lanes.mjs): once five and a half
  # minutes have passed since the last one, however long the cycles in between ran.
  local outputs changed notify fresh now slow_turn=0
  now=$(date +%s)
  [ $(( now - $(cat "$STATE/slow-read-at" 2>/dev/null || echo 0) )) -ge 330 ] && slow_turn=1
  outputs=$(mktemp)
  if ! GITHUB_OUTPUT="$outputs" RELAY_DIR="$STATE/relay" MIRROR_SLOW_LANE=1 MIRROR_SLOW_TURN=$slow_turn \
      node tools/mirror/mirror.mjs; then
    rm -f "$outputs"
    echo "[mirror] every adapter failed — not publishing"
    exit 1
  fi
  [ "$slow_turn" = "1" ] && echo "$now" > "$STATE/slow-read-at"
  changed=$(sed -n 's/^changed=//p' "$outputs")
  notify=$(sed -n 's/^notify=//p' "$outputs")
  fresh=$(sed -n 's/^fresh=//p' "$outputs")
  rm -f "$outputs"

  # The clone has had the whole read to finish; a failed one just means the full deploy.
  if [ -n "$preparing" ] && ! wait "$preparing"; then
    tail -3 "$STATE/prepare.log"
    rm -f "$prepared"
  fi
  # A clone of a version this server did not release would carry someone else's site forward —
  # GitHub's, published while this server was away — for as long as no commit touched the site.
  # The cycle after such a release deploys in full from this checkout instead.
  if [ -s "$prepared" ] && [ "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).source)' "$prepared")" \
      != "$(cat "$STATE/live-version" 2>/dev/null)" ]; then
    echo "[deploy] live is not what this server released last — deploying in full"
    node tools/mirror/fast-deploy.mjs discard "$prepared" > /dev/null 2>&1 || rm -f "$prepared"
    full=true
  fi

  if [ "$changed" = "true" ] || [ "$full" = "true" ]; then
    # Stamped before the deploy as well as after the cycle: GitHub asks once more right before its
    # own release, and this one may be minutes in flight. A beat that cannot land means GitHub
    # will publish too, so this one does not.
    if ! node tools/mirror/heartbeat.mjs beat; then
      echo "[deploy] skipped — without a beat GitHub publishes, and two writers overwrite each other"
      [ -s "$prepared" ] && node tools/mirror/fast-deploy.mjs discard "$prepared" > /dev/null 2>&1
      exit 1
    fi
    local fast=false version rc
    if [ "$full" = "false" ] && [ -s "$prepared" ]; then
      version=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).version)' "$prepared")
      node tools/mirror/fast-deploy.mjs release "$prepared" "kyiv ${head:0:9}"
      rc=$?
      if [ "$rc" = "0" ]; then
        fast=true
        echo "$version" > "$STATE/live-version"
      elif [ "$rc" = "3" ]; then
        # Someone else published during this cycle. A full deploy now would put this cycle's
        # older baseline over it; the next cycle starts from what is live instead. No push.
        echo "[deploy] live moved during this cycle — not deploying over it"
        exit 1
      else
        echo "[deploy] fast path failed — deploying in full"
      fi
    fi
    if [ "$fast" = "false" ]; then
      [ -s "$prepared" ] && node tools/mirror/fast-deploy.mjs discard "$prepared" > /dev/null 2>&1
      if ! "$FIREBASE" deploy --only hosting --project koly-svitlo --non-interactive --message "kyiv ${head:0:9}"; then
        echo "[deploy] failed — no push; handing over to GitHub"
        node tools/mirror/heartbeat.mjs clear
        exit 1
      fi
      echo "$fingerprint" > "$STATE/site-deployed"
      node tools/mirror/fast-deploy.mjs live > "$STATE/live-version" 2>/dev/null || rm -f "$STATE/live-version"
    fi
  elif [ -s "$prepared" ]; then
    node tools/mirror/fast-deploy.mjs discard "$prepared" > /dev/null 2>&1 || rm -f "$prepared"
  fi

  # Strictly after the deploy: a phone woken earlier refetches the old file and believes it.
  if [ -n "$notify" ]; then
    node tools/mirror/send-push.mjs "$notify"
  fi

  # Visible news to the opt-in q_/s_/e_ topics (send-news.mjs) — also after the deploy, and read
  # from what is being served. It runs on a cycle with nothing to deploy too: that is the second
  # read a change needs before anyone is told. `news-mode` is written by hand; anything but "on"
  # is shadow. The fingerprint is the adapter code: a change of it adopts each region's next read
  # silently, so our own fix is never announced as the operator's change.
  local mode fp
  mode=$(cat "$STATE/news-mode" 2>/dev/null || echo shadow)
  fp=$(git ls-tree -r "$head" -- tools/mirror/lib tools/mirror/sources tools/mirror/regions.mjs \
         tools/mirror/adapters.mjs tools/mirror/mirror.mjs \
       | grep -vE $'\ttools/mirror/lib/(news|notify|google-auth|heartbeat)\\.mjs$' | sha256sum | cut -c1-16)
  # The timeout is a backstop: the script stops starting sends after 60 s, and on SIGTERM writes
  # its ledger and exits 0.
  timeout -k 10 120 node tools/mirror/send-news.mjs --fresh "$fresh" --ledger "$STATE/news-ledger.json" \
    --mode "$mode" --fingerprint "$fp" >> "$STATE/news.log" 2>&1 || echo "[news] exited $?"
  tail -n 20000 "$STATE/news.log" > "$STATE/news.log.tmp" && mv "$STATE/news.log.tmp" "$STATE/news.log"

  # Only a finished cycle stands GitHub down.
  node tools/mirror/heartbeat.mjs beat
}

main "$@"; exit
