# Bevvi AI Agents — Test Plan

A manual / semi-automated test script for every Bevvi AI agent running on this box. A person, or Claude
(Claude Code on the box, or claude.ai with the Bevvi connectors), can run it top to bottom. Each test says
what to send, what must happen (PASS), and where to check.

| # | Agent | What it is | Where |
|---|-------|-----------|-------|
| 1 | Health sweep | All services up | `curl` on the box |
| 2 | Rachel core | Ordering brain shared by every channel | `rachel` :3500 `/chat` |
| 3 | Rachel — Slack | DM bot | `rachel-slack` |
| 4 | Rachel — Email | rachelai@getbevvi.com inbox agent | `rachel-email` |
| 5 | Rachel — WhatsApp | Twilio bot + invite gate | `rachel-whatsapp` :3601 |
| 6 | Rachel — MCP connector | claude.ai "Rachel AI" connector | `rachel-mcp` :3600, https://mcp.getbevvi.com/rachel/mcp |
| 7 | Rachel — Video chat | HeyGen LiveAvatar prototype | `webchat-video` :8600 / :8443 |
| 8 | Shopping agent | Catalog search, package builder, orders, proposals | `shopping-agent` :8300 |
| 9 | Support agent | support@getbevvi.com email triage + drafts | `bevvi-support` :5000 |
| 10 | Transactions MCP | `get_bevvi_transactions` | `bevvi-mcp` :8000, https://mcp.getbevvi.com/mcp |
| 11 | Analytics MCP | Forecasts, trends, monthly numbers | `bevvi-analytics-gateway` :8791, https://mcp.getbevvi.com/analytics |
| 12 | gbrain + Proactive agent | Customer memory; reorder outreach | `gbrain-mcp` :7700, `proactive-agent/agent.js` |
| 13 | Ops loop | Monitor, fixer, nightly QA, conversation review | `rachel-monitor`, `ops/`, `qa/nightly.sh` |

---

## 0. Ground rules (read first)

- **Use QA identities only.** They are dry-run on every channel (no real order, no real email):
  - session ids starting `qa-` (e.g. `qa-manual-20261008-01`)
  - emails `qa-*@getbevvi.com` or `rachel_qa@getbevvi.com`
  - WhatsApp QA phone `+19173024521` (pinned to qa-whatsapp@getbevvi.com)
- **Ask DC before** anything that places a real order, sends a real email/message to a customer, or touches
  systemd, nginx or secrets (CLAUDE.md rule 2). Tests marked **⚠ DC** need that approval.
- **Prefer staging** for Rachel core tests: `ops/staging.sh start` → Rachel on `:3501`, every session dry-run,
  emails logged not sent. Don't run staging and a full production suite at the same time.
- **Cost:** a Rachel turn is ~$0.02. The full automated suite (`./qa/run.py`) is ~$15–20 — it runs nightly at
  08:00 UTC; don't run it by hand unless asked.
- **Age gate:** every new conversation must ask for age first. A test that skips it has failed.
- **Never paste secrets** (tokens, API keys, OAuth codes) into results.
- Record each result in the table at the end (§14). When a test fails: save the reply, grep the logs listed, and
  decide whether it's the agent or the test before changing either.

Handy helper for Rachel core tests (staging; change the port to 3500 for production with a `qa-` session):

```bash
R=http://127.0.0.1:3501   # staging; production = 3500
S=qa-manual-$(date +%s)
say() { curl -s -m 180 $R/chat -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg m "$1" --arg s "$S" '{message:$m, session_id:$s, context:{user_email:"rachel_qa@getbevvi.com", channel:"slack"}}')" \
  | jq -r '.text // .'; }
say "hi"
```

New conversation = new `S`.

---

## 1. Health sweep (2 min, free)

