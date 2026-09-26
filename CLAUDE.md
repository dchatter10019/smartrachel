# Rachel — Bevvi's AI beverage ordering agent

## What this is
Rachel takes drink orders and event requests over Slack, email and WhatsApp, searches Bevvi's catalog,
builds priced baskets, generates PDF proposals and places orders. Owner: DC (dipanjan@getbevvi.com).
Rachel sends from rachelai@getbevvi.com. Repo: github.com/dchatter10019/smartrachel (this directory).

## Architecture (all systemd, all on this box)
- rachel (port 3500): rachel/server.js = state machine (age gate → address → basket → order/proposal)
  + rachel/rachel.js = LLM tool dispatch + rachel/classify-intent.js (Sonnet intent classifier)
  + rachel/prompt.md (system prompt, hot-reloads) + rachel/functions.js (search, buildPackage)
- shopping-agent (port 8300): store-agent/shopping-agent.js → Bevvi API (client=bevvibot, zipcode= search)
- gbrain (port 7700): customer memory; rachel/gbrain.js. rachel-mcp (3600). WhatsApp bot (3601).
- rachel-slack: rachel/rachel_slack_bot.py (Bolt, Socket Mode). Log: logs/slack-rachel.log
- rachel-email: rachel/email-agent.py (polls rachelai@ inbox every 60s, every email → Rachel chat,
  thread→session map in logs/email-thread-sessions.json). Log: logs/email-agent.log
- rachel-whatsapp: rachel/rachel_whatsapp_bot.py (Flask + Twilio; invite gate; admin page). Env: /etc/rachel-whatsapp.env
- Proposals: rachel/generate-proposal.js. Address geocoding: Google Maps (geocodeAddress in server.js).
- Logs: /home/ubuntu/logs/ (rachel.log, shopping-agent.log, ...). Journal is NOT where bots log.

## Secrets (never print them)
- /etc/rachel.env: Slack tokens, ANTHROPIC_API_KEY, GOOGLE_MAPS_API_KEY, QA_SLACK_CHANNEL, SLACK_QA_USER_TOKEN
- The `rachel` service does NOT read /etc/rachel.env — its secrets are Environment= lines in
  /etc/systemd/system/rachel.service. A key changed in one place must be changed in both.
- Gmail service account: /home/ubuntu/config/gmail-service-account.json (domain-wide delegation).

## Rules — follow every time
1. Deploy rachel/shopping-agent ONLY via `/home/ubuntu/precheck.sh --deploy`: lint → restart the
   services whose files changed → smoke set against the new code. If the service doesn't come up or
   smoke fails, it stashes the uncommitted rachel/ + store-agent/ changes (`git stash pop` restores),
   restarts on HEAD and re-smokes. Never a bare `systemctl restart`. Deploy BEFORE committing — a clean
   tree has nothing to roll back. Plain `precheck.sh` = lint only; `--smoke` tests the live service.
2. Ask DC before running anything that places a real order, sends a real email/message, or changes
   systemd units, nginx, or secrets.
3. Commit with a message that names the real bug and the fix; `git push` after. Commit scope: rachel/,
   store-agent/, precheck.sh. qa/runs/ is gitignored.
4. Compliance: age verification is per session, never inherited from a saved profile. Never weaken it.
5. QA identities are dry-run on every channel: session ids starting `qa-`, and emails qa-*@getbevvi.com
   / rachel_qa@getbevvi.com (server.js isQA). They never train the price profile (gbrain.saveBasket).
6. Deterministic over LLM: when a behavior must be reliable (routing, quantities, proposal options,
   picks), handle it in code and log the decision. The LLM narrates; it does not decide.
7. Log the reason for every discard/refusal (e.g. '[buildPackage] UNAVAILABLE (size mismatch)').
   A silent drop is a bug.

## QA harness (rachel/qa/)
- `./qa/run.py` all 17 scenarios; `--smoke` pre-deploy subset (~3 min); `--only <name>`; `-v`.
- Scenarios are YAML in qa/scenarios/. Assertions: contains / not_contains / matches / log_contains /
  pdf_contains / pdf_not_contains, plus a Haiku `judge` — prefer structural checks; the judge is
  unreliable on nuanced criteria. `transport: slack` (real DM as rachel_qa) and `transport: email`
  (real mail as rachel_qa@) scenarios are tagged `channel` and run nightly only.
  `transport: whatsapp` posts a Twilio-signed webhook as QA phone +19173024521 (pinned to
  qa-whatsapp@getbevvi.com in logs/whatsapp-identities.json → dry-run) and reads Rachel's real Twilio
  sends back from the Twilio API. Handset delivery is reported, not asserted (needs the phone on
  WhatsApp and a message from it to Rachel within 24h, else Twilio 63024/63016).
- Nightly: rachel-qa.timer 08:00 UTC → qa/nightly.sh → summary posted to Slack #rachel_ai_qa.
  Each run snapshots replies in qa/runs/<stamp>/ and diffs vs the previous run.
- When a scenario fails: read qa/runs/<stamp>/<scenario>.json first, then the logs. Decide whether
  it's Rachel or the assertion before changing either. Every real bug becomes a scenario.

## Known-good facts
- Search: api-client.getbevvi.com with client=bevvibot and zipcode=; the location= variant returns nothing.
  NYC 10019 store 5f4d1e12…, Boston 02110 689fa0c7…, SF 94104 679dadac….
- A customer-named product is never dropped for price caps; a stated size sorts first.
- Multi-pick resolver only fires on a real numbered options list + a selection-shaped message.
- A substantive first message (an order) is kept through the age gate (pendingIntent) and replayed.

## Open items
- WhatsApp QA phone +19173024521 has no handset and is not a Twilio number: replies come back 63024
  (expected; content is still asserted). Deferred by DC (Sep 26): register it (or a new Twilio number)
  as a WhatsApp sender for true end-to-end — needs one OTP to the number + an approved utility template
  for each run's first message. Switch WhatsApp to Meta Cloud API.
- Stripe payment: backend needs stripeCustomerId param on createCorpPayByLinkOrder (spec shared).
- Rotate: Slack bot + app tokens, Anthropic key, Google Maps key (exposed in chat on Sep 25).
- Installable Slack app; SMS on the 518 number (10DLC pending); Apple Messages for Business.
