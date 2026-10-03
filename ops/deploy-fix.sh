#!/usr/bin/env bash
# Deploy a fixer branch after DC's ✅ (Debug-and-Fix Loop, Part D). Triggered by the Slack reactions handler
# (rachel_slack_bot.py) or by hand:  ops/deploy-fix.sh F-0007
#   1. refuse if the main tree has uncommitted rachel/ store-agent/ ops/ changes (a deploy would ship them too)
#   2. refuse if the branch touches protected code (ops/scope.yaml) — checked again here, not trusted from the fixer
#   3. master must fast-forward to fix/<id>; if not, say so (the fixer re-bases and re-proves next night) — never a merge
#   4. precheck.sh --deploy --stage-first (staging smoke -> prod restart -> prodcheck -> rollback on failure)
#   5. on success: master = the branch, git push, finding -> deployed; on failure: master reset to where it was
# Prints one result line for the Slack thread: "🚀 Deployed ..." or "⛔ ...".
set -uo pipefail
cd /home/ubuntu
ID=${1:?usage: ops/deploy-fix.sh <finding-id>}
BR=fix/$ID
say() { echo "$*"; }
git rev-parse --verify -q "$BR" >/dev/null || { say "⛔ Couldn't put $ID live: I can't find the fix any more (it may have been thrown away). Nothing changed."; exit 1; }
[ -z "$(git status --porcelain -- rachel store-agent ops precheck.sh)" ] || { say "⛔ Couldn't put $ID live yet: someone is in the middle of other changes to Rachel, and I won't mix this fix in with them. Nothing changed. Try ✅ again once that work is saved. (tech: uncommitted changes in the main tree)"; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = master ] || { say "⛔ Couldn't put $ID live: Rachel's code is not on its normal version right now. Nothing changed. (tech: main tree not on master)"; exit 1; }
V=$(python3 - "$BR" <<'PY'
import sys; sys.path.insert(0, '/home/ubuntu/ops'); import fixer, yaml
bad, _ = fixer.scope_violations(yaml.safe_load(open('/home/ubuntu/ops/scope.yaml')), 'master', sys.argv[1])
print('; '.join(bad))
PY
)
[ -z "$V" ] || { say "⛔ Didn't put $ID live: it changes a part of Rachel the fixer must never change on its own (ordering, payment, age checks or her main instructions). Nothing changed. (tech: $V)"; exit 1; }
git merge-base --is-ancestor master "$BR" || { say "⛔ Didn't put $ID live yet: Rachel was updated after this fix was made, so it has to be re-checked against the new version first. The fixer will do that tonight. Nothing changed."; exit 1; }
WAS=$(git rev-parse HEAD)
git merge --ff-only -q "$BR" || { say "⛔ Couldn't put $ID live because of a technical hiccup. Nothing changed. (tech: fast-forward failed)"; exit 1; }
# precheck deploys UNCOMMITTED changes; the fix is now committed on master, so it ships the working tree = the fix.
# Restart the services the fix touched: precheck decides from the diff it sees, so show it the fix as a working-tree change.
git reset -q --soft "$WAS"
OUT=$(./precheck.sh --deploy --stage-first 2>&1); RC=$?
echo "$OUT" > "logs/fixer/$ID.deploy.log"
if [ $RC -ne 0 ]; then
  # precheck stashed the change on failure (or aborted before restarting): master back where it was, tree clean
  git reset -q --hard "$WAS"; git stash list | grep -q "deploy-rollback" && git stash drop -q 2>/dev/null
  say "⛔ $ID didn't pass the final checks, so I undid it automatically. Rachel is running exactly as before. (tech: $(echo "$OUT" | grep -E '===|✗' | tail -2 | tr '\n' ' '))"
  python3 -c "import sys;sys.path.insert(0,'/home/ubuntu/ops');import monitor as M;s=M.Store();[f.update(status='review',deploy_error=sys.argv[1]) for f in s.items if f['id']==sys.argv[2]];s._save()" "$(echo "$OUT" | tail -3)" "$ID"
  exit 1
fi
# the working tree IS the branch's content (deployed and smoke-tested): point master at the branch
git reset -q --hard "$BR"
git push -q origin master 2>&1 | tail -1
C=$(git rev-parse --short HEAD)
python3 -c "import sys;sys.path.insert(0,'/home/ubuntu/ops');import monitor as M;s=M.Store();[f.update(status='deployed',deployed_commit=sys.argv[1]) for f in s.items if f['id']==sys.argv[2]];s._save()" "$C" "$ID"
say "🚀 $ID is live as of $(TZ=America/New_York date '+%-I:%M %p %Z'). It passed the final checks; customers now get the fixed behaviour. (tech: commit $C · $(echo "$OUT" | grep -E 'scenarios passed' | tail -1 | sed 's/ *→.*//'))"
