#!/usr/bin/env bash
# One mirror cycle on the Kyiv server — the steps of .github/workflows/mirror.yml, from a Ukrainian
# address. Started by svitlo-mirror.timer every 5 minutes; see README.md in this folder.
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

  # GitHub's copies of regions this server has been failing (lib/relay.mjs). A missing branch or a
  # failed fetch just means there are none; mirror.mjs uses them only where its own read fails.
  rm -rf "$STATE/relay" && mkdir -p "$STATE/relay"
  if timeout 60 git fetch -q --depth 1 origin relay 2>/dev/null; then
    git archive FETCH_HEAD | tar -x -C "$STATE/relay"
  fi

  local outputs changed notify
  outputs=$(mktemp)
  if ! GITHUB_OUTPUT="$outputs" RELAY_DIR="$STATE/relay" node tools/mirror/mirror.mjs; then
    rm -f "$outputs"
    echo "[mirror] every adapter failed — not publishing"
    exit 1
  fi
  changed=$(sed -n 's/^changed=//p' "$outputs")
  notify=$(sed -n 's/^notify=//p' "$outputs")
  rm -f "$outputs"

  if [ "$changed" = "true" ]; then
    # Stamped before the deploy as well as after the cycle: GitHub asks once more right before its
    # own release, and this one may be minutes in flight. A beat that cannot land means GitHub
    # will publish too, so this one does not.
    if ! node tools/mirror/heartbeat.mjs beat; then
      echo "[deploy] skipped — without a beat GitHub publishes, and two writers overwrite each other"
      exit 1
    fi
    if ! "$FIREBASE" deploy --only hosting --project koly-svitlo --non-interactive --message "kyiv ${head:0:9}"; then
      echo "[deploy] failed — no push; handing over to GitHub"
      node tools/mirror/heartbeat.mjs clear
      exit 1
    fi
  fi

  # Strictly after the deploy: a phone woken earlier refetches the old file and believes it.
  if [ -n "$notify" ]; then
    node tools/mirror/send-push.mjs "$notify"
  fi

  # Only a finished cycle stands GitHub down.
  node tools/mirror/heartbeat.mjs beat
}

main "$@"; exit
