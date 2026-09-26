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

class SlackTransport:
    """Real Slack: DM Rachel as the QA user (SLACK_QA_USER_TOKEN), wait for her reply."""
    def __init__(self):
        from slack_sdk import WebClient
        self.user = WebClient(token=os.environ["SLACK_QA_USER_TOKEN"])
        bot = WebClient(token=os.environ["SLACK_BOT_TOKEN"]).auth_test()
        self.bot_user = bot["user_id"]
        self.dm = self.user.conversations_open(users=self.bot_user)["channel"]["id"]
    def send(self, text, images=None, timeout=150):
        if images:
            r = self.user.files_upload_v2(channel=self.dm, file=base64.b64decode(images[0]["data"]), filename="order.jpg", initial_comment=text or None)
            ts = str(time.time())
        else:
            ts = self.user.chat_postMessage(channel=self.dm, text=text)["ts"]
        t0 = time.time(); got = []; last_new = None
        while time.time() - t0 < timeout:
            time.sleep(2.5)
            msgs = self.user.conversations_history(channel=self.dm, oldest=ts, limit=20)["messages"]
            bot_msgs = [m for m in msgs if m.get("user") == self.bot_user]
            texts = [m.get("text", "") for m in sorted(bot_msgs, key=lambda m: float(m["ts"]))]
            if texts and texts != got: got = texts; last_new = time.time()
            elif got and last_new and time.time() - last_new > 6: break   # quiet for 6s: reply complete
        return "\n".join(got) if got else "<<NO REPLY within %ds>>" % timeout, round(time.time() - t0, 1)

class EmailTransport:
    """Real email: as rachel_qa@ (same service account, domain-wide delegation), email
    rachelai@, reply in-thread for later turns, wait for Rachel's reply in the thread."""
    QA_FROM = os.environ.get("QA_EMAIL_FROM", "rachel_qa@getbevvi.com")
    RACHEL = os.environ.get("RACHEL_EMAIL", "rachelai@getbevvi.com")
    def __init__(self, name):
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        creds = service_account.Credentials.from_service_account_file("/home/ubuntu/config/gmail-service-account.json", scopes=["https://www.googleapis.com/auth/gmail.modify"])
        self.svc = build("gmail", "v1", credentials=creds.with_subject(self.QA_FROM), cache_discovery=False)
        self.rsvc = build("gmail", "v1", credentials=creds.with_subject(self.RACHEL), cache_discovery=False)   # to mark our sends unread (API-sent mail arrives pre-read)
        self.subject = f"QA {name} {int(time.time())}"; self.thread = None; self.last_msg_id = None; self.seen = set(); self.marked = set()
    def _body(self, msg):
        import base64 as b64
        def walk(p):
            if p.get("mimeType") == "text/plain" and p.get("body", {}).get("data"): return b64.urlsafe_b64decode(p["body"]["data"]).decode("utf-8", "ignore")
            for q in p.get("parts", []) or []:
                t = walk(q)
                if t: return t
            return ""
        return walk(msg["payload"]).strip()
    def send(self, text, images=None, timeout=300):
        import base64 as b64
        from email.mime.text import MIMEText
        m = MIMEText(text); m["To"] = self.RACHEL; m["From"] = self.QA_FROM; m["Subject"] = self.subject if not self.last_msg_id else "Re: " + self.subject
        if self.last_msg_id: m["In-Reply-To"] = self.last_msg_id; m["References"] = self.last_msg_id
        body = {"raw": b64.urlsafe_b64encode(m.as_bytes()).decode()}
        if self.thread: body["threadId"] = self.thread
        sent = self.svc.users().messages().send(userId="me", body=body).execute()
        self.thread = sent["threadId"]; self.seen.add(sent["id"]); t0 = time.time()
        for _ in range(6):   # API-sent mail arrives pre-read in Rachel's mailbox: mark just this one unread
            time.sleep(3)
            got = self.rsvc.users().messages().list(userId="me", q=f'from:{self.QA_FROM} subject:"{self.subject}" newer_than:1h', maxResults=5).execute().get("messages", [])
            fresh = [g for g in got if g["id"] not in self.marked]
            if fresh:
                self.rsvc.users().messages().modify(userId="me", id=fresh[0]["id"], body={"addLabelIds": ["UNREAD"]}).execute(); self.marked.add(fresh[0]["id"]); break
        while time.time() - t0 < timeout:   # Rachel's reply: search our inbox by subject, not by thread id (thread ids are per-mailbox)
            time.sleep(10)
            got = self.svc.users().messages().list(userId="me", q=f'from:{self.RACHEL} subject:"{self.subject}" newer_than:1h', maxResults=5).execute().get("messages", [])
            for g in got:
                if g["id"] in self.seen: continue
                msg = self.svc.users().messages().get(userId="me", id=g["id"], format="full").execute()
                hdr = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
                self.seen.add(g["id"]); self.last_msg_id = hdr.get("message-id", ""); self.thread = msg.get("threadId", self.thread)
                return self._body(msg) or "<<empty body>>", round(time.time() - t0, 1)
        return "<<NO REPLY within %ds>>" % timeout, round(time.time() - t0, 1)

