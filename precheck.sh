#!/usr/bin/env bash
# Lint + deploy gate for Rachel services.
#   ./precheck.sh            lint only (safe to run any time)
#   ./precheck.sh --smoke    lint, then QA smoke set against the LIVE service on :3500.
#                            This tests what is running, not the working tree.
#   ./precheck.sh --deploy   lint → restart → smoke. If the service fails to come up or smoke
#                            fails, the uncommitted changes under rachel/ and store-agent/ are
#                            stashed (never discarded), the service is restarted on HEAD and the
#                            smoke set re-run to show whether HEAD is healthy.
#   ./precheck.sh --deploy --stage-first
#                            lint → start a staging Rachel (ops/staging.sh, :3501, QA_MODE) from the working tree →
#                            smoke there → only if it passes: restart production → smoke → rollback on failure.
#                            A change that fails on staging never restarts production.
# DEPLOY_FORCE_SMOKE_FAIL=1 ./precheck.sh --deploy  exercises the rollback path.
#
# node --check only catches syntax errors; it CANNOT catch reassigning a const
# (a runtime TypeError). That bit us twice in one day, hence the eslint rules below.
set -uo pipefail
cd /home/ubuntu
FILES="rachel/server.js rachel/rachel.js rachel/functions.js rachel/generate-proposal.js rachel/multipick.js store-agent/shopping-agent.js store-agent/catalog-guard.js"
SCOPE="rachel store-agent"   # what a rollback stashes; precheck.sh itself is never stashed
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

lint() {
  local fail=0 f out ua
  for f in $FILES; do
    node --check "$f" 2>/dev/null || { echo "SYNTAX ERROR: $f"; fail=1; }
  done
  python3 -m py_compile rachel/email-agent.py 2>/dev/null || { echo "SYNTAX ERROR: rachel/email-agent.py"; fail=1; }
  out=$(npx --yes eslint@8 --no-eslintrc --parser-options=ecmaVersion:2022 --env node,es2022 \
    --rule '{"no-const-assign":"error","no-dupe-keys":"error","no-undef":"error","no-use-before-define":["error",{"functions":false,"classes":false,"variables":false}]}' $FILES 2>&1 | grep -E "no-const-assign|no-dupe-keys|no-undef|no-use-before-define")
  # no-use-before-define: a const/let read before its declaration throws at RUNTIME only
  # (TDZ) — node --check passes. Real: the serving-mix gate read isInternalMsg too early and
  # every turn errored until the deploy rolled back.
  if [ -n "$out" ]; then echo "$out"; fail=1; fi
  # Un-awaited async calls: node --check and eslint both miss these (a Promise silently
  # stands in for the value). Flag assignments from known async functions with no await.
  ua=$(grep -nE "=\s*(inferPriceRange|searchProducts|searchWithFallbacks|buildPackage|getCustomerProfile|applyBasketSubstitute|checkStoreCoverage|checkDeliveryAvailability)\(" $FILES | grep -v "await " || true)
  if [ -n "$ua" ]; then echo "UN-AWAITED ASYNC CALL:"; echo "$ua"; fail=1; fi
  # Unit tests (pure logic, seconds): qa/unit/*.test.js — e.g. the multi-pick resolver on real replies.
  for f in rachel/qa/unit/*.test.js; do
    [ -f "$f" ] || continue
    node "$f" > /tmp/unit-$$.out 2>&1 || { echo "UNIT TEST FAILED: $f"; grep -E "✗|got:|want:|Error" /tmp/unit-$$.out | head -12; fail=1; }
  done
  rm -f /tmp/unit-$$.out
  [ $fail -eq 0 ] && echo "LINT OK" || echo "LINT FAILED"
  return $fail
}

# smoke <label>: QA smoke set against the live service; full output kept in logs/.
smoke() {
  local log="/home/ubuntu/logs/deploy-$STAMP-$1.log" rc
  echo "Running QA smoke set ($1)... full output: $log"
  (cd /home/ubuntu/rachel && ./qa/run.py --smoke) > "$log" 2>&1; rc=$?
  grep -v "^       " "$log" | tail -6
  if [ "${DEPLOY_FORCE_SMOKE_FAIL:-}" = "1" ] && [ "$1" = "deploy" ]; then
    echo "(DEPLOY_FORCE_SMOKE_FAIL=1: treating this smoke run as failed)"; rc=1
  fi
  return $rc
}

# up <service>: active, answering HTTP, and still up a few seconds later (catches crash loops).
up() {
  local svc=$1 url i
  # rachel-email has no HTTP port: up = still active 10 s after the restart (catches a crash at startup).
  if [ "$svc" = rachel-email ]; then sleep 10; systemctl is-active --quiet "$svc"; return $?; fi
  case $svc in rachel) url=http://127.0.0.1:3500/health ;; shopping-agent) url=http://127.0.0.1:8300/ ;; esac
  for i in $(seq 1 30); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url")" != "000" ]; then
      sleep 5
      systemctl is-active --quiet "$svc" && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url")" != "000" ] && return 0
      return 1
    fi
    sleep 2
  done
  return 1
}

restart() {
  local svc ok=0
  for svc in "$@"; do
    # Never cut off a customer mid-reply (Sep 30: a deploy restarted rachel during DC's Slack message -> "I hit a
    # snag"). Wait up to 120s for rachel to be idle; rachel itself also drains what is left on SIGTERM.
    if [ "$svc" = rachel ]; then
      for i in $(seq 1 60); do
        n=$(curl -s --max-time 2 http://127.0.0.1:3500/internal/inflight | sed -n 's/.*"inflight":\([0-9]*\).*/\1/p')
        [ -z "$n" ] || [ "$n" = 0 ] && break
        [ "$i" = 1 ] && echo "rachel has $n chat(s) in flight — waiting for them to finish..."
        sleep 2
      done
    fi
    echo "Restarting $svc..."
    sudo systemctl restart "$svc"
    if up "$svc"; then echo "$svc is up"; else echo "$svc DID NOT COME UP (see /home/ubuntu/logs/)"; ok=1; fi
  done
  return $ok
}

