#!/bin/bash
# Full QA suite; summary to Slack (QA_SLACK_CHANNEL in /etc/rachel.env) and to the log.
set -o pipefail; cd /home/ubuntu/rachel
export $(grep -v '^#' /etc/rachel.env | xargs)
OUT=$(./qa/run.py 2>&1); RC=$?
SUMMARY=$(echo "$OUT" | sed -n '/^====/,$p' | tail -n +2)
CHANGES=$(echo "$OUT" | grep -c "reply change(s)")
STATUS=$([ $RC -eq 0 ] && echo "✅ PASS" || echo "❌ FAIL")
TEXT="*Rachel nightly QA — $STATUS*"$'\n'"$SUMMARY"$'\n'"_${CHANGES} scenario(s) had reply changes vs the previous run_"
echo "$OUT" >> /home/ubuntu/logs/qa-nightly.log; echo "$TEXT" >> /home/ubuntu/logs/qa-nightly.log
if [ -n "$QA_SLACK_CHANNEL" ] && [ -n "$SLACK_BOT_TOKEN" ]; then
  curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"channel": sys.argv[1], "text": sys.argv[2]}))' "$QA_SLACK_CHANNEL" "$TEXT")" > /dev/null
fi
exit $RC