```bash
for u in 3500/health 8300/health 3600/health 3601/whatsapp/health 5000/health 7700/health \
         8791/analytics/health 8600/ 9000/; do
  printf "%-24s " $u; curl -s -o /dev/null -m 5 -w "%{http_code}\n" http://127.0.0.1:$u; done
curl -s -o /dev/null -w "bevvi-mcp (expects 401 unauth) %{http_code}\n" http://127.0.0.1:8000/health
systemctl is-active rachel shopping-agent rachel-mcp rachel-slack rachel-email rachel-whatsapp \
  rachel-monitor gbrain-mcp bevvi-support bevvi-mcp bevvi-analytics-gateway webchat-video dashboard
ops/monitor.py --status          # open findings
```

| ID | PASS |
|----|------|
| H-1 | Every URL 200 (bevvi-mcp 401 without a token is correct) |
| H-2 | Every unit `active` |
| H-3 | No open **critical** finding in `ops/monitor.py --status` |
| H-4 | `tail -50 logs/rachel.log logs/email-agent.log logs/slack-rachel.log` — no repeating errors / stack traces |

---

## 2. Rachel core (channel-agnostic, via `/chat`)

Run on staging with the `say` helper. Each block is one conversation (new `S`) unless noted.

### 2.1 Age gate & compliance

| ID | Send | PASS |
|----|------|------|
| R-AGE-1 | `hi` | Asks to confirm 21+ before anything else |
| R-AGE-2 | `I'm 19` | Polite refusal; no products. Then `ok I'm 25` in same session → still refused (refusal sticks 24h) |
| R-AGE-3 | `no I'm not` (fresh session, after the age question) | Treated as a refusal (negation) |
| R-AGE-4 | `not sure` | Asks again / doesn't proceed (doubt) |
| R-AGE-5 | First message `I need 2 bottles of Tito's delivered to 10019` | Age asked first, then the order is **replayed** after `yes I'm 30` (not lost) |
| R-AGE-6 | Same email identity, new session after a verified one | Age asked again (never inherited from profile) |

### 2.2 Address & coverage

| ID | Send (after age `yes`) | PASS |
|----|------|------|
| R-ADDR-1 | `deliver to 1 Rockefeller Plaza, New York, NY 10019` | Accepted; NYC store |
| R-ADDR-2 | `375 Revere St Revere MA 02151` (no commas) | Parsed; Boston store |
| R-ADDR-3 | `Seaport, Boston 02210` | Says Bevvi doesn't deliver there yet (real coverage gap) — no fake basket |
| R-ADDR-4 | With a basket in NYC, `actually send it to 332 Pine St, San Francisco, CA 94104` | Address changes; each line re-found at the SF store and repriced; missing ones listed; basket never emptied silently |

### 2.3 Search & basket

| ID | Send | PASS |
|----|------|------|
| R-SRCH-1 | `do you have Titos?` | Finds Tito's (apostrophe retry) |
| R-SRCH-2 | `Fever-Tree ginger beer` | Finds Fever Tree (hyphen retry) |
| R-SRCH-3 | `Green Chartreuse` | Chartreuse or "not available" — **never** Johnnie Walker Green |
| R-SRCH-4 | `a Rioja under $30` | Spanish Rioja first, not an Argentine blend |
| R-SRCH-5 | `add 3 Tito's 750ml` then `make it 5` | Quantity updated; whole basket listed back |
| R-SRCH-6 | `use a different vodka` (one vodka line) | Alternatives for that line, anchored to its price; doesn't re-offer the same product |
| R-SRCH-7 | `Tito's -> Grey Goose` | Line swapped in code, same qty; basket listed |
| R-SRCH-8 | `show my basket` on an empty cart | "Your cart is empty"-type answer, no hallucinated lines |
| R-SRCH-9 | `a case of Stella` | 24 units (or 2×12 if no 24); never 12 bottles when a 24 exists |
| R-SRCH-10 | `tequila blanco 1.75L` | A mid-priced bottle, not the most premium |
| R-SRCH-11 | `I want a bottle of wine for $24.14` | $24.14 is never read as a quantity of 24 |

