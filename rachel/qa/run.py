#!/home/ubuntu/rachel/venv/bin/python3
"""Rachel QA harness. Drives /chat through YAML scenarios with a qa- session (dry-run:
no real orders or email), checks replies, snapshots them, diffs vs the previous run.

  ./qa/run.py                 run every scenario
  ./qa/run.py --only order    run scenarios whose name contains 'order'
  ./qa/run.py --smoke         run only scenarios tagged smoke (fast pre-deploy set)
  ./qa/run.py -v              print every reply
"""
import os, sys, json, time, re, glob, argparse, difflib, base64
import yaml, httpx
HERE = os.path.dirname(os.path.abspath(__file__))
RACHEL = os.environ.get("RACHEL_URL", "http://127.0.0.1:3500/chat")
QA_EMAIL = os.environ.get("QA_EMAIL", "qa-rachel@getbevvi.com")
for line in open("/etc/rachel.env"):
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1); os.environ.setdefault(k, v)

def judge(reply, criterion):
    """LLM yes/no on a free-form reply. Cheap model; strict output."""
    try:
        import anthropic
        c = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        r = c.messages.create(model="claude-haiku-4-5-20251001", max_tokens=60, messages=[{"role": "user", "content":
            f"Reply from a beverage-ordering assistant:\n---\n{reply[:3000]}\n---\nCriterion: {criterion}\nDoes the reply satisfy the criterion? First word YES or NO, then one short reason."}])
        verdict = r.content[0].text.strip(); ok = verdict.upper().startswith("YES")
        if not ok: print("       judge:", verdict[:140])
        return ok
    except Exception as e:
        print("   judge error:", e); return False

def send(session, text, fmt, email, images=None):
    payload = {"message": text, "session_id": session, "format": fmt, "gbrain_context": "", "qa": True,
               "context": {"kitchen_location": "", "client_id": "airculinaire", "user_email": email, "account_id": ""}}
    if images: payload["images"] = images
    t0 = time.time()
    r = httpx.post(RACHEL, json=payload, timeout=240)
    return r.json().get("text", ""), round(time.time() - t0, 1)

def check(reply, expect):
    fails = []; low = reply.lower()
    for s in expect.get("contains", []):
        if s.lower() not in low: fails.append(f"missing {s!r}")
    for s in expect.get("not_contains", []):
        if s.lower() in low: fails.append(f"should not contain {s!r}")
    if "matches" in expect and not re.search(expect["matches"], reply, re.I | re.M): fails.append(f"no match /{expect['matches']}/")
    if "judge" in expect and not judge(reply, expect["judge"]): fails.append(f"judge NO: {expect['judge']}")
    return fails

def load_image(path):
    p = os.path.join(HERE, "fixtures", path); mt = "application/pdf" if p.lower().endswith(".pdf") else ("image/png" if p.lower().endswith(".png") else "image/jpeg")
    return [{"media_type": mt, "data": base64.b64encode(open(p, "rb").read()).decode()}]

def run_scenario(sc, verbose):
    name = sc["name"]; fmt = sc.get("format", "slack")
    email = sc.get("email") or (f"qa-{name}-{int(time.time())}@getbevvi.com" if sc.get("fresh") else QA_EMAIL)
    session = f"qa-{name}-{int(time.time())}"
    print(f"\n▶ {name}  [{fmt}]")
    replies = []; failures = []
    for i, turn in enumerate(sc["turns"], 1):
        text = turn.get("send", ""); images = load_image(turn["image"]) if turn.get("image") else None
        try:
            reply, secs = send(session, text, fmt, email, images)
        except Exception as e:
            reply, secs = f"<<ERROR {e}>>", 0
        replies.append({"turn": i, "send": text, "reply": reply, "secs": secs})
        fails = check(reply, turn.get("expect", {}))
        mark = "✓" if not fails else "✗"
        print(f"  {mark} {i:>2}. {text[:48]!r:52} {secs:>5}s" + ("" if not fails else "  ← " + "; ".join(fails)))
        if verbose or fails: print("       " + reply[:600].replace("\n", "\n       "))
        if fails:
            failures.append({"turn": i, "send": text, "fails": fails, "reply": reply})
            if turn.get("stop_on_fail", sc.get("stop_on_fail", False)): break
    return {"name": name, "format": fmt, "replies": replies, "failures": failures}

def diff_prev(name, replies):
    runs = sorted(glob.glob(os.path.join(HERE, "runs", "*", f"{name}.json")))[-2:-1]
    if not runs: return None
    prev = json.load(open(runs[0]))["replies"]; out = []
    for a, b in zip(prev, replies):
        if a["reply"] != b["reply"]:
            d = list(difflib.unified_diff(a["reply"].splitlines(), b["reply"].splitlines(), lineterm="", n=0))
            out.append((a["turn"], a["send"], [l for l in d if l.startswith(("+", "-")) and not l.startswith(("+++", "---"))][:8]))
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--only", default=""); ap.add_argument("--smoke", action="store_true"); ap.add_argument("-v", action="store_true")
    a = ap.parse_args()
    files = sorted(glob.glob(os.path.join(HERE, "scenarios", "*.yaml")))
    scs = [yaml.safe_load(open(f)) for f in files]
    scs = [s for s in scs if (a.only.lower() in s["name"].lower()) and (not a.smoke or "smoke" in s.get("tags", []))]
    stamp = time.strftime("%Y%m%d-%H%M%S"); outdir = os.path.join(HERE, "runs", stamp); os.makedirs(outdir, exist_ok=True)
    results = []; t0 = time.time()
    for sc in scs:
        res = run_scenario(sc, a.v); results.append(res)
        json.dump(res, open(os.path.join(outdir, f"{res['name']}.json"), "w"), indent=1)
        d = diff_prev(res["name"], res["replies"])
        if d:
            print(f"  ~ {len(d)} reply change(s) vs previous run:")
            for turn, sent, lines in d[:4]:
                print(f"     turn {turn} {sent[:40]!r}"); [print("       " + l[:120]) for l in lines]
    passed = [r for r in results if not r["failures"]]; failed = [r for r in results if r["failures"]]
    print(f"\n{'='*64}\n{len(passed)}/{len(results)} scenarios passed in {round(time.time()-t0)}s  → {outdir}")
    for r in failed: print(f"  ✗ {r['name']}: " + "; ".join(f"turn {f['turn']} ({', '.join(f['fails'])})" for f in r["failures"]))
    json.dump({"stamp": stamp, "passed": len(passed), "failed": [r["name"] for r in failed]}, open(os.path.join(outdir, "summary.json"), "w"))
    sys.exit(0 if not failed else 1)

if __name__ == "__main__": main()
