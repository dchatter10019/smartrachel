# What runs on this box (snapshot 2026-10-29)

EC2 `ip-172-31-39-195`, public IP 3.138.180.46, 4 GB RAM (~2.9 GB used), 77 GB disk (34% used).
No Docker, no pm2 — everything is systemd (system units in `/etc/systemd/system/`, one user unit), plus cron.
Regenerate this picture with: `ps -eo pid,user,rss,args --sort=-rss`, `sudo ss -ltnp`,
`systemctl list-units --type=service --state=running`, `systemctl --user list-units`, `systemctl list-timers`, `crontab -l`.

## 1. Rachel (repo: github.com/dchatter10019/smartrachel = /home/ubuntu)

| Unit | Port | Process / entry file | Log | Env |
|---|---|---|---|---|
| `rachel` | 127.0.0.1:3500 | `node rachel/server.js` (state machine; loads rachel.js, classify-intent.js, functions.js, prompt.md…) | logs/rachel.log | Environment= lines in the unit + /etc/gbrain.env |
| `rachel-mcp` | 127.0.0.1:3600 | `node rachel/rachel-mcp.js` (+ mcp-auth.js, mcp-oauth.js) — the "rachel" MCP connector, public at https://mcp.getbevvi.com/rachel/mcp | logs/rachel-mcp.log | /etc/gbrain.env |
| `rachel-slack` | — (Socket Mode) | `rachel/venv/bin/python rachel/rachel_slack_bot.py` | logs/slack-rachel.log (app), journal (stdout) | /etc/rachel.env |
| `rachel-email` | — (polls Gmail 60s) | `rachel/venv/bin/python rachel/email-agent.py` | logs/email-agent.log | gmail service account in config/ |
| `rachel-whatsapp` | 127.0.0.1:3601 (nginx `/whatsapp/`) | `rachel/venv/bin/python rachel/rachel_whatsapp_bot.py` (Flask + Twilio) | logs/rachel-whatsapp.log | /etc/rachel.env + /etc/rachel-whatsapp.env |
| `shopping-agent` | 127.0.0.1:8300 | `node store-agent/shopping-agent.js` → Bevvi catalog/order API | logs/shopping-agent.log (45 MB) | /etc/gbrain.env |
| `gbrain-mcp` | 127.0.0.1:7700 | `bun run src/cli.ts serve --http --port 7700` in /home/ubuntu/gbrain (third-party repo garrytan/gbrain; data in ~/.gbrain/brain.pglite — embedded Postgres, no separate DB server) | logs/gbrain-mcp.log | — |
| `rachel-monitor` | — | `python3 ops/monitor.py` (findings → logs/findings.jsonl) | logs/monitor.log | — |
| `rachel-qa` (timer, 08:00 UTC) | — | `rachel/qa/nightly.sh` → full QA suite, monitor --once, ops/fixer.py (worktrees in ~/work/F-*), conversation review, reports | logs/qa-nightly.log, logs/fixer/ | — |
| `webchat-video` | *:8600, *:8443 (all interfaces, not via nginx) | `node webchat-video/server.js` — video-chat prototype: HeyGen LiveAvatar in front of Rachel's /chat | — | — |
| `dashboard` | 0.0.0.0:9000 (all interfaces) | `node dashboard/server.js` — "Bevvi Agent Workbench": service status + log viewer | — | — |

Rachel cron jobs (`crontab -l`, user ubuntu):

| When (UTC) | Job | Log |
|---|---|---|
| 01:45 daily | `rachel/learn_packages.js` | logs/learn-packages.log |
| 02:00 daily | `seed_retailers.js` → gbrain (writes through the running server, gbrain-put.js) | logs/gbrain-retailers.log |
| 02:30 daily | `seed_customers.js` → gbrain | logs/gbrain-customers.log |
| 03:15 daily | `nightly-watchdog.js` → Slack webhook | logs/watchdog.log |
| 05:30 daily | `seed_order_history.js` → gbrain | logs/order-history-sync.log |
| 09:00 Mon | `proactive-agent/agent.js` — finds customers due for reorder, emails them a link to Rachel | logs/proactive-agent.log |

Other Rachel files at the top level: `precheck.sh` (deploy gate), `deploy_rachel.sh`, `staging/` (staging data; `ops/staging.sh` starts a :3501 / :8301 copy — not running now), `bevvi-qa/`, `evals/`, `scripts/`, `config/`.

## 2. Bevvi transactions MCP — /opt/bevvi-mcp

| Unit | Port | Process | Env |
|---|---|---|---|
| `bevvi-mcp` (user `bevvi`) | 127.0.0.1:8000 (nginx `mcp.getbevvi.com/mcp`) | `/opt/bevvi-mcp/.venv/bin/bevvi-mcp` (Python) — Bevvi transaction reports as an MCP tool | /etc/bevvi-mcp.env |

## 3. Bevvi Analytics Gateway — /opt/bevvi-analytics-gateway/current

| Unit | Port | Process | Env |
|---|---|---|---|
| `bevvi-analytics-gateway` (user `bevvi-analytics`) | 127.0.0.1:8791 (nginx `mcp.getbevvi.com/analytics`) | `node scripts/analytics-gateway-server.mjs` (package "bevvi-order-tracking-system") — the "Bevvi Analytics" MCP proxy | /etc/bevvi-analytics-gateway.env |

