#!/home/ubuntu/rachel/venv/bin/python3
"""Reader for logs/events.jsonl (Learning Phase 1, Part A) — shared by qa/digest.py, the QA harness
and ad-hoc analysis.

  ./qa/events.py --today          today's funnel (real customers only), a sanity check
  ./qa/events.py --today --qa     include QA sessions
  ./qa/events.py --session ID     every event of one session, one per line
"""
import os, sys, json, argparse, datetime as dt
from collections import Counter, defaultdict

FILE = os.environ.get("RACHEL_EVENTS_FILE", "/home/ubuntu/logs/events.jsonl")

def load(path=FILE, since=None, until=None, include_qa=False, session=None):
    """Events as dicts, oldest first. since/until: aware datetimes (UTC). Bad lines are skipped."""
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try: e = json.loads(line)
                except Exception: continue
                if session and e.get("session") != session: continue
                if not include_qa and e.get("qa"): continue
                if since or until:
                    try: t = dt.datetime.fromisoformat(e["ts"].replace("Z", "+00:00"))
                    except Exception: continue
                    if since and t < since: continue
                    if until and t >= until: continue
                out.append(e)
    except FileNotFoundError:
        pass
    return out

def funnel(evs):
    """Per-channel session counts: sessions / reached basket / placed order / sent proposal."""
    by = defaultdict(lambda: defaultdict(set))
    for e in evs:
        ch, s, a = e.get("channel", "?"), e.get("session"), e.get("action")
        for key in (ch, "total"):
            by[key]["sessions"].add(s)
            if a == "built_basket": by[key]["basket"].add(s)
            if a == "placed_order" and not e.get("dry_run"): by[key]["orders"].add(s)
            if a == "generated_proposal": by[key]["proposals"].add(s)
    return {ch: {k: len(v) for k, v in d.items()} for ch, d in by.items()}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--today", action="store_true"); ap.add_argument("--qa", action="store_true"); ap.add_argument("--session")
    a = ap.parse_args()
    if a.session:
        for e in load(session=a.session, include_qa=True): print(json.dumps(e))
        return
    if a.today:
        start = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        evs = load(since=start, include_qa=a.qa)
        f = funnel(evs)
        print(f"{len(evs)} events today ({'incl.' if a.qa else 'excl.'} QA)")
        for ch in sorted(f, key=lambda c: (c == "total", c)):
            d = f[ch]; print(f"  {ch:9} sessions {d.get('sessions', 0):3} · basket {d.get('basket', 0):3} · orders {d.get('orders', 0):3} · proposals {d.get('proposals', 0):3}")
        print("  actions: " + " · ".join(f"{k} {v}" for k, v in Counter(e.get("action") for e in evs).most_common()))
        return
    ap.print_help()

if __name__ == "__main__": main()
