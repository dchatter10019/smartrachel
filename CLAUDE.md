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
- gbrain (port 7700): customer memory; rachel/gbrain.js. rachel-mcp (3600, 127.0.0.1 only) = the "rachel" MCP connector,
  public at https://mcp.getbevvi.com/rachel/mcp (nginx /rachel/ -> :3600; the "bevvi" transactions MCP is /mcp -> :8000).
  Per-caller API keys (mcp-auth.js: /rachel/auth/request-key -> emailed code -> /rachel/auth/verify-code; 5 wrong codes
  cancel it). Age verified per API key (4h idle; kept by key hash in RACHEL_DATA_DIR/mcp-age.json so a deploy doesn't re-ask;
  verify_age confirmed:false clears it), never saved to the profile (rule 4). rachel_build_package = shopping-agent menu_build,
  the builder Slack/email use (was custom_list with category words as products), with Rachel's intake in code: missing guests /
  hours (or drinks per guest) / budget / drink types asked in ONE needs_info.ask_customer, then a mixed event's "what will your
  guests drink most?" (rachel/serving-mix.js, shared with server.js); only zip is required, so the client can't invent values.
  Cocktails: named none -> Rachel's "which cocktails?" list; named -> rachel/cocktail-expand.js (Sonnet 4.6, guided by prompt.md
  "Cocktail mode" + 8.3 read live — no recipe table in code, DC: hundreds of cocktails; unknown name asked back; spend ledger
  kind cocktail-expand) -> custom_list (Wine/Beer lines + every ingredient), as Rachel's cocktail mode. rachel_chat: a connection
  that passed rachel_verify_age tells Rachel via POST /internal/age-verified {session_id, via:'rachel-mcp'} (refused when proxied
  or after a refusal in 24h; an idle session is expired there first, else /chat's idle expiry wiped the check — Oct 4) -> that conversation only skips her age question, never the profile (DC approved, Oct 3). Tool descriptions + server instructions OPEN with when to use them (drink recommendations, events, buying / delivery,
  "even if they don't mention Bevvi") — claude.ai shows only a description's first line until a tool is loaded, and a plain
  "recommend a wine" didn't reach Rachel (DC, Oct 5). rachel-mcp.log: `initialize by <email> (client ...)` and `tools/list by
  <email> — descriptions <hash>` (TOOLS_HASH changes with every description edit) show when a client re-reads them. Clients are told (server instructions + rachel_search description + the not-found note) never to comment on the search or
  tools — false matches, categories, data quality, tool errors — only what is/isn't available and the next step (DC, Oct 6). Clients never get product urls/slugs
  (also inside JSON-text fields and chat text), buyer tier or reviewer notes; told not to judge prices (DC, Oct 3). Orders are two-step:
  rachel_place_order PREPARES (server /internal/order-preview: catalog linking, real delivery windows, totals) and returns
  a 15-min one-use confirmation_code bound to the key; rachel_confirm_order places it (QA identities dry-run). Streamable
  HTTP: JSON or SSE by Accept, notifications 202, protocol version echoed. claude.ai sign-in = OAuth 2.1 (rachel/mcp-oauth.js, DC Oct 3):
  discovery /.well-known/oauth-protected-resource/rachel/mcp + /.well-known/oauth-authorization-server/rachel (+ root),
  dynamic client registration, a Bevvi sign-in page (email -> 6-digit code, same as the API keys), PKCE S256, access
  tokens 30d / refresh 90d rotated, stored hashed in config/mcp-oauth.json; the 401 carries WWW-Authenticate
  resource_metadata. API keys still work. QA emails never get the code mailed. ops/tests/mcp_connector_test.py (nightly)
  runs both paths on the public URL. nginx routes for /rachel/ and the well-known paths are not in the repo. WhatsApp bot (3601).
- rachel-slack: rachel/rachel_slack_bot.py (Bolt, Socket Mode). Log: logs/slack-rachel.log
- rachel-email: rachel/email-agent.py (polls rachelai@ inbox every 60s, every email → Rachel chat,
  thread→session map in logs/email-thread-sessions.json). Log: logs/email-agent.log. "New" = an inbox email
  (3 days) not in logs/email-processed.json — NOT the UNREAD label (an email opened in Gmail first is still
  handled). A new thread asks /internal/email-link (email-link.js) whether it continues an earlier quote
  (same sender; a proposal PDF of it attached/linked, the client name, or — for an edit request — the one quote
  whose event date / venue / total matches, or the sender's only quote in 14 days). Several possible: the new
  thread asks "which proposal?" (numbered), holds the email, and the answer relinks the thread to that quote
  and replays it there (state.pendingLink; `relink` in the /chat reply). Replies attach the PDF by its real name. Server-side, email bodies are cut to
  the new text + a forwarded message (email-body.js); quoted history never reaches Rachel. The sender's signature is
  cut too (stripSignature: "-- ", a line that is the From name, or a trailing contact block). The first real request
  (a list) is kept as state.originalRequest and shown to the LLM every turn, with state.onHand. On every
  continuation the agent sends the thread's first non-Rachel email (context.thread_first_body); a session with no
  originalRequest takes it from there (threads older than the feature), and a later email never becomes the original.
  Replies are reply-all (To + Cc of the incoming email, minus rachelai@ and the sender).
  Automated mail is skipped and marked read, never run through Rachel (email-agent automated_reason, "Skipping automated
  email ... (<reason>)"): Bevvi's own notifications from info@getbevvi.com ("Your Order is Updated / On its Way", "Corporate
  Order Fulfilled: BEVVI-...", password resets — they reach rachelai@ because it is every order's account email), and
  Auto-Submitted / Precedence bulk|junk|auto_reply (not List-Id: Google Groups). Until Oct 6 each got 3 retries, a
  Slack "needs a person" alert and a holding email back to info@. An HTML-only email (no text/plain) is read from its
  HTML part ([html-body]); it used to reach Rachel empty.
  A payment-link reply for a customer ("send the link to inge@... and copy Sean and me") goes To the customer, Cc the sender
  + the thread (server email_to -> email-agent recipients()). Every email has an HTML part (email-agent to_html): a payment link shows as a clickable "Payment Link",
  never the token URL (DC, Oct 3; Slack: <url|Payment Link>); the plain part keeps full URLs. Every email opens "Hi <first name>," and ends "Warmly, Rachel /
  Your personal mixologist at Bevvi" (email-agent dress(); DC Oct 3: cordial, Rachel is their personal mixologist); the
  plain/email channel note tells the LLM that voice and not to add its own greeting/sign-off.
- The client an email subject names: email-subject.js clientFromSubject ("Goody alcohol order" -> Goody, "... - Gen II
  Fund", "Bar order for Acme"), used by the quote PDF, quote edits and the proposal flow. An email that carries its own
  item list (3+ item lines) never enters the step-by-step proposal flow — it takes the [quote-pdf] path (client from the
  subject, date from the email). When the flow does run, it fills the client from the subject and the date from
  state.originalRequest before asking. (Oct 2: after the age gate DC was asked both, and the flow reloaded an older
  gbrain basket; QA identities have no saved basket, so QA never took that path.)
- Email orders (email-order.js, server.js EMAIL ORDER): "create/place the order", "payment link" in an email
  places the order in code (shopping-agent place_order, no LLM) and replies with the payment link. Contact =
  the customer in the email (a forwarded customer's header + signature; the sender unless @getbevvi.com; from a
  @getbevvi.com sender: the on-site contact "Main POC is Mara (862) ..." = name + phone, and the address the payment
  link "should be sent to" = email); a "delivery instructions:" paragraph is kept (Gmail link clutter cut); no date
  given = the event date, with its real windows offered; a first name alone asks only for the last name; a pasted form ("Customer Name:" with the value on the NEXT line)
  is read; "It's <First Last>" corrects the name; "<X> is not the customer" is remembered (od.not_customer) and the on-site
  contact's first name never replaces a full customer name; a field still missing is taken from the thread's earlier
  emails; the LLM's place_order is refused in email threads (EMAIL_ORDER_IN_CODE) (Oct 3, Foodie For All: Mara asked 4x); all
  missing fields (name, email, phone, delivery date+time checked against real windows) asked in ONE reply (sender only, no cc),
  kept in state.emailOrder until the answer places it. Tip 5% unless stated. A repeat re-sends the link.
- Basket lines with no catalog link (a hand-built quote) are linked by line-resolve.js — same price AND name
  fits, exact only, else asked — on /internal/session-basket loads, when checkout starts on any channel (the
  delivery-window check needs the lines' store), before placing, and before an email order is placed.
- rachel-whatsapp: rachel/rachel_whatsapp_bot.py (Flask + Twilio; invite gate; admin page). Env: /etc/rachel-whatsapp.env
- Proposals: rachel/generate-proposal.js; each PDF's line items → logs/proposal-items/<pdf>.json (load one into a
  session: POST localhost:3500/internal/session-basket {session_id, from_proposal}). nginx /proposals/ serves
  ONLY bevvi-proposal*.pdf (sites rachel AND bevvi-support; until Sep 29 it served all of logs/). Address geocoding: Google Maps (geocodeAddress in server.js).
- Logs: /home/ubuntu/logs/ (rachel.log, shopping-agent.log, ...). Journal is NOT where bots log.
- Token use (DC, Oct 3: cost is the goal): the system prompt is ONE block (prompt.md + channel note), identical for every
  customer — prompt.md's {user_email}/{kitchen_location}/{client_id}/{account_id}/{age_verified} render as "<x from SESSION
  FACTS>"; the values, address/basket rules, memory and this turn's notes ride on the customer's latest message AFTER a
  cache breakpoint (<rachel_system_notes>, request-only, never stored in history). Breakpoints: system, the latest customer
  message (next turn reuses the whole earlier conversation), the last tool result. Before: the customer's details were in
  the cached block -> 138/146 conversations rebuilt ~20k tokens; after: 0 cold starts, $0.036 -> $0.017 per call. Every
  call logs `[usage] rachel iteration N: input, cache read, cache write, output`. The classifier prompt is too small to cache.
- Transcripts + nightly conversation review (DC, Oct 7: "log every conversation and analyze end of the night"):
  every /chat turn on every channel -> RACHEL_DATA_DIR/transcripts.jsonl (rachel/transcripts.js, written from events.finish;
  replies sent before the event wrapper by a fallback in /chat; customer message, Rachel's reply, action/state/basket), and
  every connector tool call with what the client was shown (rachel-mcp.js executeTool; search/recommend/build = product
  name, size, price). conversations.jsonl (order/proposal only) is unchanged. Connector /chat turns are channel "mcp" (were
  counted as email); rachel-mcp.log lines carry timestamps. Nightly (qa/nightly.sh, before the monitor pass):
  ops/conversation-review.py reads the conversations since the last review (QA skipped), Sonnet 4.6 reviews each (no-order /
  pushback first; ops/monitor.yaml conversation_review: max_usd 3, max_conversations 40; ~$0.01 per conversation; ai-spend
  kind conversation-review) -> logs/conversation-reviews/<date>.json + high/medium issues -> logs/review-issues.jsonl ->
  monitor detector conversation_review -> fixer (in scope.yaml fix_detectors; prompt.md stays protected, so a prompt change
  comes back as "Needs a decision"). The summary rides on the nightly QA Slack post. `--dry` lists, `--hours N` re-runs a
  window without moving the bookmark, REVIEW_OUT / RACHEL_TRANSCRIPTS_FILE for test runs.
  A «qa-» session is never reviewed, by any row (Oct 9: connector tool rows carried qa by caller email only, so qa-manual
  sessions were reviewed from the reply-less tool rows -> 4 false "Rachel never replied / no age check" findings,
  F-0025..28). Review max_tokens 4000 (1500 cut a 26-turn review mid-JSON -> no review; a cut logs "hit max_tokens").
- Daily activity report (DC, Oct 9): ops/activity-report.py (yesterday UTC, `--day`), from transcripts.jsonl, no model calls,
  QA excluded: per channel each person, messages (connector: steps + which tools), what they asked, how it ended (order /
  proposal / basket, no order / browsed). Appended to the nightly QA Slack post (qa/nightly.sh, after AI spend).
- AI spend ledger (DC, Oct 3): every Anthropic call (rachel.js main, classifier, image reading, reviewer, catalog-guard web
  prices, QA judge) appends {ts, kind, model, test, env, tokens, usd} to logs/ai-spend.jsonl via rachel/ai-spend.js (price
  table there — update it when prices/models change; an unknown model logs [ai-spend] no price). test = staging, a «qa-»
  session or a QA email. ops/ai-spend.py = yesterday + month to date (customers / tests / auto-fixer, merges
  logs/fixer/spend.jsonl), appended to the nightly QA Slack summary. gbrain's own model calls are not covered.
- Model choice, measured Oct 3 (DC: cost). Main call stays claude-sonnet-4-6: on the 22-scenario smoke set Sonnet 5.5 cost
  $0.90 (medium, 21/22) / $0.70 (low, 19/22, order placement broke) vs 4.6 $0.86 22/22 — 5.5's tokenizer uses ~40% more
  tokens, cancelling its price. Re-test: `RACHEL_MODEL=claude-sonnet-5-5 RACHEL_EFFORT=medium ops/staging.sh start ...`
  (rachel.js sends between_tools thinking + effort + server-side fallback for 5.x, temperature 0.3 for 4.6). Classifier
  stays Sonnet 4.6: on 228 real customer turns (qa/eval-classifier.js) Haiku routed 14% differently, mostly wrongly ("set
  tax to 0" -> change_instructions); Sonnet 5.5 is less confident and sends more turns to the (dearer) main LLM. The
  SHADOW classifier call (a paid call per message, label only logged) was removed. catalog-guard web prices: Opus 5.5
  (was Opus 5; same tokenizer, 20% cheaper).
- Rachel's state (flow-state.json, chat-sessions.json, conversations.jsonl, baskets.json, customer-contacts.json,
  events.jsonl) lives in RACHEL_DATA_DIR (rachel/data-dir.js; default /home/ubuntu/logs). A Rachel on any port but
  3500 REFUSES to start on the production dir — a second instance would rewrite live sessions.
- Staging (ops/staging.sh start [tree] [--with-shopping-agent] | stop | status): the tree's rachel on :3501 with QA_MODE=1
  (rachel/staging.js: every session dry-run, sendEmail logs instead of sending, place_order always dry_run, catalog-guard
  alerts not posted), RACHEL_DATA_DIR=/home/ubuntu/staging/data (wiped on start), no channel bots, the production units'
  env read via `systemctl show` (never printed; no sudo needed). Shopping-agent: production's :8300, or with
  --with-shopping-agent the tree's own on :8301 (SHOPPING_AGENT_URL / SHOPPING_AGENT_PORT; store-agent loads rachel/
  modules relative to its own tree). Logs: logs/staging-rachel.log, logs/staging-shopping-agent.log. Proposal PDFs and
  proposal-items are still written to the shared logs/. `qa/run.py --url http://127.0.0.1:3501` tests it (staging logs +
  staging events.jsonl, channel-transport scenarios skipped, runs in qa/runs-staging/). ops/tests/staging_test.sh =
  acceptance test (smoke passes on staging, nothing sent, production never restarted).

