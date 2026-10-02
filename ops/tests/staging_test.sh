#!/usr/bin/env bash
# Staging acceptance test (Debug-and-Fix Loop spec, Part B): staging starts from the tree, the smoke set passes against
# it, it stops cleanly, it ran in QA_MODE on its own data dir, and PRODUCTION WAS NEVER RESTARTED.
#   ops/tests/staging_test.sh [--with-shopping-agent]
set -uo pipefail
cd /home/ubuntu
fail=0
check() { if eval "$2"; then echo "  ✓ $1"; else echo "  ✗ $1"; fail=1; fi; }
before=$(systemctl show rachel -p ActiveEnterTimestamp --value)
before_sa=$(systemctl show shopping-agent -p ActiveEnterTimestamp --value)

ops/staging.sh stop >/dev/null 2>&1
ops/staging.sh start /home/ubuntu "$@" || { echo "  ✗ staging did not start"; exit 1; }
check "staging answers on :3501" '[ "$(curl -s --max-time 3 http://127.0.0.1:3501/health | grep -c 3501)" = 1 ]'
check "staging runs in QA_MODE" 'grep -q "QA_MODE=1" logs/staging-rachel.log'
check "staging keeps state in its own data dir" 'grep -q "\[data-dir\] state in /home/ubuntu/staging/data" logs/staging-rachel.log'
(cd rachel && ./qa/run.py --smoke --url http://127.0.0.1:3501) > /tmp/staging-test-$$.log 2>&1; rc=$?
grep -v "^       " /tmp/staging-test-$$.log | tail -3
check "smoke set passes on staging" '[ $rc = 0 ]'
check "staging never sent an email or placed a real order" '! grep -qE "Reply sent|createCorpOrder body" logs/staging-rachel.log'
ops/staging.sh stop >/dev/null
check "staging stopped (port free)" '! ss -ltn "( sport = :3501 )" | grep -q 3501'
check "production rachel was NOT restarted" '[ "$before" = "$(systemctl show rachel -p ActiveEnterTimestamp --value)" ]'
check "production shopping-agent was NOT restarted" '[ "$before_sa" = "$(systemctl show shopping-agent -p ActiveEnterTimestamp --value)" ]'
rm -f /tmp/staging-test-$$.log
[ $fail = 0 ] && echo "staging test: all passed" || echo "staging test: FAILED"
exit $fail