# rollback <services...>: stash the uncommitted change, restart on HEAD, re-smoke.
rollback() {
  local head; head=$(git rev-parse --short HEAD)
  echo
  if [ -z "$DIRTY" ]; then
    echo "=== DEPLOY FAILED — NOTHING TO ROLL BACK ==="
    echo "No uncommitted changes under $SCOPE: the live code is HEAD ($head), which is what failed."
    echo "Service left running HEAD. Investigate the smoke log / service log."
    exit 1
  fi
  echo "=== DEPLOY FAILED — ROLLING BACK to HEAD ($head) ==="
  git stash push --include-untracked -m "deploy-rollback $STAMP" -- $SCOPE >/dev/null \
    || { echo "git stash FAILED — working tree untouched, service is running the FAILED change. Fix by hand."; exit 2; }
  echo "Your change is saved in $(git stash list -1 --format='%gd: %gs'). Restore with: git stash pop"
  if ! restart "$@"; then
    echo "=== ROLLBACK RESTART FAILED — service is down or crash-looping on HEAD ($head). Act now. ==="; exit 2
  fi
  if smoke rollback; then
    echo "=== ROLLED BACK: the change failed; live is HEAD ($head) and passes smoke. ==="
  else
    echo "=== ROLLED BACK, but HEAD ($head) ALSO fails smoke — failure is likely pre-existing, environmental"
    echo "    or flaky, not (only) your change. Live is HEAD. ==="
  fi
  exit 1
}

# stage_first <services...>: the working tree on staging (its own shopping-agent when shopping-agent is in the
# services), smoke against it, staging stopped either way. 0 = passed.
stage_first() {
  local log="/home/ubuntu/logs/deploy-$STAMP-staging.log" rc sa=""
  [[ " $* " == *" shopping-agent "* ]] && sa=--with-shopping-agent
  echo "Staging first: the working tree on :3501 ${sa:+(+ its own shopping-agent)}..."
  ops/staging.sh stop >/dev/null 2>&1
  ops/staging.sh start /home/ubuntu $sa || { echo "staging did not start"; ops/staging.sh stop >/dev/null; return 1; }
  echo "Running QA smoke set (staging)... full output: $log"
  (cd /home/ubuntu/rachel && ./qa/run.py --smoke --url http://127.0.0.1:3501) > "$log" 2>&1; rc=$?
  grep -v "^       " "$log" | tail -6
  ops/staging.sh stop >/dev/null
  return $rc
}

deploy() {
  local svcs=()
  DIRTY=$(git status --porcelain -- $SCOPE)
  echo "$DIRTY" | grep -q " rachel/" && svcs+=(rachel)
  # shopping-agent also loads rachel/functions.js, package-model.js and brand-lists.js — a change
  # to only those left it running the old code.
  # generate-proposal.js too: shopping-agent's generate_proposal requires it (Sep 29).
  echo "$DIRTY" | grep -qE " store-agent/| rachel/(functions|package-model|brand-lists|generate-proposal|product-match)\.js" && svcs+=(shopping-agent)
  # The email agent (rachel/email-agent.py) is its own service.
  echo "$DIRTY" | grep -q " rachel/email-agent\.py" && svcs+=(rachel-email)
  [ ${#svcs[@]} -eq 0 ] && svcs=(rachel)
  echo "Deploy $STAMP: HEAD $(git rev-parse --short HEAD), services: ${svcs[*]}"
  if [ -n "$DIRTY" ]; then echo "Uncommitted changes being deployed:"; echo "$DIRTY"; else echo "Working tree clean under $SCOPE (deploying HEAD)."; fi
  lint || { echo "=== DEPLOY ABORTED: lint failed, nothing restarted ==="; exit 1; }
  if [ "${STAGE_FIRST:-0}" = 1 ]; then stage_first "${svcs[@]}" || { echo "=== DEPLOY ABORTED: the change failed on staging — production untouched ==="; exit 1; }; fi
  restart "${svcs[@]}" || rollback "${svcs[@]}"
  smoke deploy || rollback "${svcs[@]}"
  echo "=== DEPLOY OK: ${svcs[*]} restarted and smoke passed ==="
}

# Everything runs inside main so bash has parsed the whole file before a rollback touches the tree.
main() {
  case "${1:-}" in
    --deploy) [ "${2:-}" = --stage-first ] && STAGE_FIRST=1; deploy ;;
    --smoke)  lint || exit 1; smoke live || { echo "SMOKE FAILED against the live service"; exit 1; } ;;
    "")       lint || exit 1 ;;
    *)        echo "usage: $0 [--smoke|--deploy [--stage-first]]"; exit 2 ;;
  esac
}
main "$@"; exit $?