### 2.4 Shopping lists

| ID | Send | PASS |
|----|------|------|
| R-LIST-1 | A 6-line list (e.g. `2 Tito's 1.75L / 1 case Stella bottles / 4 Kim Crawford SB / 3L mango purée / 1L lemon juice / bottled water case`) | Every line answered once; volume lines sized to cover (3L → bottles summing ≥ 3L); water = plain still water; not-carried lines named with same-type stand-ins |
| R-LIST-2 | Add `we already have the Tito's from last time` | Tito's dropped, said plainly, not charged |
| R-LIST-3 | `compare with my original request` | Line-by-line table in code; on-hand listed as not ordered |
| R-LIST-4 | `Stella 24 x 11 oz bottles` where only 6-packs exist | 4 × six-packs, bottles not cans |
| R-LIST-5 | `44 bottles of prosecco, budget $1000` | Treated as an ORDER (44 bottles), never "is this for an event?" |

### 2.5 Events

| ID | Send | PASS |
|----|------|------|
| R-EVT-1 | `party for 50 people, 4 hours, $2,000 budget, wine beer and spirits` | ONE question: "what will your guests drink most?" |
| R-EVT-2 | Answer `60% wine, 30% beer, 10% spirits` | Package built; spends toward budget (no downsell); drinks ≈ 2 first hour + 1/hour; beer packs sized together (≥95% of need, not over-rounded) |
| R-EVT-3 | `30 guests, $4,000, mostly spirits mixed with coke and OJ` | No luxury party bottles (spirits ≤ ~$50 mixed); Coke + OJ lines added (~4 oz per drink); money left stated plainly, no upsell; ONE closing question (order or proposal) |
| R-EVT-4 | `wine, beer and cocktails for 40` (no cocktail names) | Asks "which cocktails?" with a list |
| R-EVT-5 | Answer `margaritas and mojitos` | ONE combined list with every ingredient; the wine/beer part kept |
| R-EVT-6 | `just beer and wine for 25, 3 hours` | No liquor, no hard seltzer |

### 2.6 Proposals (PDF)

| ID | Send | PASS |
|----|------|------|
| R-PROP-1 | With a 3+ line basket: `can you make a proposal pdf` | Asks client + event date (only now); PDF link returned; link opens (`/proposals/bevvi-proposal….pdf`) |
| R-PROP-2 | `client should be Acme` | PDF regenerated with Acme, no re-asking date |
| R-PROP-3 | `the tax should be 0` | Every total shows $0 tax; PDF regenerated |
| R-PROP-4 | `take out the delivery address from the proposal` | PDF without address |
| R-PROP-5 | `include the options in the proposal` (after alternatives were shown) | Options listed per line with the change to the total |
| R-PROP-6 | Event date `Oct 6th, thanks Rache` | Cleaned to "October 6, <next year>" |

### 2.7 Orders (QA = dry-run)

| ID | Send | PASS |
|----|------|------|
| R-ORD-1 | `place the order` | Asks name, email, phone, delivery date+time in as few turns as possible |
| R-ORD-2 | Time `2pm tomorrow` with no zone | Asks which time zone (PT/MT/CT/ET); time held |
| R-ORD-3 | `PT` | Windows shown in PT only; never labeled "EST" |
| R-ORD-4 | Finish | "Order placed" (dry-run) with a Payment Link; `grep dry_run logs/rachel.log` (or staging log) shows it was not real |
| R-ORD-5 | After placing: `change the address to …` | "Our support team has been made aware…" — no edit, no reopen |
| R-ORD-6 | `I paid` | Noted; link not resent |
| R-ORD-7 | `start a new order` | Cart cleared; asks "Should it go to <previous address> again?" |

### 2.8 Memory, preferences, feedback

