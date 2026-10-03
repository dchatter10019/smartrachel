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
  given = the event date, with its real windows offered; a first name alone asks only for the last name; all
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
1. Deploy rachel/shopping-agent/rachel-email ONLY via `/home/ubuntu/precheck.sh --deploy`: lint → restart the
   services whose files changed → smoke set against the new code. If the service doesn't come up or
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

## Debug-and-fix loop (spec: "Rachel — Automated Debug-and-Fix Loop", Sep 29)
- Step 1 staging: done (see Staging above). Step 2 monitor: ops/monitor.py (thresholds ops/monitor.yaml) reads the logs,
  events.jsonl, qa/runs/*/summary.json, the watchdog log and the six services' state; appends findings to
  logs/findings.jsonl (deduped 7 days; evidence redacted). `ops/monitor.py --status` lists open findings, `--replay <log>`
  tunes thresholds, `--once` one pass. Customer-facing detectors skip QA (tag «qa-», events qa:true, qa- session ids).
  Runs as rachel-monitor (unit in ops/systemd/, installed by DC). Critical findings post to OPS_SLACK_CHANNEL once set.
  ops/tests/monitor_test.py runs in the nightly QA. Interactive sessions: check `ops/monitor.py --status` first.
- Step 3 fixer (ops/fixer.py): per open finding, classified by ops/scope.yaml (fix vs diagnose-only detectors; protected
  paths/patterns refuse a branch), headless Claude Code in a worktree (~/work/<id>, branch fix/<id>) writes a scenario + fix;
  fixer.py then proves it itself (scenario fails on staging from base, passes from the branch, smoke passes). Result ->
  logs/fixer/<id>.json + a review post (logs/fixer/<id>.post.txt until OPS_SLACK_CHANNEL is set). `--plan` = classify only,
  no tokens; `--finding F-…`; kill switch: ops/PAUSE. NOT running yet: no systemd unit / nightly hook.
  Spend (DC, Oct 3; ops/monitor.yaml fixer:): $15 per UTC day across runs, $5 hard cap per fix (claude --max-budget-usd), max 3
  fixes; a fix starts only if the full $5 still fits. A run with no reported cost (timeout/crash) is charged the $5 cap, never
  $0. Every run -> logs/fixer/spend.jsonl; each pass ends with a spend report (tonight + month to date) posted to Slack /
  logs/fixer/spend-report.txt. `ops/fixer.py --spend` prints it. Model pinned: fixer.model = claude-opus-5-5 (billed to the
  server's ANTHROPIC_API_KEY). --max-budget-usd is checked between steps, so a run can end slightly over $5.
  Seed acceptance test passed twice on Oct 3 ($0.66, $1.11).
- Every Slack message of the loop (fixer posts, monitor urgent alerts, deploy-fix.sh results, the bot's ✅/❌ replies) is
  written for DC as a non-engineer (DC, Oct 3): what customers saw / how often / why / what changed / how checked / risk,
  from the agent's plain_* JSON fields + monitor.PLAIN per detector; code, files and branches only in a "For engineers"
  footer. Headings keep "Fix ready — F-nnnn" / "Needs a decision — F-nnnn" (the reaction handler parses them).
- logs/findings.jsonl has several writers (monitor service, fixer, deploy-fix.sh, Slack ❌, by hand). Store merges per item:
  an item this process changed since its last sync wins, others take the file's version (before Oct 3 the monitor's stale
  copy won, reverting every outside status change — the fixer would have re-fixed, and re-paid for, the same finding).
- Step 4 deploy (ops/deploy-fix.sh <id>): ✅ by an approver on the fixer post (rachel_slack_bot.py reaction_added) →
  scope re-check, fast-forward-only, precheck --deploy --stage-first, push; rollback + master reset on failure; ❌ discards.
  Inactive until /etc/rachel.env has OPS_SLACK_CHANNEL + OPS_APPROVERS and the Slack app subscribes to reaction_added.

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
  NYC 10019 store 5f4d1e12…, Boston 02110 689fa0c7…, SF 94104 679dadac….
  The search needs the possessive apostrophe ("Titos" finds nothing, "Tito's" does): searchWithFallbacks retries
  "<word>s" as "<word>'s" ([searchWithFallbacks] apostrophe retry); rachel.js [not-found] compares without apostrophes.
- A customer-named product is never dropped for price caps; a stated size sorts first.
- Multi-pick resolver only fires on a real numbered options list + a selection-shaped message.
- A substantive first message (an order) is kept through the age gate (pendingIntent) and replayed.
- Age answers are parsed by parseAgeAnswer (server.js): stated age decides, then doubt, then
  negation, then an affirmative at the start. A refusal sticks 24h, even across reset.
- Catalog guard (store-agent/catalog-guard.js) hides bad rows + alerts QA Slack. Same product+size listed
  twice: keeps the row closest to the web MARKET price near the zip (Claude + web_search, cached 7d in
  logs/market-prices.json, stale-while-revalidate). The FIRST search for an unpriced duplicate waits for
  the web lookup (~10-30s, capped at 35s) — DC: an accurate price beats a fast reply.
- Events: a request mixing drink types asks "what will your guests drink most?" (server.js parseServingMix)
  -> eventParams.serving_mix -> buildPackage serving_mix (menu_build and cocktail custom_list). Drinks per
  guest = rule of thumb (2 first hour + 1/hour). Quantities use real bottle sizes; a full bar (1 bottle per
  spirit type) is kept and stated (never an offer to trim). Packages spend the whole budget: no downsell,
  price-tier critic notes are dropped (rachel.js), prompt SPEND-THE-BUDGET rule. Every menu_build logs a supply check (OK/FAILED).
  "just/only beer + wine", "no liquor" set the other categories to 0%. A held PRODUCT LIST + guest count answered
  with the mix = the listed products sized for the event (eventParams.list_scale -> rachel.js [list-scale]:
  calculator quantities, 0% categories dropped and listed in the reply, no re-adds that turn) — also when the mix
  is stated in the same message ("only beer and wine, make it equal"). An aperitif (Lillet, vermouth) counts as liquor;
  "just/only beer and wine" also leaves hard seltzer out (DC) unless the customer's own words mention seltzer.
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
- Catalog 5xx/429: searchProducts retries twice; a build that still hit failures returns CATALOG_UNREACHABLE,
  never "isn't available at this store".
- A conversation expires after RACHEL_IDLE_HOURS (4) idle, except email threads; age is re-asked.
- Edits to a quote the customer has (remove lines, "all beer in bottles", "only 1 case of X") are applied in
  code (quote-edits.js; email sessions or sessions with a proposal), listed back, PDF regenerated. An edit that
  also ADDS items goes to the LLM. An email quote request's reply + PDF are always built in code.
- Stock the customer says they already have ("we have the below inventory from last time") is never ordered:
  on-hand.js -> state.onHand, dropped from custom_list/menu_build in rachel.js ([on-hand] DROPPED) + noted (DC).
  A generic type+size line ("tequila blanco 1.75L") gets a MID-priced product (median of the size matches, DC);
  "a case" with no count = 24 units (a 12-pack is fine, DC); not wine/spirits. A smaller stand-in for a not-carried
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
  never). Instruction / question lines ("can we swap X for Y?", "remove the water case") are never request rows. A pack
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
- A placed order (API success only) leaves the cart → state.placedOrder; touching it asks reopen/new.
  Bevvi has no cancel API: a re-placed reopened order leaves the earlier one unpaid (logged).

## Open items
- WhatsApp QA phone +19173024521 has no handset and is not a Twilio number: replies come back 63024
  (expected; content is still asserted). Deferred by DC (Sep 26): register it (or a new Twilio number)
  as a WhatsApp sender for true end-to-end — needs one OTP to the number + an approved utility template
  for each run's first message. Switch WhatsApp to Meta Cloud API.
- Stripe payment: backend needs stripeCustomerId param on createCorpPayByLinkOrder (spec shared).
- Rotate: Slack bot + app tokens, Anthropic key, Google Maps key (exposed in chat on Sep 25).
- Installable Slack app; SMS on the 518 number (10DLC pending); Apple Messages for Business.
