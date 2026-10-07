#!/bin/bash
# Full QA suite; summary to Slack (QA_SLACK_CHANNEL in /etc/rachel.env) and to the log.
set -o pipefail; cd /home/ubuntu/rachel
export $(grep -v '^#' /etc/rachel.env | xargs)
OUT=$(./qa/run.py 2>&1); RC=$?
SUMMARY=$(echo "$OUT" | sed -n '/^====/,$p' | tail -n +2)
CHANGES=$(echo "$OUT" | grep -c "reply change(s)")
# The monitor's own detector tests (ops/tests/monitor_test.py, debug-and-fix loop): a broken detector is a QA failure too.
# Side tests (not scenarios) also go to logs/side-tests.jsonl, so a failure becomes a monitor finding (detector side_test)
# and reaches #rachel-ops — until Oct 4 the connector test's failure was only a line in this Slack summary.
side() { python3 -c 'import json,sys,time; print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "test": sys.argv[1], "ok": sys.argv[2] == "1", "detail": [l for l in sys.argv[3].splitlines() if "✗" in l or "FAIL" in l][:20]}))' "$1" "$2" "$3" >> /home/ubuntu/logs/side-tests.jsonl; }
MONO=$(python3 /home/ubuntu/ops/tests/monitor_test.py 2>&1); MON=$(echo "$MONO" | tail -1)
if echo "$MON" | grep -q "all passed"; then side monitor_test 1 ""; else RC=1; SUMMARY="$SUMMARY"$'\n'"  ✗ $MON"; side monitor_test 0 "$MONO"; fi
# The Rachel MCP connector on its public URL (OAuth sign-in as claude.ai does it + API key + two-step dry-run order; Oct 3).
MCPO=$(python3 /home/ubuntu/ops/tests/mcp_connector_test.py 2>&1); MCPT=$(echo "$MCPO" | tail -1)
if echo "$MCPT" | grep -q "all passed"; then side mcp_connector_test 1 ""; else RC=1; SUMMARY="$SUMMARY"$'\n'"  ✗ $MCPT"; side mcp_connector_test 0 "$MCPO"; fi
STATUS=$([ $RC -eq 0 ] && echo "✅ PASS" || echo "❌ FAIL")
TEXT="*Rachel nightly QA — $STATUS*"$'\n'"$SUMMARY"$'\n'"_${CHANGES} scenario(s) had reply changes vs the previous run_"
# AI spend, yesterday + month to date: customers / tests / auto-fixer (ops/ai-spend.py; DC, Oct 3)
SPEND=$(python3 /home/ubuntu/ops/ai-spend.py 2>/dev/null) && TEXT="$TEXT"$'\n'"$SPEND"
# Conversation review (DC, Oct 7): yesterday's real conversations read by Claude; problems -> logs/review-issues.jsonl ->
# the monitor pass below makes them findings -> the fixer. Its plain-language summary rides on this Slack post.
REVIEW=$(python3 /home/ubuntu/ops/conversation-review.py 2>>/home/ubuntu/logs/conversation-review.log) && [ -n "$REVIEW" ] && TEXT="$TEXT"$'\n\n'"$REVIEW"
echo "$OUT" >> /home/ubuntu/logs/qa-nightly.log; echo "$TEXT" >> /home/ubuntu/logs/qa-nightly.log
if [ -n "$QA_SLACK_CHANNEL" ] && [ -n "$SLACK_BOT_TOKEN" ]; then
  curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"channel": sys.argv[1], "text": sys.argv[2]}))' "$QA_SLACK_CHANNEL" "$TEXT")" > /dev/null
fi
# Auto-fixer (debug-and-fix loop step 3, scheduled by DC Oct 3): the monitor records this run's failures as findings, then
# the fixer works the open ones within ops/monitor.yaml fixer: limits ($15/UTC day, $5/fix, 3 fixes). Kill switch: ops/PAUSE.
# Its review posts go to OPS_SLACK_CHANNEL (until set: logs/fixer/<id>.post.txt). After the QA post, so QA isn't delayed.
export PATH="/home/ubuntu/.npm-global/bin:$PATH"   # the claude CLI (systemd's PATH lacks it)
python3 /home/ubuntu/ops/monitor.py --once >> /home/ubuntu/logs/monitor.log 2>&1
if [ -e /home/ubuntu/ops/PAUSE ]; then echo "[nightly] fixer skipped: ops/PAUSE" >> /home/ubuntu/logs/qa-nightly.log
else python3 /home/ubuntu/ops/fixer.py >> /home/ubuntu/logs/fixer/nightly.log 2>&1 || echo "[nightly] fixer exited $?" >> /home/ubuntu/logs/qa-nightly.log; fi
exit $RC
