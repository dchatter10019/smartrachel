#!/usr/bin/env bash
# Pre-restart safety check for Rachel services.
# node --check only catches syntax errors; it CANNOT catch reassigning a const
# (a runtime TypeError). That bit us twice in one day. Run this before any restart.
set -u
cd /home/ubuntu
FILES="rachel/server.js rachel/rachel.js rachel/functions.js rachel/generate-proposal.js store-agent/shopping-agent.js"
fail=0
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
[ $fail -eq 0 ] && echo "PRECHECK OK — safe to restart" || { echo "PRECHECK FAILED — do not restart"; exit 1; }

# --smoke: run the QA smoke set (~2 min) after lint passes. Use before a restart you care about.
if [ "${1:-}" = "--smoke" ]; then
  echo "Running QA smoke set..."; cd /home/ubuntu/rachel && ./qa/run.py --smoke 2>&1 | grep -v "^       " | tail -6 || { echo "SMOKE FAILED — do not restart"; exit 1; }
fi
