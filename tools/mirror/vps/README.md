# The mirror on the Kyiv server

`run.sh` is one cycle of `.github/workflows/mirror.yml`, run from a Ukrainian address every
2 minutes by `svitlo-mirror.timer` (regions with nothing published are read every third cycle,
`lib/lanes.mjs`). A change to the region files is published by `fast-deploy.mjs` — a clone of the
live site with only `/v1/*.json` replaced, prepared while the operators are read — in seconds;
anything else on the site goes out by a full `firebase deploy`, once per change of it. GitHub Actions keeps its cron as the fallback and stands down
while this server has finished a cycle in the last 20 minutes (`lib/heartbeat.mjs`).

The server also runs BenzUA (`/opt/benzua-fetch`, its own timers) and the VPN. Nothing here
touches them: the service may write only to the folders listed in `ReadWritePaths`.

| What | Where |
|---|---|
| this repository, reset to `origin/main` every cycle | `/root/svitlo-mirror` |
| firebase-tools, pinned | `/root/svitlo-mirror-tools` |
| service-account key (`firebase-adminsdk-fbsvc@koly-svitlo`), mode 600 | `/root/.config/svitlo-mirror/service-account.json` |
| last tested commit, last test log | `/var/lib/svitlo-mirror` |
| schedule news: `news-ledger.json` (what people were told), `news.log`, `news-mode`, `news-breaker.json` | `/var/lib/svitlo-mirror` |

Schedule news (`send-news.mjs`, the visible alerts to the opt-in `q_`/`s_`/`e_` topics) runs after
every cycle's deploy, in shadow unless `news-mode` says exactly `on`: it decides and logs everything
to `news.log` and sends nothing. Turn it on with `echo on > /var/lib/svitlo-mirror/news-mode`, and
off again — the kill switch, from the next cycle — with `echo shadow > /var/lib/svitlo-mirror/news-mode`.
The ledger is kept in step either way, so neither switch sends a backlog. A `news-breaker.json` means
more than 180 alerts came due in one cycle and none were sent: look at what changed before anything
else.

Install or update the units (the script itself updates with every push to main):

```sh
cp /root/svitlo-mirror/tools/mirror/vps/svitlo-mirror.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now svitlo-mirror.timer
```

Watch it: `journalctl -u svitlo-mirror -n 80`. Run a cycle now: `systemctl start svitlo-mirror`.
Stop it (GitHub takes over within 20 minutes): `systemctl disable --now svitlo-mirror.timer`.
