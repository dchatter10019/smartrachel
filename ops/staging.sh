#!/usr/bin/env bash
# Staging Rachel — runs code under test on :3501 so production (:3500) never runs an unproven change.
#   ops/staging.sh start [tree] [--with-shopping-agent]   tree = a checkout holding rachel/ (default /home/ubuntu)
#   ops/staging.sh stop
#   ops/staging.sh status
# Staging is safe by construction:
#   - QA_MODE=1 (rachel/staging.js): every session dry-run, no email sent, place_order always dry_run;
#     catalog-guard alerts are logged, not posted to Slack
#   - its own RACHEL_DATA_DIR (/home/ubuntu/staging/data, wiped on start): production's sessions are never loaded or
#     written (rachel/data-dir.js refuses a non-3500 port on the production dir)
#   - no channel bots (Slack / email / WhatsApp) are attached — only qa/run.py --url talks to it
#   - shopping-agent: production's :8300 (read-mostly for QA identities), or with --with-shopping-agent the tree's own
#     store-agent on :8301 (use it when the change touches store-agent/ or the rachel/ files shopping-agent loads)
# Secrets: the same Environment= values as the production units, read with `systemctl show` and handed to the
# process — never printed. Logs: logs/staging-rachel.log, logs/staging-shopping-agent.log.
set -uo pipefail
BASE=/home/ubuntu/staging
DATA=$BASE/data
LOG=/home/ubuntu/logs/staging-rachel.log
SALOG=/home/ubuntu/logs/staging-shopping-agent.log
PORT=3501
SAPORT=8301

# env_of <unit>: the unit's Environment= (and EnvironmentFile=) as NUL-separated KEY=VALUE, for `env -0`-style use.
env_of() {
  python3 - "$1" <<'PY'
import shlex, subprocess, sys
unit = sys.argv[1]
out = {}
for f in subprocess.run(['systemctl', 'show', unit, '-p', 'EnvironmentFiles', '--value'], capture_output=True, text=True).stdout.split('\n'):
    path = f.split(' (')[0].strip()
    if not path: continue
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1); out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
val = subprocess.run(['systemctl', 'show', unit, '-p', 'Environment', '--value'], capture_output=True, text=True).stdout.strip()
for kv in shlex.split(val):
    if '=' in kv:
        k, v = kv.split('=', 1); out[k] = v
sys.stdout.write(''.join(k + '=' + v + '\0' for k, v in out.items()))
PY
}

# launch <unit> <logfile> <pidfile> [KEY=VAL ...] -- <cmd...>: start cmd detached with the unit's env, QA_MODE=1 and
# the given overrides (overrides last, so they win).
launch() {
  local unit=$1 log=$2 pidf=$3; shift 3
  local -a envs=() over=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do over+=("$1"); shift; done; shift
  while IFS= read -r -d '' kv; do envs+=("$kv"); done < <(env_of "$unit")
  [ -s "$log" ] && mv -f "$log" "$log.prev"   # the last run's log is kept one start (Oct 7: a deploy's staging start wiped a suite's search log)
  : > "$log"
  setsid env "${envs[@]}" QA_MODE=1 "${over[@]}" "$@" >> "$log" 2>&1 < /dev/null &
  echo $! > "$pidf"
}

http_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1")" != "000" ]; }
port_busy() { ss -ltn "( sport = :$1 )" | grep -q ":$1"; }

start() {
  local tree=/home/ubuntu with_sa=0 a
  for a in "$@"; do case $a in --with-shopping-agent) with_sa=1 ;; *) tree=$(cd "$a" && pwd) || { echo "no such tree: $a"; return 2; } ;; esac; done
  [ -f "$tree/rachel/server.js" ] || { echo "not a Rachel tree (no rachel/server.js): $tree"; return 2; }
  if port_busy $PORT; then echo "staging port $PORT is busy — 'ops/staging.sh stop' first"; return 1; fi
  mkdir -p "$BASE"; rm -rf "$DATA"; mkdir -p "$DATA"
  local sa_url=http://127.0.0.1:8300/mcp
  if [ $with_sa = 1 ]; then
    if port_busy $SAPORT; then echo "staging shopping-agent port $SAPORT is busy"; return 1; fi
    (cd "$tree/store-agent" && launch shopping-agent "$SALOG" "$BASE/shopping-agent.pid" SHOPPING_AGENT_PORT=$SAPORT \
      ${CATALOG_API:+CATALOG_API=$CATALOG_API} ${CATALOG_API_URL:+CATALOG_API_URL=$CATALOG_API_URL} -- node "$tree/store-agent/shopping-agent.js")
    for i in $(seq 1 30); do http_up http://127.0.0.1:$SAPORT/ && break; sleep 1; done
    http_up http://127.0.0.1:$SAPORT/ || { echo "staging shopping-agent did not come up — see $SALOG"; stop; return 1; }
    sa_url=http://127.0.0.1:$SAPORT/mcp
  fi
  # CATALOG_API=getproducts (+ CATALOG_API_URL) from the caller's env: staging searches the getProducts API (rachel/catalog-api.js)
  # RACHEL_MODEL / RACHEL_EFFORT from the caller's env reach staging only (model A/B: RACHEL_MODEL=claude-sonnet-4-6 ops/staging.sh start)
  (cd "$tree/rachel" && launch rachel "$LOG" "$BASE/rachel.pid" RACHEL_PORT=$PORT RACHEL_DATA_DIR=$DATA SHOPPING_AGENT_URL=$sa_url \
    ${RACHEL_MODEL:+RACHEL_MODEL=$RACHEL_MODEL} ${RACHEL_EFFORT:+RACHEL_EFFORT=$RACHEL_EFFORT} \
    ${CATALOG_API:+CATALOG_API=$CATALOG_API} ${CATALOG_API_URL:+CATALOG_API_URL=$CATALOG_API_URL} -- node "$tree/rachel/server.js")
  echo "$tree" > "$BASE/tree"
  for i in $(seq 1 45); do http_up http://127.0.0.1:$PORT/health && break; sleep 1; done
  if ! http_up http://127.0.0.1:$PORT/health; then echo "staging rachel did not come up — see $LOG"; tail -5 "$LOG"; stop; return 1; fi
  grep -q "QA_MODE=1" "$LOG" || { echo "staging rachel is up but did not report QA_MODE=1 — stopping it (unsafe)"; stop; return 1; }
  echo "staging up: rachel :$PORT (tree $tree, data $DATA, log $LOG), shopping-agent $sa_url"
}

stop() {
  local f p
  for f in "$BASE/rachel.pid" "$BASE/shopping-agent.pid"; do
    [ -f "$f" ] || continue
    p=$(cat "$f")
    if kill -0 "$p" 2>/dev/null; then
      kill -- -"$p" 2>/dev/null || kill "$p" 2>/dev/null
      for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
      kill -0 "$p" 2>/dev/null && kill -9 -- -"$p" 2>/dev/null
    fi
    rm -f "$f"
  done
  echo "staging stopped"
}

status() {
  if http_up http://127.0.0.1:$PORT/health; then echo "staging rachel UP on :$PORT (tree $(cat $BASE/tree 2>/dev/null))"; else echo "staging rachel down"; fi
  if http_up http://127.0.0.1:$SAPORT/; then echo "staging shopping-agent UP on :$SAPORT"; fi
}

case "${1:-}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start [tree] [--with-shopping-agent] | stop | status"; exit 2 ;;
esac