## Secrets (never print them)
- /etc/rachel.env: Slack tokens, ANTHROPIC_API_KEY, GOOGLE_MAPS_API_KEY, QA_SLACK_CHANNEL, SLACK_QA_USER_TOKEN
- The `rachel` service does NOT read /etc/rachel.env — its secrets are Environment= lines in
  /etc/systemd/system/rachel.service. A key changed in one place must be changed in both.
- Gmail service account: /home/ubuntu/config/gmail-service-account.json (domain-wide delegation).

## Rules — follow every time
1. Deploy rachel/shopping-agent/rachel-email/rachel-mcp ONLY via `/home/ubuntu/precheck.sh --deploy`: lint → restart the
   services whose files changed (rachel-mcp: rachel-mcp/mcp-auth/mcp-oauth/gbrain/generate-proposal.js; a hand restart
   has no deploy log and the monitor calls it a crash — F-0014, Oct 3) → smoke set against the new code. If the service doesn't come up or
   smoke fails, it stashes the uncommitted rachel/ + store-agent/ changes (`git stash pop` restores),
   restarts on HEAD and re-smokes. Never a bare `systemctl restart`. It waits for rachel's in-flight chats
   (/internal/inflight) before restarting, and rachel finishes running chats on SIGTERM (max 80s). Deploy BEFORE committing — a clean
   tree has nothing to roll back. Plain `precheck.sh` = lint only; `--smoke` tests the live service.
   `precheck.sh --deploy --stage-first` (the default to use): the 22-scenario smoke set on staging from the working tree
   FIRST — a change that fails there never restarts production; production then gets only the 4-scenario `prodcheck`
   set (tag prodcheck; `qa/run.py --tag <t>`). DC (Oct 2): deploy without asking, then commit + push.
   DC (Oct 3, cost): NO full suite after deploys — the gate is staging smoke + prodcheck; the full suite (`./qa/run.py`,
   ~$15-20 of Rachel tokens) runs only in the 08:00 UTC nightly. Fix/revert whatever the nightly shows newly failing.
   Don't run staging and a production full suite at the same time (shared box; turns time out).