class WhatsAppTransport:
    """WhatsApp as the QA phone: post a Twilio-signed webhook to the bot exactly as Twilio would
    (signature check, invite gate, identity, per-phone lock, Rachel, formatting, chunking), and
    read the bot's real Twilio sends back from the Twilio API. Only the Meta->Twilio inbound hop
    is simulated. The QA phone's identity is pinned to a qa- email, so server.js isQA makes the
    whole conversation dry-run. Delivery to the handset is reported, not asserted: WhatsApp only
    delivers free-form replies within 24h of the phone itself messaging Rachel (Twilio 63016)."""
    PHONE = os.environ.get("QA_WHATSAPP_PHONE", "+19173024521")
    EMAIL = os.environ.get("QA_WHATSAPP_EMAIL", "qa-whatsapp@getbevvi.com")
    IDS = "/home/ubuntu/logs/whatsapp-identities.json"
    NOTES = ("One moment — putting that together", "Reading your photo")   # bot's slow-reply notes, not the answer
    def __init__(self):
        for line in open("/etc/rachel-whatsapp.env"):
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1); os.environ.setdefault(k, v)
        from twilio.rest import Client
        from twilio.request_validator import RequestValidator
        self.twilio = Client(os.environ["TWILIO_ACCOUNT_SID"], os.environ["TWILIO_AUTH_TOKEN"])
        self.validator = RequestValidator(os.environ["TWILIO_AUTH_TOKEN"])
        self.url = os.environ.get("PUBLIC_WEBHOOK_URL", "https://mcp.getbevvi.com/whatsapp/webhook")
        self.rachel = os.environ.get("TWILIO_WHATSAPP_FROM", "whatsapp:+15187223598")
        self.me = "whatsapp:" + self.PHONE
        self._pin_identity()
        self.seen = {m.sid for m in self.twilio.messages.list(from_=self.rachel, to=self.me, limit=50)}
    def _pin_identity(self):
        """Verified + qa- email, so the invite gate passes and Rachel treats it as QA. Refuse to run otherwise."""
        try: d = json.load(open(self.IDS))
        except FileNotFoundError: d = {}
        cur = d.get(self.PHONE, {})
        if cur.get("email") != self.EMAIL or not cur.get("verified"):
            d[self.PHONE] = dict(cur, email=self.EMAIL, verified=True, name="Rachel QA", first_seen=cur.get("first_seen") or time.time())
            tmp = self.IDS + ".tmp"; json.dump(d, open(tmp, "w"), indent=1); os.replace(tmp, self.IDS)
            print(f"   [whatsapp] pinned {self.PHONE} -> {self.EMAIL} (verified)")
        if not re.match(r"^(qa-[^@]*|rachel_qa)@getbevvi\.com$", json.load(open(self.IDS))[self.PHONE]["email"], re.I):
            raise RuntimeError(f"{self.PHONE} is not mapped to a QA email; refusing to run (orders would be real)")
    def send(self, text, images=None, timeout=240):
        if images: raise RuntimeError("whatsapp transport: images need a Twilio-hosted MediaUrl; not supported")
        import uuid
        params = {"MessageSid": "SMqa" + uuid.uuid4().hex[:28], "AccountSid": os.environ["TWILIO_ACCOUNT_SID"], "From": self.me, "To": self.rachel,
                  "Body": text, "NumMedia": "0", "ProfileName": "Rachel QA", "WaId": self.PHONE.lstrip("+")}
        sig = self.validator.compute_signature(self.url, params)
        r = httpx.post(self.url, data=params, headers={"X-Twilio-Signature": sig}, timeout=20)
        if r.status_code != 200: return f"<<WEBHOOK {r.status_code}>>", 0
        t0 = time.time(); got = []; last_new = None
        while time.time() - t0 < timeout:
            time.sleep(3)
            new = [m for m in self.twilio.messages.list(from_=self.rachel, to=self.me, limit=20) if m.sid not in self.seen]
            if new:
                new.sort(key=lambda m: m.date_created); got += new; self.seen.update(m.sid for m in new); last_new = time.time()
            answered = any(not (m.body or "").startswith(self.NOTES) for m in got)
            if answered and time.time() - last_new > 8: break   # an answer arrived, then 8s quiet: all chunks are in
        if not got: return "<<NO REPLY within %ds>>" % timeout, round(time.time() - t0, 1)
        secs = round(time.time() - t0, 1)
        self.delivery = [(m.sid, self.twilio.messages(m.sid).fetch()) for m in got]
        bad = [f"{f.status}{' ' + str(f.error_code) if f.error_code else ''}" for _, f in self.delivery if f.status in ("failed", "undelivered")]
        if bad: print(f"       [whatsapp] handset delivery: {', '.join(sorted(set(bad)))}" + (" (63016 = outside 24h window: message Rachel from the phone to reopen it)" if any("63016" in b for b in bad) else ""))
        return "\n".join(m.body or "" for m in got if not (m.body or "").startswith(self.NOTES)), secs