| ID | Send | PASS |
|----|------|------|
| R-MEM-1 | `we always do cans` | Acknowledged; new session (same QA email) → cans preferred; `[prefs]` in log |
| R-MEM-2 | `forget the cans preference` | Removed |
| R-MEM-3 | `Rachel feedback: the list was too long` | Thanked; line in `logs/feedback.jsonl` |
| R-MEM-4 | `you answered wrong, I asked for red` | Recorded as kind `unhappy` in `logs/feedback.jsonl`; Rachel's reply still helpful |

### 2.9 Robustness (UX)

| ID | Send | PASS |
|----|------|------|
| R-UX-1 | Answer the age question with a question (`why do you need that?`) | Explains briefly, asks again |
| R-UX-2 | `add 2 Tito's, remove the Stella, and what's your cheapest prosecco?` | All three handled in one reply |
| R-UX-3 | `Quiero dos botellas de vino tinto` | Replies helpfully (Spanish OK) |
| R-UX-4 | Promise bait: `can you guarantee delivery in 30 minutes?` | No false promises; real windows only |
| R-UX-5 | Gibberish / empty-ish (`.`) | Non-empty, sensible reply |
| R-UX-6 | Idle > 4h (or `/reset`) then `hi` | Fresh start, age re-asked |

---

## 3. Rachel — Slack

Use the QA Slack user (rachel_qa) DM to the Rachel bot. Log: `logs/slack-rachel.log`.

| ID | Steps | PASS |
|----|-------|------|
| SL-1 | DM `hi` | Reply within ~30s; age asked |
| SL-2 | Run 2.3 R-SRCH-5 and R-SRCH-7 | Same behavior as core; `->` written in Slack (arrives as `-&gt;`) still swaps |
| SL-3 | Get to a placed (dry-run) order | Payment link renders as `Payment Link` (hyperlink), not a raw token URL |
| SL-4 | 👎 on a Rachel reply | Thanked in the thread; entry in `logs/feedback.jsonl` |
| SL-5 | Upload a photo of a handwritten list | Rachel shows what she read, then builds the list |
| SL-6 | In #rachel-ops-test: typed `approve` with no waiting fix | Bot says nothing is waiting (no deploy) |

---

## 4. Rachel — Email

Send from `rachel_qa@getbevvi.com` (or a `qa-…@getbevvi.com` alias) to **rachelai@getbevvi.com**. The agent
polls every 60s. Log: `logs/email-agent.log`; thread map: `logs/email-thread-sessions.json`.

| ID | Email | PASS |
|----|-------|------|
| EM-1 | Subject `Drinks quote - Northwind QA`, body: 5+ item lines + delivery zip + `for Oct 30` | Reply opens "Hi <first name>," ends "Warmly, Rachel / Your personal mixologist at Bevvi"; PDF attached by its real name; client = Northwind QA; date Oct 30 |
| EM-2 | Reply in thread: `remove the beer, only 1 case of Stella` | Applied in code, listed back, PDF regenerated |
| EM-3 | Reply line-by-line: quote a line of Rachel's reply then `-> this is good` / `-> Remove this` | Applied; reply opens "Done — …" + basket |
| EM-4 | New thread, same sender: `can you update the Northwind quote, add 2 prosecco` | Linked to the earlier quote (or asks "which proposal?" if several) |
| EM-5 | `please create the order, payment link to qa-buyer@getbevvi.com, copy me` | Asks missing fields in ONE email (sender only); after answers: payment link To qa-buyer, Cc sender; dry-run |
| EM-6 | Time without zone in EM-5 | Asks time zone; windows then in that zone |
| EM-7 | CC a second QA address on EM-1 | Reply-all to both, never to rachelai@ |
| EM-8 | HTML-only email (no text/plain part) | Body read (`[html-body]` in log), not empty |
| EM-9 | Email with `Auto-Submitted: auto-generated` header | `Skipping automated email` in log; no reply |
| EM-10 | Long reply with quoted history + signature | Only the new text reaches Rachel (check transcript); signature not read as a client name |

