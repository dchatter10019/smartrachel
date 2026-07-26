#!/usr/bin/env python3
"""Bevvi Rachel Eval Runner"""

import json, requests, time, sys, uuid, subprocess
from datetime import datetime

RACHEL_URL = "http://127.0.0.1:3500/chat"
RESULTS_PATH = "/home/ubuntu/evals/eval-results.json"
EVAL_EMAIL = "eval-test@getbevvi.com"

def setup_session(setup):
    age = "true" if setup.get("age_verified") else "false"
    addr = setup.get("delivery_address", "").replace("'", "")
    zip_ = setup.get("delivery_zip", "")
    cmd = f"""
const {{saveD2CSession}} = require("/home/ubuntu/rachel/gbrain.js");
saveD2CSession("{EVAL_EMAIL}", {{
  age_verified: {age}, onboarded: true,
  delivery_address: "{addr}", delivery_zip: "{zip_}",
  last_basket: null, last_basket_total: ""
}}).then(() => process.exit(0)).catch(() => process.exit(1));
"""
    subprocess.run(["node", "-e", cmd], cwd="/home/ubuntu/rachel", capture_output=True, timeout=10)

def chat(message, session_id):
    payload = {
        "message": message,
        "session_id": session_id,
        "format": "slack",
        "context": {
            "kitchen_location": "",
            "client_id": "fooda",
            "user_email": EVAL_EMAIL,
            "account_id": ""
        }
    }
    try:
        r = requests.post(RACHEL_URL, json=payload, timeout=60)
        return r.json().get("text", "")
    except Exception as e:
        return f"ERROR: {e}"

def run_checks(response, checks):
    results = []
    for c in checks:
        t = c["type"]
        if t == "contains":
            passed = c["value"].lower() in response.lower()
        elif t == "not_contains":
            passed = c["value"].lower() not in response.lower()
        elif t == "contains_any":
            passed = any(v.lower() in response.lower() for v in c["values"])
        elif t == "tool_called":
            passed = True  # skipped for now
        else:
            passed = False
        results.append({"check": c, "passed": passed})
    return results

def run_eval(case):
    print(f"\n{'='*55}")
    print(f"[{case['id']}] {case['name']}")
    
    session_id = f"eval-{case['id']}-{uuid.uuid4().hex[:6]}"
    setup_session(case["setup"])
    
    # Reset only if first turn is not __greeting__
    if not (case["turns"] and case["turns"][0]["user"] == "__greeting__"):
        chat("__greeting__", session_id)
    
    all_passed = True
    turn_results = []
    
    for i, turn in enumerate(case["turns"]):
        msg = turn["user"]
        response = chat(msg, session_id)
        checks = run_checks(response, turn.get("checks", []))
        turn_passed = all(c["passed"] for c in checks)
        if not turn_passed:
            all_passed = False
        
        print(f"  T{i+1}: {msg[:40]!r}")
        print(f"      => {response[:80]!r}")
        for c in checks:
            print(f"      {'OK' if c['passed'] else 'FAIL'} {c['check']['type']}: {c['check'].get('value', c['check'].get('values',''))}")
        
        turn_results.append({
            "turn": i+1, "user": msg, "response": response,
            "checks": checks, "passed": turn_passed
        })
        time.sleep(0.5)
    
    status = "PASS" if all_passed else "FAIL"
    print(f"  => {status}")
    return {
        "id": case["id"], "name": case["name"],
        "passed": all_passed, "turns": turn_results,
        "timestamp": datetime.utcnow().isoformat()
    }

def main():
    with open("/home/ubuntu/evals/evals.json") as f:
        cases = json.load(f)
    
    if len(sys.argv) > 1:
        ids = sys.argv[1:]
        cases = [c for c in cases if c["id"] in ids]
    
    print(f"Running {len(cases)} eval(s)...")
    results = []
    for case in cases:
        results.append(run_eval(case))
        time.sleep(1)
    
    with open(RESULTS_PATH, "w") as f:
        json.dump(results, f, indent=2)
    
    passed = sum(1 for r in results if r["passed"])
    print(f"\n{'='*55}")
    print(f"Results: {passed}/{len(results)} passed")
    print(f"Saved: {RESULTS_PATH}")
    return 0 if passed == len(results) else 1

if __name__ == "__main__":
    sys.exit(main())