## 4. Bevvi Support Agent — /var/www/bevvi-support-agent (not in git here)

| Unit | Port | Process | Log |
|---|---|---|---|
| `bevvi-support` | 127.0.0.1:5000 (nginx default site on :80, upstream `bevvi_app`) | gunicorn, 4 workers, `email_webhook:app` (Flask + Anthropic + Supabase) — support email agent | /var/log/bevvi-support/{access,error}.log, agent.log |

Cron 06:00 daily: `daily_kb_update.py` (rebuilds its knowledge base) → daily_kb_cron.log. Many leftover one-off files in that directory (email_webhook_old.py, build_kb_*.py, threads_raw.json…).

## 5. OpenClaw (personal AI gateway) — user-level unit

| Unit | Port | Process | Notes |
|---|---|---|---|
| `openclaw-gateway` (`systemctl --user`) | 127.0.0.1:18789 | `~/.local/opt/node24/bin/node ~/.local/opt/openclaw/.../dist/index.js gateway`, plus spawn-broker and sqlite worker children (Node 24.22) | Biggest process on the box: ~1.2 GB RSS (31% of RAM). State in ~/.openclaw (138 MB), backup in ~/backups/openclaw-20261025T141035Z, log ~/openclaw.log. Separate Node 24 — see memory note. |

## 6. Shared infrastructure

| Unit | Port | What it serves |
|---|---|---|
| `nginx` | :80, :443 | `sites-enabled/bevvi-mcp.conf` (mcp.getbevvi.com: /mcp→8000, /rachel/→3600, OAuth well-knowns→3600, /whatsapp/→3601, /analytics→8791, /proposals/ PDFs from logs/); `rachel` (3.138.180.46: /rachel/→3500, /chat static from /var/www/bevvi, /proposals/); `bevvi-support` (default :80 → 5000, /proposals/). TLS by certbot (certbot.timer). |
| `ollama` (user `ollama`) | 127.0.0.1:11434 | Only model: `nomic-embed-text` (embeddings; most likely for gbrain) |
| `cron` | — | jobs above |

OS/AWS services (not project-related): sshd, amazon-ssm-agent (snap), snapd, systemd-*, chrony, rsyslog, fwupd, ModemManager, udisks2, multipathd, unattended-upgrades, sysstat/logrotate/apt timers.

## 7. Problems found in the snapshot, and what was done (Oct 29)

1. FIXED — nightly QA failed every night (`rachel-qa.service` failed Oct 28 + 29): `nightly.sh` line 35 appends to
   logs/monitor.log, which was owned by root (systemd `StandardOutput=append:` creates a missing file as root). Same for
   rachel-mcp.log, rachel-whatsapp.log, shopping-agent.log. All chowned to ubuntu; nothing under logs/ is root-owned now.
   If one of those files is ever deleted, systemd recreates it as root — chown it again.
2. FIXED — the watchdog's Slack webhook was in plain text in the crontab. It's now in /etc/bevvi-watchdog.env (ubuntu, 600),
   loaded by the cron line. The URL was exposed, so rotating the webhook in Slack is still advisable (update that file).
3. FIXED (dashboard) — dashboard listened on 0.0.0.0:9000 with no login while exposing /api/file, /api/save-file,
   /api/restart (sudo systemctl) and /api/evals/run to the internet. Now 127.0.0.1 only; open it with
   `ssh -L 9000:localhost:9000 ubuntu@3.138.180.46` then http://localhost:9000.
   OPEN — webchat-video (8600 / 8443) is still public with no login (a demo page; its /api/heygen-token and /api/tts spend
   HeyGen / OpenAI credit for anyone who calls them). DC to decide: keep public, add a login, or close.
4. FIXED — dashboard status list: orchestrator + the six store-agent-* services removed (units disabled since Sep);
   Rachel WhatsApp + Rachel Monitor added. flow.html (old per-store architecture editor) still shows them.
5. FIXED — nginx: `bevvi-mcp.conf.bak-…` moved from sites-enabled to /etc/nginx/backup/ (it caused the "conflicting
   server name mcp.getbevvi.com" warning). OPEN — `sites-enabled/bevvi-support` (default_server, `server_name
   3.138.180.46 _`) and `sites-enabled/rachel` both claim 3.138.180.46 on :80; bevvi-support loads first, so
   http://3.138.180.46/rachel/ and /chat on plain HTTP go to the support app — only the HTTPS (:443) rachel block serves
   them. Left as is (live support traffic on :80); decide before changing.
6. CLEANED — old Slack bot copies (~/rachel_slack_bot.py, ~/rachel-slack.service, ~/slack-rachel/) moved to
   ~/backups/leftovers-20261029/. 28 fixer worktrees of finished findings removed (branches kept; work/ 221 MB -> 94 MB);
   kept: open / review / diagnosed ones, plus F-0015 and F-0023 (uncommitted edits). Image folders (Moet, Taylor, Veuve,
   images2*, bevvi-images) left alone — purpose unknown.
7. NOTED — memory is tight (412 MB free of 3.8 GB, 2 GB swap half used); OpenClaw holds 1.2 GB.