---

## 5. Rachel — WhatsApp

Webhook posts as QA phone +19173024521 (handset delivery is reported, not asserted — Twilio 63024 is expected).
Easiest: `./qa/run.py --only 40-whatsapp-real-basics -v` (one scenario, ~$0.10).

| ID | Steps | PASS |
|----|-------|------|
| WA-1 | `curl -s localhost:3601/whatsapp/health` | `{"ok": true, ...}` |
| WA-2 | Scenario 40 | Age asked; search answered; Rachel's Twilio sends visible in the Twilio API read-back |
| WA-3 | Unknown number (not invited) sends `hi` | Invite gate: no Rachel conversation |
| WA-4 | `/whatsapp/admin` without auth | Refused |
| WA-5 | Send a photo of a list (media) | Read and built like Slack SL-5 |

---

## 6. Rachel — MCP connector (claude.ai "Rachel AI")

Automated: `python3 ops/tests/mcp_connector_test.py` (runs both API-key and OAuth paths on the public URL).
Manual: in claude.ai with the Rachel AI connector enabled, signed in as a QA email.

| ID | Prompt in claude.ai | PASS |
|----|------|------|
| MCP-1 | `recommend a wine for steak night` (no mention of Bevvi) | Claude reaches for Rachel's tools; asks 21+ first; `rachel_verify_age` called before any other tool |
| MCP-2 | `I'm 25. Delivery to 10019` → `find Tito's` | Results with name/size/price only — no product URLs/slugs, no "cheap/expensive" commentary |
| MCP-3 | `find Green Chartreuse` | Plain available/not-available; Claude doesn't comment on search quality or false matches |
| MCP-4 | `drinks for 30 people, $4,000, mostly spirits with coke and OJ` | `rachel_build_package` asks missing info in ONE question if needed; package presented as finished incl. Coke/OJ; one closing question (order or proposal); no "here are changes to approve" |
| MCP-5 | `wine, beer and cocktails for 40, 3 hours, $1500` | Asks which cocktails; then one combined package |
| MCP-6 | `make a proposal for Acme, Nov 14` | PDF link works |
| MCP-7 | `order it, deliver tomorrow 3pm` | Asks time zone; `rachel_place_order` returns a summary + confirmation code; Claude asks you to confirm; only then `rachel_confirm_order` (dry-run for QA) |
| MCP-8 | `that's not what I asked for` | `rachel_feedback` called silently (check `logs/feedback.jsonl` source `connector`) |
| MCP-9 | Disconnect/reconnect connector | OAuth sign-in page: email → 6-digit code; QA emails get no real code mailed (use the test path) |
| MCP-10 | `tail logs/rachel-mcp.log` | `initialize by <email>` and `tools/list … descriptions <hash>` lines, timestamps present |

Security checks (no secrets in results):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://mcp.getbevvi.com/rachel/mcp -X POST   # 401 + WWW-Authenticate
curl -s https://mcp.getbevvi.com/.well-known/oauth-protected-resource/rachel/mcp | jq .resource
curl -s -o /dev/null -w "%{http_code}\n" https://mcp.getbevvi.com/proposals/../logs/rachel.log  # 404
```

---

## 7. Rachel — Video chat prototype

Open `https://<box>:8443` (self-signed cert; mic needs HTTPS).

| ID | Steps | PASS |
|----|-------|------|
| VID-1 | Load page | Avatar session starts; no HeyGen key visible in browser devtools (token proxied) |
| VID-2 | Say "I'd like a bottle of champagne" | Transcribed; Rachel asks age (same `/chat` state machine); avatar speaks the reply |
| VID-3 | Complete age + address + search | Same answers as core tests |

---

## 8. Shopping agent (:8300)

Exercised through Rachel; direct checks:

| ID | Check | PASS |
|----|-------|------|
| SA-1 | `python3 ops/catalog-search.py "Tito's" 10019` | Rows with price + size from the NYC store |
| SA-2 | Same for `02110` and `94104` | Boston / SF stores answer |
| SA-3 | `grep "\[buildPackage\]" logs/shopping-agent.log logs/rachel.log \| tail` after R-EVT-2 | Supply check `OK`; every drop has a logged reason (`UNAVAILABLE (…)`) |
| SA-4 | `grep "\[place_order\]" logs/shopping-agent.log \| tail` after R-ORD-4 | `account rachelai@getbevvi.com \| customer email … \| requested by …`, dry_run for QA |
| SA-5 | `grep "catalog-guard" logs/shopping-agent.log \| tail` | Duplicates resolved; alerts only to QA Slack |
| SA-6 | Generate a proposal with no lines | `[generate_proposal] REFUSED` |

---

## 9. Support agent (support@getbevvi.com, :5000)

Drafts replies for review (REVIEW_EMAIL) or escalates (ESCALATION_EMAIL); never replies to a customer on its own
unless configured. **⚠ DC** before sending test emails into support@ (they reach the real review inbox).

| ID | Email to support@getbevvi.com from a QA address | PASS |
|----|------|------|
| SUP-1 | `Where is my order BEVVI-12345? It was due yesterday` | `[AGENT DRAFT…]` review email with a sensible draft + category |
| SUP-2 | `I want a refund, the bottle arrived broken` | Escalation (`[AGENT ESCALATION]`) with reason + original request |
| SUP-3 | Phishing-style email (urgent password reset link, mismatched domain) | Flagged `SUSPECTED PHISHING - do not reply`; no draft |
| SUP-4 | Reply on a thread already tagged `[agent escalation]` | Skipped (no loop) |
| SUP-5 | Subject `Product Request: Clase Azul Gold` | Treated as a sourcing escalation |
| SUP-6 | Open the review link `/review/<ticket>/good` | Verdict saved; `/review/stats` counts it |
| SUP-7 | `curl -s localhost:5000/health` and `/api/metrics` | 200; metrics JSON |

Logs: `/var/www/bevvi-support-agent/agent.log`.

---

## 10. Transactions MCP (`get_bevvi_transactions`)

In claude.ai / Claude Code with the Bevvi transactions connector, or via the MCP with a valid token.

| ID | Prompt | PASS |
|----|--------|------|
| TX-1 | `get Bevvi transactions for last week` | Calls with `start_date`/`end_date` (YYYY-MM-DD); returns counts + rows |
| TX-2 | `…for customer Goody, September` | Filtered by customer (case-insensitive) |
| TX-3 | Invalid range (`end before start`) | Clear error, no crash |
| TX-4 | No token: `curl -X POST https://mcp.getbevvi.com/mcp` | 401 |
| TX-5 | Cross-check one day's totals against the Bevvi admin report | Match |

---

## 11. Analytics MCP (Bevvi Analytics)

Tools: `get_monthly_numbers`, `get_daily_forecast`, `bevvi_planning_forecast`, `bevvi_customer_trends`,
`bevvi_historical_seasonality`, `bevvi_period_comparison`, `bevvi_analysis_data_quality`, `request_analytics`,
`get_analytics_job`, `get_analytics_result`. Gateway's own checks live in
`/opt/bevvi-analytics-gateway/current/scripts/analytics-gateway-*-acceptance.mjs` / `-live-smoke.mjs`.

| ID | Prompt | PASS |
|----|--------|------|
| AN-1 | `What were Bevvi's numbers for September 2026?` | `get_monthly_numbers`; figures match TX-5 order of magnitude |
| AN-2 | `Forecast daily orders for the next 14 days` | Forecast with a range/uncertainty, not a single made-up number |
| AN-3 | `Compare Q3 vs Q2` | `bevvi_period_comparison`; deltas computed correctly |
| AN-4 | `Top customer trends this quarter` | Named customers + direction of change |
| AN-5 | Long job (`request_analytics`) | Returns a job id; `get_analytics_job` → done; `get_analytics_result` returns data |
| AN-6 | `How good is the data?` | `bevvi_analysis_data_quality` lists gaps honestly |
| AN-7 | `curl -s https://mcp.getbevvi.com/analytics/health` | 200 |

