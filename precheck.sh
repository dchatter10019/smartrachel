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
[ $fail -eq 0 ] && echo "PRECHECK OK — safe to restart" || { echo "PRECHECK FAILED — do not restart"; exit 1; }
