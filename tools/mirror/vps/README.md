# The mirror on the Kyiv server

`run.sh` is one cycle of `.github/workflows/mirror.yml`, run from a Ukrainian address every
5 minutes by `svitlo-mirror.timer`. GitHub Actions keeps its cron as the fallback and stands down
while this server has finished a cycle in the last 20 minutes (`lib/heartbeat.mjs`).

The server also runs BenzUA (`/opt/benzua-fetch`, its own timers) and the VPN. Nothing here
touches them: the service may write only to the folders listed in `ReadWritePaths`.

| What | Where |
|---|---|
| this repository, reset to `origin/main` every cycle | `/root/svitlo-mirror` |
| firebase-tools, pinned | `/root/svitlo-mirror-tools` |
| service-account key (`firebase-adminsdk-fbsvc@koly-svitlo`), mode 600 | `/root/.config/svitlo-mirror/service-account.json` |
| last tested commit, last test log | `/var/lib/svitlo-mirror` |

Install or update the units (the script itself updates with every push to main):

```sh
cp /root/svitlo-mirror/tools/mirror/vps/svitlo-mirror.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now svitlo-mirror.timer
```

Watch it: `journalctl -u svitlo-mirror -n 80`. Run a cycle now: `systemctl start svitlo-mirror`.
Stop it (GitHub takes over within 20 minutes): `systemctl disable --now svitlo-mirror.timer`.