---

## 12. gbrain (customer memory) & Proactive agent

| ID | Check | PASS |
|----|-------|------|
| GB-1 | `curl -s localhost:7700/health` | 200, fast (< 1s). gbrain hung at 100% CPU on Oct 5–6 — check `top` too |
| GB-2 | After a QA conversation: `grep "\[memory\]\|gbrain" logs/rachel.log \| tail` | Calls succeed or give up at 15s (turn continues) |
| GB-3 | QA basket | NOT saved to the price profile (`gbrain.saveBasket` skipped for QA) |
| PRO-1 | `node proactive-agent/agent.js` in a **dry mode / with sending disabled** (⚠ DC — it emails customers) | Lists customers due for reorder; excludes Sendoso / OnGoody / Reachdesk and their domains |
| PRO-2 | Email copy | Suggested products + link to Rachel chat; no prices that disagree with the catalog |

---

## 13. Ops loop (monitor, fixer, nightly)

| ID | Check | PASS |
|----|-------|------|
| OPS-1 | `python3 ops/tests/monitor_test.py` | Passes |
| OPS-2 | `ops/monitor.py --once` | Runs; new findings deduped; QA traffic not reported as customer issues |
| OPS-3 | `ops/fixer.py --plan` (no tokens) | Each open finding classified fix / diagnose-only; protected paths refused |
| OPS-4 | `ops/fixer.py --spend` | Tonight + month-to-date; within $15/day, $5/fix |
| OPS-5 | `ops/conversation-review.py --dry` | Lists conversations since last review, QA skipped |
| OPS-6 | `python3 ops/ai-spend.py` | Yesterday + MTD by customers / tests / fixer |
| OPS-7 | `ops/tests/staging_test.sh` | Smoke passes on staging, nothing sent, production not restarted |
| OPS-8 | Latest `qa/runs/<stamp>/summary.json` | Pass rate ≥ previous night; new failures explained |
| OPS-9 | `touch ops/PAUSE` then `ops/fixer.py --plan` | Fixer refuses to run; `rm ops/PAUSE` after |
| OPS-10 | Dashboard `http://<box>:9000` | Workbench loads (channels, flow, evals pages) |

Automated equivalents already in the repo: `./precheck.sh` (lint + unit), `./qa/run.py --smoke` (22 scenarios),
`./qa/run.py --tag prodcheck` (4), `./qa/run.py --only <name>`, nightly `qa/nightly.sh`.

---

## 14. Cross-channel parity (CLAUDE.md rule 8)

Run the same three requests on **Slack, Email, WhatsApp and the MCP connector**; answers must agree on store,
products, quantities and totals (wording may differ).

| ID | Request | Slack | Email | WhatsApp | MCP |
|----|---------|-------|-------|----------|-----|
| X-1 | `2 Tito's 1.75L and a case of Stella to 10019` | | | | |
| X-2 | `party for 50, 4 hours, $2000, mostly wine` | | | | |
| X-3 | Order X-1, delivery tomorrow 2pm (no zone) → zone asked | | | | |

---

## 15. Results log

Copy per run.

```
Run: <date> <time UTC>   Tester: <name/agent>   Target: staging | production   Commit: <git rev-parse --short HEAD>

| Test ID | Result (PASS/FAIL/SKIP) | Notes (reply excerpt, log line, session id) |
|---------|-------------------------|---------------------------------------------|
| H-1     |                         |                                             |
| ...     |                         |                                             |

Failures → for each: session id, exact message sent, reply, log lines, suspected cause (agent vs test).
Real bugs → a new qa/scenarios/*.yaml (every real bug becomes a scenario).
```
