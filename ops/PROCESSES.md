# What runs on this box (snapshot 2026-10-29)

EC2 `ip-172-31-39-195`, public IP 3.138.180.46, 4 GB RAM, 2 GB swap, 77 GB disk.
No Docker, no pm2 — everything is systemd (system units in `/etc/systemd/system/`, one user unit), plus cron.
Regenerate this picture with: `ps -eo pid,user,rss,args --sort=-rss`, `sudo ss -ltnp`,
`systemctl list-units --type=service --state=running`, `systemctl --user list-units`, `systemctl list-timers`, `crontab -l`.
Source-file lists below come from each entry file's require/import graph (paths relative to the project root).

## 1. Rachel (repo: github.com/dchatter10019/smartrachel = /home/ubuntu)

| Unit | Port | Entry | Log | Env |
|---|---|---|---|---|
| `rachel` | 127.0.0.1:3500 | `node rachel/server.js` | logs/rachel.log | Environment= lines in the unit + /etc/gbrain.env |
| `rachel-mcp` | 127.0.0.1:3600 (public: https://mcp.getbevvi.com/rachel/mcp) | `node rachel/rachel-mcp.js` | logs/rachel-mcp.log | /etc/gbrain.env |
| `rachel-slack` | — (Slack Socket Mode) | `rachel/venv/bin/python rachel/rachel_slack_bot.py` | logs/slack-rachel.log, journal | /etc/rachel.env |
| `rachel-email` | — (polls rachelai@ every 60s) | `rachel/venv/bin/python rachel/email-agent.py` | logs/email-agent.log | config/gmail-service-account.json |
| `rachel-whatsapp` | 127.0.0.1:3601 (nginx `/whatsapp/`) | `rachel/venv/bin/python rachel/rachel_whatsapp_bot.py` | logs/rachel-whatsapp.log | /etc/rachel.env + /etc/rachel-whatsapp.env |
| `shopping-agent` | 127.0.0.1:8300 | `node store-agent/shopping-agent.js` | logs/shopping-agent.log | /etc/gbrain.env |
| `gbrain-mcp` | 127.0.0.1:7700 | `bun run src/cli.ts serve --http --port 7700` (in ~/gbrain) | logs/gbrain-mcp.log | — |
| `rachel-monitor` | — | `python3 ops/monitor.py` | logs/monitor.log | — |
| `rachel-qa` (timer 08:00 UTC) | — | `rachel/qa/nightly.sh` | logs/qa-nightly.log, logs/fixer/ | /etc/rachel.env |
| `dashboard` | 127.0.0.1:9000 (`ssh -L 9000:localhost:9000`) | `node dashboard/server.js` | — | — |
| `webchat-video` — stopped + disabled (Oct 29) | was 8600 / 8443 | `node webchat-video/server.js` | — | webchat-video/.env |

### rachel — the chat brain (`rachel/server.js`)
Every Slack / WhatsApp / email / web / rachel_chat message goes through `/chat` here.
- Core: `server.js` (state machine: age gate → address → basket → order / proposal), `rachel.js` (LLM call + tool
  dispatch), `prompt.md` (system prompt, hot-reloads), `classify-intent.js` (intent classifier), `functions.js`
  (catalog search, buildPackage), `catalog-api.js`, `gbrain.js` (customer memory client), `data-dir.js`, `staging.js`,
  `log-tag.js`, `events.js`, `transcripts.js`, `ai-spend.js`, `channel-capabilities.json`
- Conversation / parsing: `age-answer.js`, `address-extract.js`, `instructions.js`, `multipick.js`, `order-wording.js`,
  `qty-order.js`, `tax-command.js`, `event-date.js`, `feedback.js`, `customer-prefs.js`, `customer-contacts.js`, `cta.js`
- Basket: `basket-line.js`, `basket-merge.js`, `basket-hygiene.js`, `line-resolve.js`, `list-reply.js`,
  `original-compare.js`, `pending-original.js`, `pack-standin.js`, `on-hand.js`, `product-match.js`, `search-match.js`,
  `package-subtotals.js`
- Events / drinks logic: `serving-mix.js`, `event-prefs.js`, `event-wishes.js`, `event-ceiling.js`, `mixers.js`,
  `mixer-guard.js`, `mi-campo.js`, `drink-type.js`, `spirit-type.js`, `package-facts.js`, `staff-quote.js`
- Email channel: `email-body.js`, `email-link.js`, `email-order.js`, `email-subject.js`, `email-utils.js`,
  `annotated-reply.js`, `quote-edits.js`, `order-file.js` (CSV / xlsx / Sheets / PDF order lists)
- Proposals / orders: `generate-proposal.js`, `proposal-guard.js`, `proposal-options.js`, `placed-order-msg.js`,
  `delivery-instructions.js`
- From store-agent/: `core-first.js`

### rachel-mcp — the MCP connector (`rachel/rachel-mcp.js`)
- Own: `rachel-mcp.js` (tools, age gating, Claude-app chat-only mode), `mcp-auth.js` (per-caller API keys),
  `mcp-oauth.js` (claude.ai OAuth sign-in), `proposal-email.js` (emails proposal PDFs), `cocktail-expand.js`
- Shared with rachel: `age-answer.js`, `address-extract.js`, `delivery-instructions.js`, `drink-type.js`,
  `spirit-type.js`, `email-utils.js`, `event-date.js`, `event-prefs.js`, `event-wishes.js`, `serving-mix.js`, `mixers.js`,
  `on-hand.js`, `original-compare.js`, `product-match.js`, `instructions.js`, `feedback.js`, `gbrain.js`,
  `generate-proposal.js`, `transcripts.js`, `ai-spend.js`, `data-dir.js`, `log-tag.js`
- Docs: `rachel/RACHEL_MCP_INTEGRATION.md`. Test: `ops/tests/mcp_connector_test.py`

### rachel-slack / rachel-email / rachel-whatsapp — channel bots (Python, all call rachel's /chat)
- `rachel/rachel_slack_bot.py` (also handles the #rachel-ops ✅/❌ fix approvals → `ops/deploy-fix.sh`)
- `rachel/email-agent.py` (state in logs/email-processed.json, logs/email-thread-sessions.json)
- `rachel/rachel_whatsapp_bot.py`, `rachel/invite.py` (WhatsApp invite helper); identities in logs/whatsapp-identities.json
- Shared Python env: `rachel/venv/`

### shopping-agent — catalog search, package building, orders (`store-agent/shopping-agent.js`)
- Own: `shopping-agent.js` (tools: search, menu_build, custom_list, alternatives, generate_proposal, place_order),
  `catalog-guard.js` (bad / duplicate rows, web market prices → logs/market-prices.json), `alternatives.js`,
  `core-first.js`, `order-lines.js`, `reviewer.js`
- Loaded from rachel/ at runtime: `catalog-api.js`, `functions.js`, `package-model.js`, `brand-lists.js` (+ `brand-lists.md`),
  `search-match.js`, `mixers.js`, `drink-type.js`, `spirit-type.js`, `event-ceiling.js`, `package-facts.js`, `gbrain.js`,
  `generate-proposal.js`, `event-date.js`, `address-extract.js`, `delivery-instructions.js`, `log-tag.js`
- Not run by any service: `store-agent/agent.js`, `orchestrator.js` (old per-store design), `catalog-sweep.js` (manual tool)

### gbrain-mcp — customer memory (/home/ubuntu/gbrain, third-party repo garrytan/gbrain, TypeScript on Bun)
- Entry `src/cli.ts` → `src/commands/serve.ts`, `serve-http.ts`; MCP layer `src/mcp/`; engine `src/core/`; `src/schema.sql`
  (739 .ts files — upstream code, not edited here)
- Data: ~/.gbrain/brain.pglite (embedded Postgres) + ~/.gbrain/config.json. Embeddings likely from ollama (below).
- Writers on our side: `gbrain-put.js` (top level), `rachel/gbrain.js`

### rachel-monitor + rachel-qa — monitoring, nightly QA, auto-fixer
- Monitor: `ops/monitor.py`, `ops/monitor.yaml`, unit file `ops/systemd/rachel-monitor.service`; output logs/findings.jsonl
- Nightly: `rachel/qa/nightly.sh` → `rachel/qa/run.py` (+ `qa/scenarios/*.yaml`, `qa/unit/*.test.js`, `qa/events.py`,
  `qa/fixtures/`), `ops/monitor.py --once`, `ops/proposal-cleanup.sh`, `ops/conversation-review.py`,
  `ops/activity-report.py`, `ops/ai-spend.py`, `ops/tests/mcp_connector_test.py`, `ops/tests/monitor_test.py`,
  `ops/fixer.py` (+ `ops/scope.yaml`; worktrees in ~/work/F-*)
- Fix deploys: `ops/deploy-fix.sh`. Deploy gate: `precheck.sh` (uses `ops/staging.sh`, `qa/run.py`).
  Staging test: `ops/tests/staging_test.sh`. Catalog lookup tool: `ops/catalog-search.py`
- Other QA: `rachel/qa/eval-classifier.js`, `rachel/evals/` (`run_evals.py`, `evals.json`), `ops/voiceflow/`
  (Voiceflow copies + `run-tests.sh`), `ops/tests/voiceflow_sync_live.js`

### dashboard — "Bevvi Agent Workbench" (`dashboard/server.js`)
- `server.js` (service status, log tails, orders feed, file viewer/editor, restarts, eval runs), pages `index.html`,
  `channels.html`, `evals.html`, `flow.html`, vendored `react.js`, `react-dom.js`, `reactflow.js`, `reactflow.css`
- Runs `evals/run_evals.py` (top-level evals/) from the Evals page

### webchat-video — video-chat prototype (stopped)
- `webchat-video/server.js` (HeyGen LiveAvatar token proxy, OpenAI TTS, bridge to rachel /chat), `public/index.html`,
  `public/vendor/`, `certs/` (self-signed TLS for 8443), `webchat-video.service` (copy of the unit)

### Rachel cron jobs (`crontab -l`, user ubuntu)

| When (UTC) | Source file | What it does | Log |
|---|---|---|---|
| 01:45 daily | `rachel/learn_packages.js` (identical copy at top level) | learns package patterns → logs/package-intelligence.json | logs/learn-packages.log |
| 02:00 daily | `seed_retailers.js` (+ `gbrain-put.js`) | retailers → gbrain | logs/gbrain-retailers.log |
| 02:30 daily | `seed_customers.js` (+ `gbrain-put.js`) | customers → gbrain | logs/gbrain-customers.log |
| 03:15 daily | `nightly-watchdog.js` | health checks → Slack (webhook in /etc/bevvi-watchdog.env) | logs/watchdog.log |
| 05:30 daily | `seed_order_history.js` | order history → gbrain | logs/order-history-sync.log |
| 09:00 Mon | `proactive-agent/agent.js` | finds customers due for reorder, emails them a link to Rachel | logs/proactive-agent.log |

Other top-level files: `deploy_rachel.sh`, `staging/` (staging data dir), `bevvi-qa/`, `scripts/`, `config/`
(gmail service account, mcp-oauth.json).

## 2. Bevvi transactions MCP — /opt/bevvi-mcp

| Unit | Port | Entry | Env |
|---|---|---|---|
| `bevvi-mcp` (user `bevvi`) | 127.0.0.1:8000 (nginx `mcp.getbevvi.com/mcp`) | `/opt/bevvi-mcp/.venv/bin/bevvi-mcp` | /etc/bevvi-mcp.env |

Bevvi transaction reports as an MCP tool. Source: `src/bevvi_mcp/server.py` (the server and tool),
`src/bevvi_mcp/manage_tokens.py` (access-token admin CLI), `src/bevvi_mcp/__init__.py`, `pyproject.toml`, `README.md`.

## 3. Bevvi Analytics Gateway — /opt/bevvi-analytics-gateway/current

| Unit | Port | Entry | Env |
|---|---|---|---|
| `bevvi-analytics-gateway` (user `bevvi-analytics`) | 127.0.0.1:8791 (nginx `mcp.getbevvi.com/analytics`) | `node scripts/analytics-gateway-server.mjs` | /etc/bevvi-analytics-gateway.env |

The "Bevvi Analytics" MCP (forecasts, monthly numbers, trends). Source:
- Entry `scripts/analytics-gateway-server.mjs`, which loads from `lib/analyticsGateway/`: `createMcpGateway.mjs`,
  `perplexityOAuthFlow.mjs`, `gatewayAuth.cjs`, `gatewayLimits.cjs`, `gatewayStoreSingleton.cjs`, `jobRecovery.cjs`,
  `modes.cjs`, `queuedJobDispatch.cjs`, `worker.cjs`, `artifactRetryScheduler.cjs`
- Analytics: `dailyForecast.cjs`, `monthlyNumbers.cjs`, `namedAnalytics.cjs`, `namedToolSchemas.mjs`, `decisionSupportV3.cjs`
- Jobs / storage: `jobStore.cjs`, `jobAdmission.cjs`, `jobClaim.cjs`, `jobBinding.cjs`, `reconcileJob.cjs`,
  `resultRetrieval.cjs`, `resultEnvelope.cjs`, `artifactDelivery.cjs`, `secureArtifactDownload.mjs`
- Upstream compute: `computerMcpClient.cjs`, `computerMcpLive.mjs`, `pythonToolsListLoader.cjs`; OAuth:
  `perplexityOAuthProvider.mjs`, `perplexityOAuthStore.cjs`, `perplexityTokenStore.cjs`
- Remaining `lib/analyticsGateway/*.cjs` are validation / policy helpers; `scripts/analytics-gateway-*.mjs` other than
  the server are acceptance / smoke tests; `data/` holds its state; release checksums in `*.SHA256`.

## 4. Bevvi Support Agent — /var/www/bevvi-support-agent (not in git here)

| Unit | Port | Entry | Log |
|---|---|---|---|
| `bevvi-support` | 127.0.0.1:5000 (nginx default site on :80 — Zapier posts support@ emails to `http://3.138.180.46/webhook/email`) | gunicorn, 4 workers, `email_webhook:app` | /var/log/bevvi-support/{access,error}.log, agent.log |

Drafts replies to support@getbevvi.com emails with Claude + a knowledge base, sends the drafts only to
dipanjan@ / bevvi-support@ for review, records verdicts in Supabase. Source:
- `email_webhook.py` — the whole live service (Flask app: `/webhook/email`, `/review/<ticket>/<verdict>`, `/review/stats`,
  `/health`; drafting with Claude; Gmail read + send as support@), `requirements.txt`, `.env`, `service-account.json`
- Knowledge base: Supabase table `kb_articles` (reviews in `draft_reviews`; schema `bevvi_support_agent_schema.sql`),
  refreshed by `daily_kb_update.py` (cron 06:00 daily → daily_kb_cron.log); admin `admin_cli.py`
- Not used by the running service: `support_agent.py` (earlier standalone agent), `build_kb_*.py`,
  `build_comprehensive_kb.py`, `email_webhook_old.py`, `email_webhook_with_kb.py`, `email_webhook.py.backup`, `test_kb.py`,
  build output `kb_final.json`, `generated_kb.json`, `kb_drafts.json`, `threads_*.json`, `all_emails_raw.json`

## 5. OpenClaw (personal AI gateway) — user-level unit

| Unit | Port | Entry |
|---|---|---|
| `openclaw-gateway` (`systemctl --user`, unit ~/.config/systemd/user/openclaw-gateway.service) | 127.0.0.1:18789 | `~/.local/opt/node24/bin/node ~/.local/opt/openclaw/lib/node_modules/openclaw/dist/index.js gateway` + spawn-broker / sqlite worker children |

Installed npm package (no source of ours). Code: `~/.local/opt/openclaw/lib/node_modules/openclaw/dist/`. Config + state:
`~/.openclaw/openclaw.json` (+ `.bak*`, `.last-good`), `agents/`, `memory/`, `credentials/`, `cron/`, `logs/`;
log ~/openclaw.log; backup ~/backups/openclaw-20261025T141035Z. Runs on its own Node 24 (~/.local/opt/node24).
Largest process on the box (~1.2 GB RSS).

## 6. Shared infrastructure

| Unit | Port | Files |
|---|---|---|
| `nginx` | :80, :443 | `/etc/nginx/sites-available/bevvi-mcp.conf` (mcp.getbevvi.com: /mcp→8000, /rachel/→3600, OAuth well-knowns→3600, /whatsapp/→3601, /analytics→8791, /proposals/ PDFs from logs/), `rachel` (3.138.180.46 HTTPS: /rachel/→3500, /chat static from /var/www/bevvi, /proposals/), `bevvi-support` (default :80 → 5000). Backup copy in /etc/nginx/backup/. TLS: certbot (certbot.timer). |
| `ollama` (user `ollama`) | 127.0.0.1:11434 | `/usr/local/bin/ollama`; one model, `nomic-embed-text` (embeddings) |
| `cron` | — | `crontab -l` (user ubuntu), /etc/cron.d/{certbot,e2scrub_all,sysstat} |

OS / AWS services (not project-related): sshd, amazon-ssm-agent (snap), snapd, systemd-*, chrony, rsyslog, fwupd,
ModemManager, udisks2, multipathd, unattended-upgrades, sysstat / logrotate / apt timers.

Disabled units still installed (old per-store design, not running): `orchestrator`, `store-agent`, `store-agent-*`,
`slack-rachel`, `webchat-video`.
