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
git rev-parse --verify -q "$BR" >/dev/null || { say "⛔ $ID: no branch $BR"; exit 1; }
[ -z "$(git status --porcelain -- rachel store-agent ops precheck.sh)" ] || { say "⛔ $ID: the main tree has uncommitted changes — not deploying on top of them (commit or stash first)"; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = master ] || { say "⛔ $ID: the main tree is not on master"; exit 1; }
V=$(python3 - "$BR" <<'PY'
import sys; sys.path.insert(0, '/home/ubuntu/ops'); import fixer, yaml
bad, _ = fixer.scope_violations(yaml.safe_load(open('/home/ubuntu/ops/scope.yaml')), 'master', sys.argv[1])
print('; '.join(bad))
PY
)
[ -z "$V" ] || { say "⛔ $ID: refused — the branch touches protected code: $V"; exit 1; }
git merge-base --is-ancestor master "$BR" || { say "⛔ $ID: master moved since the fix — not a fast-forward; the fixer will rebase and re-prove it"; exit 1; }
WAS=$(git rev-parse HEAD)
git merge --ff-only -q "$BR" || { say "⛔ $ID: fast-forward failed"; exit 1; }
# precheck deploys UNCOMMITTED changes; the fix is now committed on master, so it ships the working tree = the fix.
# Restart the services the fix touched: precheck decides from the diff it sees, so show it the fix as a working-tree change.
git reset -q --soft "$WAS"
OUT=$(./precheck.sh --deploy --stage-first 2>&1); RC=$?
echo "$OUT" > "logs/fixer/$ID.deploy.log"
if [ $RC -ne 0 ]; then
  # precheck stashed the change on failure (or aborted before restarting): master back where it was, tree clean
  git reset -q --hard "$WAS"; git stash list | grep -q "deploy-rollback" && git stash drop -q 2>/dev/null
  say "⛔ Deploy of $ID failed — rolled back, master unchanged: $(echo "$OUT" | grep -E '===|✗' | tail -2 | tr '\n' ' ')"
  python3 -c "import sys;sys.path.insert(0,'/home/ubuntu/ops');import monitor as M;s=M.Store();[f.update(status='review',deploy_error=sys.argv[1]) for f in s.items if f['id']==sys.argv[2]];s._save()" "$(echo "$OUT" | tail -3)" "$ID"
  exit 1
fi
# the working tree IS the branch's content (deployed and smoke-tested): point master at the branch
git reset -q --hard "$BR"
git push -q origin master 2>&1 | tail -1
C=$(git rev-parse --short HEAD)
python3 -c "import sys;sys.path.insert(0,'/home/ubuntu/ops');import monitor as M;s=M.Store();[f.update(status='deployed',deployed_commit=sys.argv[1]) for f in s.items if f['id']==sys.argv[2]];s._save()" "$C" "$ID"
say "🚀 Deployed $ID at $(TZ=America/New_York date '+%H:%M %Z') (commit $C) · $(echo "$OUT" | grep -E 'scenarios passed' | tail -1 | sed 's/ *→.*//')"