def send(session, text, fmt, email, images=None, idle=False):
    payload = {"message": text, "session_id": session, "format": fmt, "gbrain_context": "", "qa": True,
               "context": {"kitchen_location": "", "client_id": "airculinaire", "user_email": email, "account_id": ""}}
    if images: payload["images"] = images
    if idle: payload["simulate_idle"] = True   # server treats the session as idle past RACHEL_IDLE_HOURS
    t0 = time.time()
    r = httpx.post(RACHEL, json=payload, timeout=240)
    return r.json().get("text", ""), round(time.time() - t0, 1)

LOG = "/home/ubuntu/logs/rachel.log"
def _log_size():
    try: return os.path.getsize(LOG)
    except Exception: return 0
def _log_since(pos):
    try:
        with open(LOG, "rb") as f: f.seek(pos); return f.read().decode("utf-8", "ignore")
    except Exception: return ""
def check(reply, expect, log_text=""):
    fails = []; low = reply.lower()
    for s in expect.get("log_contains", []):
        if s not in log_text: fails.append(f"log missing {s!r}")
    for s in expect.get("contains", []):
        if s.lower() not in low: fails.append(f"missing {s!r}")
    for s in expect.get("not_contains", []):
        if s.lower() in low: fails.append(f"should not contain {s!r}")
    if "matches" in expect and not re.search(expect["matches"], reply, re.I | re.M): fails.append(f"no match /{expect['matches']}/")
    if "pdf_contains" in expect or "pdf_not_contains" in expect:
        m = re.search(r"https?://\S+?\.pdf", reply)
        txt = ""
        if m:
            try:
                import subprocess, tempfile
                pdf = httpx.get(m.group(0), timeout=30).content
                with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f: f.write(pdf); path = f.name
                txt = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True, timeout=30).stdout
            except Exception as e: fails.append(f"pdf read error: {e}")
        else: fails.append("no PDF link in reply")
        for s_ in expect.get("pdf_contains", []):
            if s_.lower() not in txt.lower(): fails.append(f"PDF missing {s_!r}")
        for s_ in expect.get("pdf_not_contains", []):
            if s_.lower() in txt.lower(): fails.append(f"PDF should not contain {s_!r}")
    if "judge" in expect and not judge(reply, expect["judge"]): fails.append(f"judge NO: {expect['judge']}")
    return fails

def load_image(path):
    p = os.path.join(HERE, "fixtures", path); mt = "application/pdf" if p.lower().endswith(".pdf") else ("image/png" if p.lower().endswith(".png") else "image/jpeg")
    return [{"media_type": mt, "data": base64.b64encode(open(p, "rb").read()).decode()}]

def run_scenario(sc, verbose):
    name = sc["name"]; fmt = sc.get("format", "slack"); transport = sc.get("transport", "http")
    slack = {"slack": SlackTransport, "email": lambda: EmailTransport(name), "whatsapp": WhatsAppTransport}.get(transport, lambda: None)()
    email = sc.get("email") or (f"qa-{name}-{int(time.time())}@getbevvi.com" if sc.get("fresh") else QA_EMAIL)
    session = f"qa-{name}-{int(time.time())}"
    print(f"\n▶ {name}  [{transport if transport != 'http' else fmt}]")
    replies = []; failures = []
    for i, turn in enumerate(sc["turns"], 1):
        text = turn.get("send", ""); images = load_image(turn["image"]) if turn.get("image") else None
        pos = _log_size()
        try:
            reply, secs = slack.send(text, images) if slack else send(session, text, fmt, email, images, turn.get("idle", False))
        except Exception as e:
            reply, secs = f"<<ERROR {e}>>", 0
        replies.append({"turn": i, "send": text, "reply": reply, "secs": secs})
        fails = check(reply, turn.get("expect", {}), _log_since(pos))
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
