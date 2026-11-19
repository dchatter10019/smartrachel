#!/usr/bin/env python3
"""Export Voiceflow transcripts (read-only) to one raw JSON file each.

  rachel/venv/bin/python rachel/data/vf_export.py [--start 2026-05-01] [--end YYYY-MM-DD] [--weeks N] [--probe]

- Token: VF_PAT in /home/ubuntu/.voiceflow-export.env (never printed, never logged).
- Pages one calendar week at a time (startDate/endDate), skip within the week, take 50.
- Raw files: /home/ubuntu/data/voiceflow-export/raw/<transcriptID>.json; a file that exists is skipped (resumable).
- One request at a time, a pause between requests, backoff on 429 / 5xx.
- Every transcript ID the search returned -> manifest/search-ids.txt (one per line, appended per week), so the
  raw count can be checked against what the search returned. Every skip / failure -> export.log with its reason.
Only GET/POST reads against the realtime API; nothing is written to Voiceflow.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
import re
import sys
import time

import requests

BASE = "https://realtime-api.voiceflow.com"
PROJECT = "69156ae182986ddbff0a9120"
ENV_FILE = "/home/ubuntu/.voiceflow-export.env"
OUT = "/home/ubuntu/data/voiceflow-export"
RAW = os.path.join(OUT, "raw")
MANIFEST = os.path.join(OUT, "manifest")
LOG = os.path.join(OUT, "export.log")
LOCK = os.path.join(OUT, "export.lock")
TAKE = 50
PAUSE = 0.35          # seconds between requests
MAX_TRIES = 6
CTRL = re.compile(r"[\x00-\x08\x0b-\x1f]")   # raw control chars except \t (\x09) and \n (\x0a)


def log(msg):
    line = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def load_pat():
    if os.stat(ENV_FILE).st_mode & 0o077:
        sys.exit(f"{ENV_FILE} is readable by other users; chmod 600 it first")
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line.startswith("VF_PAT="):
                v = line.split("=", 1)[1].strip().strip('"').strip("'")
                if v:
                    return v
    sys.exit(f"no VF_PAT= line in {ENV_FILE}")


class Client:
    def __init__(self, pat):
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {pat}", "Accept": "application/json"})
        self.calls = 0

    def _req(self, method, path, **kw):
        url = BASE + path
        for attempt in range(1, MAX_TRIES + 1):
            time.sleep(PAUSE)
            self.calls += 1
            try:
                r = self.s.request(method, url, timeout=60, **kw)
            except requests.RequestException as e:
                wait = min(60, 2 ** attempt)
                log(f"[retry] {method} {path.split('?')[0]} network error {type(e).__name__}; waiting {wait}s (try {attempt})")
                time.sleep(wait)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                ra = r.headers.get("Retry-After")
                wait = int(ra) if ra and ra.isdigit() else min(120, 2 ** attempt * 2)
                log(f"[retry] {method} {path.split('?')[0]} HTTP {r.status_code}; waiting {wait}s (try {attempt})")
                time.sleep(wait)
                continue
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code} on {method} {path.split('?')[0]}: {r.text[:200]}")
            text = CTRL.sub("", r.text)
            return json.loads(text)
        raise RuntimeError(f"gave up after {MAX_TRIES} tries: {method} {path.split('?')[0]}")

    def search(self, start, end, skip):
        body = {"take": TAKE, "skip": skip, "startDate": start, "endDate": end}
        return self._req("POST", f"/v2/stable/transcript/search?projectID={PROJECT}", json=body)

    def get(self, tid):
        return self._req("GET", f"/v2/stable/transcript/{tid}?projectID={PROJECT}&format=summary")


def tid_of(t):
    for k in ("_id", "id", "transcriptID", "transcriptId"):
        if t.get(k):
            return str(t[k])
    return None


def weeks(start, end):
    d = start
    while d <= end:
        e = min(d + dt.timedelta(days=6), end)
        yield d, e
        d = e + dt.timedelta(days=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-05-01")
    ap.add_argument("--end", default=dt.date.today().isoformat())
    ap.add_argument("--weeks", type=int, default=0, help="stop after N weeks (0 = all)")
    ap.add_argument("--probe", action="store_true", help="print the KEY structure of one search row + one transcript, no values")
    a = ap.parse_args()
    for d in (RAW, MANIFEST):
        os.makedirs(d, exist_ok=True)
    # One export at a time on this box: a second run (another session, a second terminal) exits at once.
    lock = open(LOCK, "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.seek(0)
        sys.exit(f"another export is already running ({lock.read().strip() or 'pid unknown'}); not starting a second one")
    lock.seek(0); lock.truncate(); lock.write(f"pid {os.getpid()} since {dt.datetime.now(dt.timezone.utc):%Y-%m-%dT%H:%M:%SZ}\n"); lock.flush()
    c = Client(load_pat())
    start, end = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)

    if a.probe:
        res = c.search(a.start, (start + dt.timedelta(days=6)).isoformat(), 0)
        print("search keys:", sorted(res.keys()), "returned:", res.get("returned"), "hasMore:", res.get("hasMore"))
        rows = res.get("transcripts") or []
        if rows:
            print("row keys:", sorted(rows[0].keys()))
            full = c.get(tid_of(rows[0]))
            print("transcript keys:", sorted(full.keys()))
            print("transcript.transcript keys:", sorted((full.get("transcript") or {}).keys()))
            print("turn roles/events:", sorted({(t.get("role"), t.get("event")) for t in full.get("turns") or []}, key=str))
        return

    ids_file = os.path.join(MANIFEST, "search-ids.txt")
    known = set()
    if os.path.exists(ids_file):
        with open(ids_file) as f:
            known = {line.split("\t", 1)[0].strip() for line in f if line.strip()}
    tot = {"listed": 0, "saved": 0, "existing": 0, "no_id": 0, "failed": 0}
    for n, (ws, we) in enumerate(weeks(start, end), 1):
        if a.weeks and n > a.weeks:
            break
        wk = {"listed": 0, "saved": 0, "existing": 0, "no_id": 0, "failed": 0}
        skip, ids = 0, []
        while True:
            res = c.search(ws.isoformat(), we.isoformat(), skip)
            rows = res.get("transcripts") or []
            for t in rows:
                tid = tid_of(t)
                if not tid:
                    wk["no_id"] += 1
                    log(f"[skip] week {ws}: search row with no transcript id (keys {sorted(t.keys())})")
                    continue
                ids.append(tid)
                wk["listed"] += 1
                path = os.path.join(RAW, f"{tid}.json")
                if os.path.exists(path):
                    wk["existing"] += 1
                    continue
                try:
                    full = c.get(tid)
                except Exception as e:  # noqa: BLE001 - logged, export goes on
                    wk["failed"] += 1
                    log(f"[failed] {tid} (week {ws}): {e}")
                    continue
                full["_search_row"] = t   # the list row's metadata, kept with the transcript
                tmp = path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(full, f, ensure_ascii=False)
                os.replace(tmp, path)
                wk["saved"] += 1
            skip += len(rows)
            if not res.get("hasMore") or not rows:
                break
        with open(ids_file, "a") as f:   # a re-run week never lists its ids twice
            f.writelines(f"{i}\t{ws}\n" for i in ids if i not in known)
        known.update(ids)
        log(f"[week] {ws}..{we}: listed {wk['listed']}, saved {wk['saved']}, already had {wk['existing']}, "
            f"failed {wk['failed']}, no id {wk['no_id']} | api calls so far {c.calls}")
        for k in tot:
            tot[k] += wk[k]
    log(f"[done] {a.start}..{a.end}: " + ", ".join(f"{k} {v}" for k, v in tot.items()))


if __name__ == "__main__":
    main()
