#!/usr/bin/env bash
# Lint + deploy gate for Rachel services.
#   ./precheck.sh            lint only (safe to run any time)
#   ./precheck.sh --smoke    lint, then QA smoke set against the LIVE service on :3500.
#                            This tests what is running, not the working tree.
#   ./precheck.sh --deploy   lint → restart → smoke. If the service fails to come up or smoke
#                            fails, the uncommitted changes under rachel/ and store-agent/ are
#                            stashed (never discarded), the service is restarted on HEAD and the
#                            smoke set re-run to show whether HEAD is healthy.
# DEPLOY_FORCE_SMOKE_FAIL=1 ./precheck.sh --deploy  exercises the rollback path.
#
# node --check only catches syntax errors; it CANNOT catch reassigning a const
# (a runtime TypeError). That bit us twice in one day, hence the eslint rules below.
set -uo pipefail
cd /home/ubuntu
FILES="rachel/server.js rachel/rachel.js rachel/functions.js rachel/generate-proposal.js store-agent/shopping-agent.js"
SCOPE="rachel store-agent"   # what a rollback stashes; precheck.sh itself is never stashed
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

lint() {
  local fail=0 f out ua
  for f in $FILES; do
    node --check "$f" 2>/dev/null || { echo "SYNTAX ERROR: $f"; fail=1; }
  done
  out=$(npx --yes eslint@8 --no-eslintrc --parser-options=ecmaVersion:2022 --env node,es2022 \
    --rule '{"no-const-assign":"error","no-undef":"error"}' $FILES 2>&1 | grep -E "no-const-assign|no-undef")
  if [ -n "$out" ]; then echo "$out"; fail=1; fi
  # Un-awaited async calls: node --check and eslint both miss these (a Promise silently
  # stands in for the value). Flag assignments from known async functions with no await.
  ua=$(grep -nE "=\s*(inferPriceRange|searchProducts|searchWithFallbacks|buildPackage|getCustomerProfile|applyBasketSubstitute|checkStoreCoverage|checkDeliveryAvailability)\(" $FILES | grep -v "await " || true)
  if [ -n "$ua" ]; then echo "UN-AWAITED ASYNC CALL:"; echo "$ua"; fail=1; fi
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

deploy() {
  local svcs=()
  DIRTY=$(git status --porcelain -- $SCOPE)
  echo "$DIRTY" | grep -q " rachel/" && svcs+=(rachel)
  echo "$DIRTY" | grep -q " store-agent/" && svcs+=(shopping-agent)
  [ ${#svcs[@]} -eq 0 ] && svcs=(rachel)
  echo "Deploy $STAMP: HEAD $(git rev-parse --short HEAD), services: ${svcs[*]}"
  if [ -n "$DIRTY" ]; then echo "Uncommitted changes being deployed:"; echo "$DIRTY"; else echo "Working tree clean under $SCOPE (deploying HEAD)."; fi
  lint || { echo "=== DEPLOY ABORTED: lint failed, nothing restarted ==="; exit 1; }
  restart "${svcs[@]}" || rollback "${svcs[@]}"
  smoke deploy || rollback "${svcs[@]}"
  echo "=== DEPLOY OK: ${svcs[*]} restarted and smoke passed ==="
}

# Everything runs inside main so bash has parsed the whole file before a rollback touches the tree.
main() {
  case "${1:-}" in
    --deploy) deploy ;;
    --smoke)  lint || exit 1; smoke live || { echo "SMOKE FAILED against the live service"; exit 1; } ;;
    "")       lint || exit 1 ;;
    *)        echo "usage: $0 [--smoke|--deploy]"; exit 2 ;;
  esac
}
main "$@"; exit $?