2. Ask DC before running anything that places a real order, sends a real email/message, or changes
   systemd units, nginx, or secrets.
3. Commit with a message that names the real bug and the fix; `git push` after. Commit scope: rachel/,
   store-agent/, ops/, precheck.sh, .gitignore and CLAUDE.md (update it in the same commit when a fact here changes).
   qa/runs/, qa/runs-staging/ and staging/ are gitignored.
4. Compliance: age verification is per session, never inherited from a saved profile. Never weaken it.
5. QA identities are dry-run on every channel: session ids starting `qa-`, and emails qa-*@getbevvi.com
   / rachel_qa@getbevvi.com (server.js isQA). They never train the price profile (gbrain.saveBasket).
6. Deterministic over LLM: when a behavior must be reliable (routing, quantities, proposal options,
   picks), handle it in code and log the decision. The LLM narrates; it does not decide.
7. Log the reason for every discard/refusal (e.g. '[buildPackage] UNAVAILABLE (size mismatch)').
   A silent drop is a bug.

8. EVERY CHANNEL, ALWAYS (DC, Oct 5 — "make this a rule, never to deviate"): every behavior change must work the same on
   Slack, WhatsApp, email AND the MCP connector. Before deploying, trace each channel's path for the change (Slack and
   WhatsApp share /chat; email = /chat plus the email-order / quote-pdf / quote-edits code; the connector = rachel-mcp.js
   tools, /internal/order-preview, /internal/* and rachel_chat) and fix or extend the ones that miss it; test at least
   one non-Slack channel (an email scenario, a direct /internal call or the connector test). Never ship a Slack-only fix.

## Debug-and-fix loop (spec: "Rachel — Automated Debug-and-Fix Loop", Sep 29)
- Step 1 staging: done (see Staging above). Step 2 monitor: ops/monitor.py (thresholds ops/monitor.yaml) reads the logs,
  events.jsonl, qa/runs/*/summary.json, the watchdog log and the six services' state; appends findings to
  logs/findings.jsonl (deduped 7 days; evidence redacted; a log file created after the monitor started is read from line 1 — Oct 7:
  review-issues.jsonl's first 3 issues were skipped as history). `ops/monitor.py --status` lists open findings, `--replay <log>`
  tunes thresholds, `--once` one pass. Customer-facing detectors skip QA (tag «qa-», events qa:true, qa- session ids).
  Runs as rachel-monitor (unit in ops/systemd/, installed by DC). Critical findings post to OPS_SLACK_CHANNEL once set.
  ops/tests/monitor_test.py runs in the nightly QA. Interactive sessions: check `ops/monitor.py --status` first.
- Step 3 fixer (ops/fixer.py): per open finding, classified by ops/scope.yaml (fix vs diagnose-only detectors; protected
  paths/patterns refuse a branch), headless Claude Code in a worktree (~/work/<id>, branch fix/<id>) writes a scenario + fix;
  fixer.py then proves it itself (scenario fails on staging from base, passes from the branch, smoke passes). Result ->
  logs/fixer/<id>.json + a review post (logs/fixer/<id>.post.txt until OPS_SLACK_CHANNEL is set). `--plan` = classify only,
  no tokens; `--finding F-…`; kill switch: ops/PAUSE. SCHEDULED (DC, Oct 3): qa/nightly.sh runs monitor --once then
  fixer.py after the QA Slack post (PATH gets ~/.npm-global/bin for the claude CLI; log logs/fixer/nightly.log).
  Spend (DC, Oct 3; ops/monitor.yaml fixer:): $15 per UTC day across runs, $5 hard cap per fix (claude --max-budget-usd), max 3
  fixes; a fix starts only if the full $5 still fits. A run with no reported cost (timeout/crash) is charged the $5 cap, never
  $0. Every run -> logs/fixer/spend.jsonl; each pass ends with a spend report (tonight + month to date) posted to Slack /
  logs/fixer/spend-report.txt. `ops/fixer.py --spend` prints it. Model pinned: fixer.model = claude-opus-5-5 (billed to the
  server's ANTHROPIC_API_KEY). --max-budget-usd is checked between steps, so a run can end slightly over $5.
  Seed acceptance test passed twice on Oct 3 ($0.66, $1.11).
  Oct 4 (F-0015): the agent found both causes and wrote the fix, but 16 commands were refused (logs / failing run outside
  its worktree, `git -C`, its own lint) and it hit 60 turns uncommitted -> "couldn't find a fix". Now: --add-dir read access
  to logs/, qa/runs/, qa/runs-staging/ (writes denied), `git -C <wt> ...` + `<wt>/precheck.sh` allowed, ops/catalog-search.py
  for the live catalog (no curl), TOOL RULES in the prompt, max_turns 150, refused commands logged, and work left
  uncommitted is committed by fixer.py (salvage) and offered only if the proof passes. The post names the real reason.
  Nightly side tests (connector test, monitor self-test) -> logs/side-tests.jsonl -> detector side_test (diagnose only).
- Every Slack message of the loop (fixer posts, monitor urgent alerts, deploy-fix.sh results, the bot's ✅/❌ replies) is
  written for DC as a non-engineer (DC, Oct 3): what customers saw / how often / why / what changed / how checked / risk,
  from the agent's plain_* JSON fields + monitor.PLAIN per detector; code, files and branches only in a "For engineers"
  footer. Headings keep "Fix ready — F-nnnn" / "Needs a decision — F-nnnn" (the reaction handler parses them).
- logs/findings.jsonl has several writers (monitor service, fixer, deploy-fix.sh, Slack ❌, by hand). Store merges per item:
  an item this process changed since its last sync wins, others take the file's version (before Oct 3 the monitor's stale
  copy won, reverting every outside status change — the fixer would have re-fixed, and re-paid for, the same finding).
- Step 4 deploy (ops/deploy-fix.sh <id>): ✅ by an approver on the fixer post (rachel_slack_bot.py reaction_added), or a TYPED
  ✅/❌ ("approve", "F-0016 ✅", in the post's thread or as a new #rachel-ops message -> the named / threaded / only waiting
  fix; several waiting = asked which; handle_ops_message, [fix-review] log; Oct 5: DC's typed ✅ was ignored) →
  scope re-check, fast-forward-only, precheck --deploy --stage-first, push; rollback + master reset on failure; ❌ discards.
  /etc/rachel.env (Oct 3): OPS_SLACK_CHANNEL = #rachel-ops C0C6E8CER9Q, OPS_TEST_CHANNEL = #rachel-ops-test C0C6CEA8VRC
  (--dry-post), OPS_APPROVERS = DC U04NB3GDUC8. ✅ also needs the Slack app's reaction_added event + the bot in both channels.

- Learning from people (DC, Oct 3): a correction in any message ("I already told you", "X is not the customer", "that's
  wrong"; feedback.js correctionIn), a "Rachel feedback: ..." line (recorded + thanked in code, the rest of the message
  handled as usual) and a Slack 👎 on a Rachel reply (rachel_slack_bot.py, thanked in the thread) -> logs/feedback.jsonl
  with what Rachel said before -> monitor detector `feedback` (QA skipped) -> finding -> nightly fixer (fix_detectors).
  Dissatisfaction in any words (DC, Oct 7: people won't write "Rachel feedback") = kind "unhappy": live, feedback.js unhappyIn
  ("I asked for X but you...", "you answered wrong", "not what I expected", "you forgot", "makes no sense", frustrated...;
  0 false hits on 449 scenario/real messages); nightly, the conversation review lists EVERY unhappy customer message
  (unhappy_messages, any phrasing/language) and writes the ones the live words missed to feedback.jsonl (source "review"),
  unless one of its own high/medium issues already quotes it (never two fixer runs for one problem); the Slack summary
  shows them. Rachel's reply is unchanged. Connector: tool rachel_feedback (customer_said, about; readOnlyHint so claude.ai
  doesn't ask permission; before the age gate) + a server-instructions sentence ("whenever the customer is unhappy with
  anything Rachel gave them ... call rachel_feedback with their exact words, without mentioning it") -> feedback.jsonl
  source "connector", rachel_said = what that caller's last tool call showed; ops/tests/mcp_connector_test.py checks it.
- Customer preferences (customer-prefs.js -> RACHEL_DATA_DIR/customer-prefs.json): lasting statements ("we always do cans",
  "from now on...", "we never serve red", "can you always...") saved per customer email and per client ("client:goody");
  Bevvi staff in a client's email thread -> the client only; a QA identity -> its own address only. Shown to the LLM on
  every turn ([prefs] N preference(s) shown); a new one is acknowledged in code if the reply didn't; "forget the X
  preference" removes it. The suggestion-acceptance reordering (cta.js Phase 3) waits for more data (DC, Oct 3).

## QA harness (rachel/qa/)
- `qa/unit/*.test.js`: pure-logic unit tests on saved real replies (multi-pick resolver), run by every
  `precheck.sh` lint/deploy. Lint also enforces eslint no-use-before-define (runtime TDZ errors).
- `./qa/run.py` every scenario in qa/scenarios/ (74 files on Oct 2); `--smoke` pre-deploy subset (~3 min); `--only <name>`; `-v`.
- Scenarios are YAML in qa/scenarios/. Assertions: contains / not_contains / matches / not_matches / log_contains / log_not_contains /
  pdf_contains / pdf_not_contains, plus a Haiku `judge` — prefer structural checks; the judge is
  unreliable on nuanced criteria. `transport: slack` (real DM as rachel_qa) and `transport: email`
  (real mail as rachel_qa@) scenarios are tagged `channel` and run nightly only.
  `transport: whatsapp` posts a Twilio-signed webhook as QA phone +19173024521 (pinned to
  qa-whatsapp@getbevvi.com in logs/whatsapp-identities.json → dry-run) and reads Rachel's real Twilio
  sends back from the Twilio API. Handset delivery is reported, not asserted (needs the phone on
  WhatsApp and a message from it to Rachel within 24h, else Twilio 63024/63016).
- `ux`-tagged scenarios (50-59) send off-script input (questions instead of answers, refusals,
  several requests in one message, vague replies). Assertions state the CORRECT behavior.
- Nightly: rachel-qa.timer 08:00 UTC → qa/nightly.sh → summary posted to Slack #rachel_ai_qa.
  Each run snapshots replies in qa/runs/<stamp>/ and diffs vs the previous run.
- When a scenario fails: read qa/runs/<stamp>/<scenario>.json first, then the logs. Decide whether
  it's Rachel or the assertion before changing either. Every real bug becomes a scenario.

## Known-good facts
- Search: api-client.getbevvi.com with client=bevvibot and zipcode=; the location= variant returns nothing.
  Every live caller goes through rachel/catalog-api.js (Rachel buildPackage, coverage, shopping-agent searchProducts,
  catalog-sweep, ops/catalog-search.py). CATALOG_API=getproducts switches to dev-api-lb4.getbevvi.com/.../getProducts
  (a PRODUCTION server despite "dev"; GET zipcode/name/page/limit, rows unwrapped + links rewritten to bevvibot);
  default legacy. Staging: `CATALOG_API=getproducts ops/staging.sh start --with-shopping-agent`. Oct 7 staging suite on
  getProducts: 70/76 — better: fuzzy ("Titos", "Fever Tree" without the hyphen retry), the SF Stella 24 x 11 oz bottles
  found (legacy hides it); worse: rows legacy returns are MISSING even by exact name (NYC "Cocktail Essent Lime Juice 1%
  - 375 ML", SF "Fort Point Beer Co. KSA Kolsch Non-Alcoholic (6PKC 12 OZ)"), noisier broad words ("Lime" -> Miller High
  Life), ~0.2-0.3s slower a search (a 22-line email quote ran past the QA turn limit). Production NOT switched (DC decides).
  NYC 10019 store 5f4d1e12…, Boston 02110 689fa0c7…, SF 94104 679dadac….
  The search needs the possessive apostrophe ("Titos" finds nothing, "Tito's" does): searchWithFallbacks retries
  "<word>s" as "<word>'s" ([searchWithFallbacks] apostrophe retry); rachel.js [not-found] compares without apostrophes.
  It also matches hyphens literally ("Fever-Tree Ginger Beer" finds nothing, "Fever Tree" does): doSearch retries
  unhyphenated ([doSearch] hyphen retry). A requested size matches the size field OR the size in the product's name
  (Sonoma Simple Syrup "24.5 OZ" has size field 25.4 OZ; functions.js productHasSize). (Oct 5, DC, SF: both were "not available".)
- A customer-named product is never dropped for price caps; a stated size sorts first.
- Multi-pick resolver only fires on a real numbered options list + a selection-shaped message.
- A substantive first message (an order) is kept through the age gate (pendingIntent) and replayed.
  An address + a request in ONE message at the address step ("1 Rockefeller Plaza, New York, NY 10019. Add 3 Tito's 750ml and
  a case of Stella.") is split the same way (address-extract.js splitAddress, [addr] address + request in one message):
  the address is stored, the request replayed. Oct 9 (connector): the whole sentence was saved as the address and the order
  ignored. Only a request-shaped rest is split ("ring the bell, 3rd floor" stays). "Send 2 cases of X to <address>": the
  street starts after the last "to/at <number>".
- add_item routes in code only for ONE item: a second item without a number ("and a case of Stella") defers to the LLM
  (classify-intent.js namesAnotherItem; [add-item] multi-item/multi-name — deferring (names another item: ...)).
  Oct 9: add_item added 1 Tito's (not 3) and dropped the Stella silently.
- Age answers are parsed by parseAgeAnswer (server.js): stated age decides, then doubt, then
  negation, then an affirmative at the start. A refusal sticks 24h, even across reset.
- Catalog guard (store-agent/catalog-guard.js) hides bad rows + alerts QA Slack. Same product+size listed
  twice: keeps the row closest to the web MARKET price near the zip (Claude + web_search, cached 7d in
  logs/market-prices.json, stale-while-revalidate). The FIRST search for an unpriced duplicate waits for
  the web lookup (~10-30s, capped at 35s) — DC: an accurate price beats a fast reply.
- Events: a request mixing drink types asks "what will your guests drink most?" (server.js parseServingMix)
  -> eventParams.serving_mix -> buildPackage serving_mix (menu_build and cocktail custom_list). Drinks per
  guest = rule of thumb (2 first hour + 1/hour). Quantities use real bottle sizes; a full bar (1 bottle per
  spirit type) is kept and stated (never an offer to trim). Packages spend toward the budget: no downsell,
  price-tier critic notes are dropped (rachel.js), prompt SPEND-THE-BUDGET rule. Every menu_build logs a supply check (OK/FAILED).
  "just/only beer + wine", "no liquor" set the other categories to 0%. A held PRODUCT LIST + guest count answered
  with the mix = the listed products sized for the event (eventParams.list_scale -> rachel.js [list-scale]:
  calculator quantities, 0% categories dropped and listed in the reply, no re-adds that turn) — also when the mix
  is stated in the same message ("only beer and wine, make it equal"). An aperitif (Lillet, vermouth) counts as liquor;
  "just/only beer and wine" also leaves hard seltzer out (DC) unless the customer's own words mention seltzer.
  Cocktails asked for with no names ("wine, beer and cocktails", "2 signature cocktails") are asked in code on /chat
  (Slack, WhatsApp, email) right after the serving-mix answer, or when the mix is stated in the request
  (serving-mix.js cocktailsUnnamed + COCKTAIL_ASK; names from prompt.md 8.3 read live, or any name after "cocktails:" /
  "like"; "3 x ... Cocktail" item lines never count; state.pendingCocktails; [menu] cocktails requested without names /
  answered). The answer = the held request + "Cocktails: ..." built as ONE custom_list. (Oct 7: the LLM sometimes built a
  full bar, and the names given next replaced the whole package with 7 Cointreau + 11 lime juice.) The connector already asked.
  Mix percentages: "60 pct / percent wine", "60/40 wine/beer", "wine 70%" (that form read NaN until Oct 4) (serving-mix.js).
  An event's beer packs are sized across the beer lines together on the real pack sizes to >= 95% of the need ([buildPackage]
  beer packs sized together; Oct 4: two lines each rounded up = 72 bottles for 50), and the "Beer" slot skips cider.
- Event spirits + beer style (DC Oct 7 connector Oktoberfest test; fixed Oct 9): rachel/event-prefs.js reads from the
  customer's words which spirits ("bourbon and tequila bar", "no vodka or gin"; "mostly whiskey" never shrinks the bar) and
  which beer style ("beer (Oktoberfest selections)", "German beers"; a theme alone is not the beer). menu_build gets
  spirit_types / beer_style (connector: rachel-mcp from request + serving_mix; Slack/email/WhatsApp: rachel.js from this
  message + originalRequest + serving-mix answer) -> buildPackage spirit slots = those types ([buildPackage] spirits the
  customer asked for), beer = the style's words, then its family (Oktoberfest -> German brands), else usual beer; a custom_list
  "Oktoberfest Beer" line is handled the same way — only a STYLE line (event-prefs.js isStyleLine: nothing left but style +
  beer words), never a named product that contains a style word (Oct 9: "Stella Artois Premium Lager Beer" became Busch Light
  for ~1h after the style handling shipped; caught by scenario 78, no customer affected). Not carried -> beer_note ("This store has no Oktoberfest beers right now,
  so I picked German beers instead."), appended in code on /chat (replyNote), a plain statement on the connector. Spirit
  slots never take a wine ("1000 Stories Zinfandel Bourbon") or a cream / nog / liqueur / canned cocktail, beer slots never an
  NA beer, and the QUANTITY-FIRST downgrade re-checks the slot (it swapped that "bourbon" for Evan Williams Egg Nog). Two
  lines that end up the same product are merged. Catalog rows listed twice with the same name+size+price: line-resolve takes
  the exact-name one (Oct 8: the Stella left a connector order as "not an exact catalog match"). product_query for a mixer
  (mixers.js) with no spirit in the query drops alcoholic rows ("Coca-Cola" -> Jack Daniel's & Coca-Cola). At the address
  step only an address-like message is geocoded; "150 guests, 3 hours, $1,500" is held as the request (was "I couldn't find
  that address" with the request echoed). Scenarios 98, 99.
- "use another / a different <type>" with ONE basket line of that type: the LLM's product_query is rerouted in code to
  alternatives for that line ([swap-to-alternatives]; anchored to its price, the line's own product excluded via
  originals[].exclude). A confirm_substitute whose replacement is the B of the customer's "A -> B" must replace A's line
  (name, label or what was asked): corrected, or refused when A's line already IS B / A isn't in the basket ([arrow-original]).
  (Oct 3: Goldeneye $73 offered first for La Crema; the Provence rosé replaced by Cointreau.) original-compare parseRequest
  reads "5 x Product" lines too (it read only bullets, so the LLM's left-out list lines were never re-added).
- A replacement for a not-carried line (pick from the listed options, or confirm_substitute) REPLACES it at the line's
  planned qty (buildPackage unavailable_qty -> state.unavailableQty; else the qty in the customer's own list).
  Every pick path (numbered list, add-item by name) uses pendingSubFor to find the missing line it replaces.
  The basket line an item refers to = basketLineFor (whole words, most of them) — never a first-word substring.
  "A -> B" lines (Slack sends "-&gt;") are applied in code after the LLM turn when A is a basket line (name, label or
  what was first asked) and B is ONE product just shown (size-matched); else the LLM's question stands ([arrow-swap]).
  A reply that only SAYS a swap was made (basket untouched) is flagged "I haven't done this one yet" (instructions.js).
  A list line whose pick has only part of the name searches the missing words and says "<product> is in stock too" —
  never a false "no X in stock". Two brands' words, one product each: the LATER word wins ("Remy Cointreau" =
  Cointreau, Remy Martin noted). A spirit-type word the brand implies is not missing ("Grey Goose Vodka" = Grey
  Goose 750 ML) unless the product adds words of its own (Patron XO Cafe is not "Patron Tequila"). A basket change after a proposal says the PDF is stale.
  After ANY basket change the reply lists the whole basket (2+ lines; appended in the CTA layer if the reply didn't);
  a 3+ line basket's follow-up offers order OR proposal. A price in a pick ("$24.14") is never a quantity.
- Proposal requests: phrase list + "<verb> ... proposal/pdf" (not negated/a question). A basket proposal (2+ lines) is
  generated IN CODE from the basket after client + date, reply and link written in code; the LLM is only a fallback.
  A repeat proposal in a session reuses the saved client + date and goes straight to the PDF (never a bottle count).
  The event date is cleaned by rachel/event-date.js (date step AND shopping-agent generate_proposal, every path):
  "Oct 6th, thanks Rache" -> "October 6, 2026"; no year = next upcoming; a year already past -> next occurrence.
  A quote email's date = findEventDateIn: item lines ("2 x Sun Cruiser") skipped; a weekday only as "on/this/next Saturday".
  Options shown next to a basket ("two options for the prosecco...") are kept (state.shownOptions); a proposal request
  that asks for the options/alternatives lists them in the PDF per basket line at its qty with the CHANGE to the total
  (rachel/proposal-options.js, both the code and LLM paths); totals stay on the basket; "without the options" drops them.
  A change to the client/date of a sent proposal ("remove X from the date", "client should be Y", "date: Oct 7") is
  applied in code and the PDF regenerated (parseProposalFieldEdit). Turns answered in code are recorded in the LLM
  history (recordTurn llmRan=false) — else the LLM denies a PDF it never saw being sent.
  Any LLM-generated proposal reply gets the real URL (rachel.js replaces a placeholder like "<url|...>").
- A not-carried product's stand-in is the SAME TYPE (rachel/drink-type.js: aperitif / fortified / sparkling / rose / red /
  white / spirit type; non-alcoholic only for non-alcoholic), in buildPackage and the alternatives intent (originals[].type
  only when the customer asks for another type); none of that type = unavailable, never another type. Then anchored
  to its web market price (±30% first). An exact
  product filed under another category (Lillet = Liquor/Aperitif) is kept. In an event list, aperitif/fortified
  wines (Lillet, vermouth, sherry, port...) get 1/4 of a table wine's share of the wine servings (DC). Pack size comes from the name ("6PKC").
- Event ceilings + mixers (DC, Oct 7: "you are the expert, make it easy, not too many back and forth"; claude.ai: 30
  guests / $4,000 / "mostly spirits mixed with coke and oj" got Opus One $1,100, Clase Azul, Weller — targets were $407 a
  spirit, $204 a wine — no Coke/OJ, and Claude listed changes to approve). rachel/event-ceiling.js: per-bottle ceilings for
  event packages (wine $80, sparkling $100, spirits $90 sipping / $50 mixed) on the first pick (functions.js target, logged
  [buildPackage] event ceiling) and both budget-upgrade passes (shopping-agent menu_build, and custom_list events as mixed);
  money left is stated plainly (budget_note, never an upsell). rachel/mixers.js reads mixers the customer names (Coke, OJ,
  tonic, soda, cranberry, ginger beer...) from their own words — Slack/email/WhatsApp: rachel.js from everything they said
  + eventParams.serving_mix_text (the serving-mix answer is handled in server.js, not in LLM history); connector:
  rachel_build_package serving_mix + request -> menu_build mixers / mixed_drinks: lines sized ~4 oz per spirit drink, best
  value per ml, never alcoholic/diet unless asked; not carried -> mixers_not_carried, said plainly ([menu_build] mixer added /
  NOT CARRIED). With mixers in the basket the "add mixers, water, soda, ice, or cups?" question is skipped (state.mixerAsked
  + [cta] removed). Spirit slots never pick a flavoured bottle. Connector: build_package results carry `presentation` and
  the server instructions say present Rachel's package as finished, one question (order or proposal). Tool annotations:
  search / recommend / build_package / get_session are readOnlyHint (claude.ai "always allow"-able as read-only);
  rachel_confirm_order is destructiveHint (keeps asking). Scenario 95-event-mixers-expert.
- A stated quantity to buy ("44 bottles of prosecco and the budget is $1000", "3 cases of Stella") with no guests / hours /
  event word is an ORDER: rachel/qty-order.js -> rachel.js note "QUANTITY GIVEN" ([qty-order]) -> custom_list at that qty
  + budget, never "is this for an event?" (prompt.md PRIORITY 0-PRE fired on the budget; DC, Oct 5). Connector:
  rachel_build_package's description sends a stated quantity to rachel_chat.
- gbrain calls give up after 15s (GBRAIN_TIMEOUT_MS; the turn continues without memory). Oct 5-6: gbrain-mcp sat at 100%
  CPU not accepting connections; every turn waited ~145s (QA stuck turns F-0020/F-0021); restarted Oct 6 (DC approved).
- Proposal options from the alternatives search are kept too (proposal-options.js groupsFromResult labels by r.query);
  the in-code proposal retries a dropped shopping-agent fetch once (F-0021).
- Search relevance (rachel/search-match.js, DC Oct 6 on claude.ai): product_query ranks results by the query's
  distinctive words before price and drops rows without its producer key ([product_query] dropped / NOT FOUND -> found:false
  + note); rachel.js [not-found] uses the same module. Was price-only: "Green Chartreuse" -> Johnnie Walker Green, "Rioja" ->
  an Argentine blend first, and the connector (which calls product_query directly) showed them as found. The catalog has
  no subcategory data (all None) — no category search; Veuve Clicquot 6 Liter is filed as Beer (catalog data).
- Catalog 5xx/429: searchProducts retries twice; a build that still hit failures returns CATALOG_UNREACHABLE,
  never "isn't available at this store".
- A conversation expires after RACHEL_IDLE_HOURS (4) idle, except email threads; age is re-asked. An email thread's
  conversation is kept until the later of last email + 14 days and EVENT DATE + 14 days (DC, Oct 3; pruneChatSessions,
  event date read relative to the last email; [memory] logs a clear). Flow state (basket, details) is never pruned.
  email-link's "only quote from this sender" uses the same live window.
- Edits to a quote the customer has (remove lines, "all beer in bottles", "only 1 case of X") are applied in
  code (quote-edits.js; email sessions or sessions with a proposal), listed back, PDF regenerated. An edit that
  also ADDS items goes to the LLM. An email quote request's reply + PDF are always built in code.
- Stock the customer says they already have ("we have the below inventory from last time") is never ordered:
  on-hand.js -> state.onHand, dropped from custom_list/menu_build in rachel.js ([on-hand] DROPPED) + noted (DC). A generic line
  ("4 white") never picks an on-hand product while another fits (np.avoid -> [buildPackage] on-hand product(s) not picked).
  A generic type+size line ("tequila blanco 1.75L") gets a MID-priced product (median of the size matches, DC);
  "a case" with no count = 24 units (a 12-pack is fine, DC); not wine/spirits. Plain water ("bottled water case") = the store's plain
  still water ([doSearch] plain water; a 24ct pack first for a case), never a word match (Oct 4: FIJI left SF and "Bottled"
  found port/bourbon). A requested pack not carried, with a smaller pack of the same product + container here, takes enough
  of those ("Stella 24 x 11 oz" -> 4 six-packs each; [buildPackage] pack:; a container within 10% counts, 11 vs 12 oz). The
  container the customer names (bottles / cans) wins over the other of the same brand ([buildPackage] container:; the brand
  is searched when the top-3 fuzzy fallback lacks it; never an NA 0.0 row; Oct 7: 4 x 12-pack CANS for "24 x 11 oz Bottles"
  with the 12pk Btl on the shelf); "lager"/"ale" the brand implies is not "missing" (no false "no lager in stock"). A PICKED
  pack stand-in keeps the units too (pack-standin.js in applyBasketSubstitute, every pick/swap path; with no original named,
  the customer's own counted pack line of that brand is the original): 2 x 24-pack -> 4 x 12pk ([confirm-substitute] pack:;
  Oct 5: the picked 12-pack went in at 1x). A smaller stand-in for a not-carried
  line makes up its volume (Lemon Juice 1L -> 3 x 375 mL). A pick replaces the pending not-carried line of the same
  kind (pending-original.js) — never pendingSubstitutes[0]. "N/A" = "NA" = non-alcoholic; "Brewing"/"Winery" are filler.
- Every ready turn, before anything reads the basket (basket-hygiene.js, [basket-hygiene]): on-hand lines (state.onHand
  + the original request) are dropped and the customer told; a pending not-carried item whose same-kind line is in the
  basket is cleared (a line labeled with ANOTHER request item never counts); a saved client with the sender's
  signature glued on is cleaned ("Goody Dipanjan Chatterjee CEO |" -> "Goody"). An on-hand product the customer CHOSE in
  a later message ("4x Conundrum White -> This is good", "so 4 The Prisoner") is released (on-hand.js releasedBy ->
  state.onHandReleased) and never dropped; "remove X" / "we have X" never release. A line with keepOnHand is kept too.
- An email answering Rachel line by line ("<a line of her last reply> -> <answer>", annotated-reply.js, [annotated]):
  an acceptance ("this is good") of an option line is applied in code — product = brand + price among those just
  shown, line = the ALL-CAPS section it was offered under, qty = its "need Nx"; the replacement keeps the line's label.
  A note on a BASKET line ("1x X ... -> Remove this" / "Make this 2 bottles" / "This is good") is applied in code too
  (lineAction). Other pairs go to the LLM with what was done in its context; the reply opens with "Done — ..." + the basket.
- "Compare with my original request" is answered IN CODE (original-compare.js, [original-compare]): each requested
  line vs the basket (one basket line per request line, volume or units; a pack size not in the catalog name is
  CHECK, never guessed), on-hand listed as not ordered, extras listed; quantity fixes offered and "make the changes"
  applies exactly those. The LLM ignored the same table when given it as fact (Oct 2). Notes on the customer's OWN
  request lines ("• <request line> -> not both / doesn't look right", requestNotes, [request-notes]) are answered in
  code too: "A (or B) -> not both" keeps A (their first choice) and removes B, flagged lines shown first, then the
  comparison. An "-> answer" that wraps onto the next line is one line (instructions.js joinArrowWraps); a verdict
  ("doesn't look right", "not both", "wrong") is never read as a swap.
- custom_list named_products are checked against the customer's own list lines in code (original-compare.js
  reconcileNamed, [list-reconcile]): a line with an amount and no count ("3L mango purée", "1L lemon juice") is
  np.volume_ml — any bottle size, buildPackage sizes the qty to cover it ([buildPackage] volume:) instead of
  UNAVAILABLE (size mismatch); a counted line keeps its count; a list line the LLM left out is added (on-hand lines
  never). The customer's spelling still matches ("Budlight" = Bud Light, "Michelop", "Pumkin", "Ice tea" = Iced; a near
  spelling ranks below an exact word) and an LLM line answers only ONE list line. Instruction / question lines ("can we swap X for Y?", "remove the water case") are never request rows. A pack
  request whose pick has no pack size in its name prefers a candidate that names it (Nixie -> Perrier 8pk).
- A custom_list build on an EDIT turn (add / swap / "add back" wording, not "new list" / "start over") MERGES into the
  basket, never replaces it (basket-merge.js, [basket-merge]): same product = updated, else added; "swap X for Y" removes
  X and Y takes X's qty. (Oct 2: "add back some wine? 4 red 4 white" replaced DC's 14-line Goody quote with the wine.)
- Email quote turns: the L1 package cache (key sender+zip+request) is only injected into a session with a basket of its
  own — a new thread builds fresh. The LLM's generate_proposal client = saved client, else the subject's client, else
  the LLM's (Oct 2: "Bevvi" billed for "Drinks quote - Northwind QA"). SendEmail to only the sender inside an email
  thread is refused (the reply already goes to them). A pick with no line to replace says "added", never "replaced null",
  and takes a count typed right before the product ("so 4 The Prisoner"). A basket change on a question turn still
  lists the basket (before the closing question).
- The LLM's generate_proposal/place_order use the LIVE basket (state.lastLineItems after this turn's edits) and the
  saved event date/client when it omits them. In a client edit the LAST client statement wins ("it should be just Goody").
- Delivery windows (server.js validateDeliveryTime): the store's windows are store-local but always labeled "EST"
  (DC confirmed Oct 5: Bevvi runs stores in their local time zones; WINDOWS_ARE_STORE_LOCAL = true).
  No time zone stated or known -> Rachel ASKS which one (PT/MT/CT/ET) and holds the time (orderData.pendingWhen; email:
  od.pending_when / od.awaiting_zone; connector: a problem asking it) — DC, Oct 5. Every window and time is then shown in
  the CUSTOMER's zone only ("2:00 PM - 3:00 PM ET"). The zone (words too: "Pacific", "eastern time", "east coast") is kept
  for the conversation (state.custZone; orderData.custZone) and holds for later bare times; a zone with no time ("I said
  PST not EST") lists the same date's windows again in that zone. QA scenarios give "... ET" with their times. (Oct 5, DC, SF: Pacific
  windows labeled EST, the correction re-asked the time, and a bare "2:00 PM" was read as Pacific — order 3h late.)
  Every channel uses validateDeliveryTime: Slack/WhatsApp (/chat order flow; the "order placed" reply gets the zoned
  window, never Bevvi's raw "EST" string), email (the stated zone + offered date ride on state.emailOrder across emails:
  od.cust_zone / od.windows_date; zoneStatedIn ignores a bare "CT"/"MT" in addresses) and the connector
  (/internal/order-preview; a time with no zone is refused with the zone question; delivery.window is in the customer's zone).
  "The name of the recipient is X but the email is Y" at the email step sets the order name (contacts.recipientNameIn).
  A pick with no original takes its count from the customer's own list line (ownListQtyFor) and a pick whose qty is
  known never asks "How many bottles?". basket-hygiene never clears a pending line by a line labeled with another
  request line (Oct 5: the Sonoma syrup pending was cleared by the mango syrup line).
- Address change at ready (server.js, Oct 5 DC): a comma-less address ("375 Revere St Revere MA 02151") is read
  (address-extract.js fallback) — it went to the LLM, which rebuilt the basket for the new zip but never changed
  state.address (proposals/orders kept 332 Pine St). The store is compared by establishmentId (coverage now returns
  it; SF and Boston are both client "bevvibot"); another store = each line found again there by exact name at its price
  ([addr] basket moved ... repriced / NOT CARRIED -> pendingSubstitutes), never an emptied basket; the reply lists the
  basket. Bevvi has no store for 02210 (Seaport) — a real coverage gap, not a Rachel bug.
- Tax / proposal address (tax-command.js, Oct 5 DC): "the tax should be 0", "Estimated tax (10%): $79.16 is 0", "tax
  exempt" -> state.taxExempt for the session: every estimate (basket, order summary, LLM-written totals corrected in
  code [tax]), proposalOpts.tax_exempt on every PDF; "add the tax back" restores. "take out the delivery address from
  the proposal" -> state.proposalHideAddress (in-code + LLM proposals). Either one regenerates a sent proposal in code.
- Proposals: a ONE-line basket is generated in code too (the LLM said "ready" with no PDF); "None" as the event date is
  remembered (state.eventDateNone) so a repeat proposal never re-asks client/date; the shopping-agent refuses a
  proposal with no lines or a $0 line ([generate_proposal] REFUSED). A confirm_substitute whose original is no longer in
  the basket keeps the replacement line's qty (44x La Marca became 1x).
- A new order ("start a new order", "separate order", "start over") clears the cart and everything of the old order
  (not-carried lines, options, original list, proposal client/date/tax/address choices) and asks "Should it go to
  <previous address> again? Reply "yes", or send the new address" (DC, Oct 5). "yes" keeps it (a request in the same
  message is held and replayed), an address replaces it (address-change block), "no" asks for it. Email: "please create
  a new order" for the thread's quote stays an order command. Connector: rachel_place_order's description says to
  confirm the previous address. An empty cart's "show my basket" is answered in code.
- Every order Rachel places (createCorpOrder) has top-level email = rachelai@getbevvi.com (DC, Oct 3; ORDER_ACCOUNT_EMAIL in
  store-agent/shopping-agent.js, env RACHEL_ORDER_ACCOUNT_EMAIL); customerData.email = the customer; who asked is kept
  in our order log (requested_by) and [place_order] account | customer email | requested by. Until Oct 3 the top-level
  email was the requester (email sender / Slack user).
- A placed order (API success only) leaves the cart → state.placedOrder. There is no order-update API: ANY change to a
  placed order, paid or not (items, recipient, contact, driver note, COI, cancel), is emailed to bevvi-support and the reply
  only says "Our support team has been made aware of this request — we'll update the order and let you know" (DC, Oct 4;
  placed-order-msg.js). No reopen question any more (the old awaitingReopen branch only finishes sessions asked before
  Oct 4). "I paid" is noted (po.paid_reported) and never gets the link again. Only "a new / separate order" starts fresh.
  QA/dry-run orders: the support email is not sent. email-agent reply-all reads a glued cc ("...comand") as the real address.
- Email orders: delivery instructions in an EARLIER email of the thread ride on the order ([email-order] delivery
  instructions from an earlier email); text on the label's own line ("delivery instructions below:Main POC ...") is read
  (Oct 3, Foodie For All: the POC/COI/loading-dock notes never reached the order).

## Open items
- WhatsApp QA phone +19173024521 has no handset and is not a Twilio number: replies come back 63024
  (expected; content is still asserted). Deferred by DC (Sep 26): register it (or a new Twilio number)
  as a WhatsApp sender for true end-to-end — needs one OTP to the number + an approved utility template
  for each run's first message. Switch WhatsApp to Meta Cloud API.
- Stripe payment: backend needs stripeCustomerId param on createCorpPayByLinkOrder (spec shared).
- Rotate: Slack bot + app tokens, Anthropic key, Google Maps key (exposed in chat on Sep 25).
- Installable Slack app; SMS on the 518 number (10DLC pending); Apple Messages for Business.
