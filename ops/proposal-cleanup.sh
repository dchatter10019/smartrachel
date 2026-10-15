#!/bin/bash
# Delete proposal PDFs older than 90 days (Oct 15). Run daily from rachel/qa/nightly.sh.
# The PDFs live in /home/ubuntu/logs next to every other log and state file, so ONLY bevvi-proposal*.pdf is
# matched — never anything else in that directory. Their line items (logs/proposal-items/<pdf>.json) are kept:
# small, and /internal/session-basket from_proposal can still load an old quote. One log line per deleted file.
DIR=/home/ubuntu/logs
DAYS=${PROPOSAL_KEEP_DAYS:-90}
LOG=/home/ubuntu/logs/proposal-cleanup.log
find "$DIR" -maxdepth 1 -type f -name 'bevvi-proposal*.pdf' -mtime +"$DAYS" -print0 |
  while IFS= read -r -d '' f; do
    if rm -f -- "$f"; then echo "$(date -u +%FT%TZ) deleted $(basename "$f") (older than $DAYS days)" >> "$LOG"
    else echo "$(date -u +%FT%TZ) NOT deleted $(basename "$f"): rm failed" >> "$LOG"; fi
  done
