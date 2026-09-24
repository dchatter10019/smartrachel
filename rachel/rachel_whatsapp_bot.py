#!/usr/bin/env python3
"""Rachel WhatsApp client (Twilio). Mirrors rachel_slack_bot.py turn for turn.

Differences from Slack, all forced by the channel:
- Twilio delivers inbound messages by HTTPS webhook (validated by signature) and
  expects a fast response, while Rachel can take 10-30s on a build: we ack instantly
  with empty TwiML, process in a background thread (serialized per phone), and send
  the reply via Twilio's REST API. A "one moment" note goes out only if it's slow.
- WhatsApp identifies people by phone number; Rachel keys sessions/profile/orders on
  email. We ask for the email once on first contact and remember phone -> email.
- Twilio caps a WhatsApp body at 1600 chars; long package summaries are chunked on
  line boundaries. Slack's <url|text> links become "text: url".
"""
import os, re, json, time, logging, threading
from flask import Flask, request, Response
import httpx
from twilio.rest import Client
from twilio.request_validator import RequestValidator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("rachel-whatsapp")

ACCOUNT_SID = os.environ["TWILIO_ACCOUNT_SID"]
AUTH_TOKEN  = os.environ["TWILIO_AUTH_TOKEN"]
FROM        = os.environ.get("TWILIO_WHATSAPP_FROM", "whatsapp:+15187223598")
PUBLIC_URL  = os.environ.get("PUBLIC_WEBHOOK_URL", "https://mcp.getbevvi.com/whatsapp/webhook")
RACHEL_URL  = os.environ.get("RACHEL_URL", "http://127.0.0.1:3500/chat")
ALLOWED     = {p.strip() for p in os.environ.get("WHATSAPP_ALLOWED", "").split(",") if p.strip()}  # empty = open
IDENTITY_FILE = os.environ.get("WHATSAPP_IDENTITY_FILE", "/home/ubuntu/logs/whatsapp-identities.json")
SLOW_NOTE_AFTER = 12.0   # seconds before sending "one moment"
CHUNK = 1500            # under Twilio's 1600-char WhatsApp body cap

twilio = Client(ACCOUNT_SID, AUTH_TOKEN)
validator = RequestValidator(AUTH_TOKEN)
app = Flask(__name__)

# ── identity: phone -> {email, first_seen} ────────────────────────────────────
_id_lock = threading.Lock()
def _load_ids() -> dict:
    try:
        with open(IDENTITY_FILE) as f: return json.load(f)
    except Exception: return {}
def _save_ids(d: dict):
    tmp = IDENTITY_FILE + ".tmp"
    with open(tmp, "w") as f: json.dump(d, f, indent=1)
    os.replace(tmp, IDENTITY_FILE)
def get_identity(phone: str) -> dict:
    with _id_lock: return _load_ids().get(phone, {})
def set_identity(phone: str, **fields):
    with _id_lock:
        d = _load_ids(); d.setdefault(phone, {}).update(fields); _save_ids(d)

# ── per-phone serialization + dedup (same pattern as the Slack bot) ───────────
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
def _lock_for(phone: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(phone, threading.Lock())
_seen_sids: dict[str, float] = {}

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")

# ── Rachel ────────────────────────────────────────────────────────────────────
def ask_rachel(phone: str, text: str, user_email: str) -> str:
    # Session keyed on the phone (stable for WhatsApp); email carried for profile/orders.
    session_key = f"whatsapp-{phone}"
    payload = {
        "message": text,
        "session_id": session_key,
        "format": "whatsapp",
        "gbrain_context": "",
        "context": {"kitchen_location": "", "client_id": "airculinaire", "user_email": user_email, "account_id": ""},
    }
    try:
        r = httpx.post(RACHEL_URL, json=payload, timeout=180)
        return r.json().get("text", "Sorry, I hit a snag — try again in a second.")
    except Exception as e:
        log.error(f"[rachel] error: {e}")
        return "Sorry, I hit a snag — try again in a second."

def to_whatsapp(text: str) -> str:
    # Slack link markup <url|label> -> "label: url"; bare <url> -> url; unescape entities.
    text = re.sub(r"<(https?://[^|>]+)\|([^>]+)>", r"\2: \1", text)
    text = re.sub(r"<(https?://[^>]+)>", r"\1", text)
    return text.replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&")

def chunks(text: str):
    while len(text) > CHUNK:
        cut = text.rfind("\n", 0, CHUNK)
        if cut < CHUNK // 2: cut = CHUNK
        yield text[:cut].rstrip(); text = text[cut:].lstrip("\n")
    if text: yield text

def send(to: str, text: str):
    for part in chunks(to_whatsapp(text)):
        try: twilio.messages.create(from_=FROM, to=to, body=part)
        except Exception as e: log.error(f"[twilio] send error to {to}: {e}")

# ── message handling ──────────────────────────────────────────────────────────
def handle(to: str, phone: str, text: str, profile_name: str):
    with _lock_for(phone):
        _handle_unlocked(to, phone, text, profile_name)

def _handle_unlocked(to: str, phone: str, text: str, profile_name: str):
    ident = get_identity(phone)
    email = ident.get("email", "")
    low = text.lower().strip()

    # Reset (same words as Slack) -> fresh greeting.
    if low in ("reset", "start over", "clear"):
        send(to, ask_rachel(phone, "__greeting__", email)); return

    # First contact: capture the email once (Rachel keys profile/orders on it), then greet.
    if not email:
        m = EMAIL_RE.search(text)
        if m:
            email = m.group(0).lower()   # phones auto-capitalize the first letter; Bevvi's account lookup is case-sensitive
            set_identity(phone, email=email, name=profile_name, first_seen=ident.get("first_seen") or time.time())
            send(to, ask_rachel(phone, "__greeting__", email)); return
        if not ident.get("asked_email"):
            set_identity(phone, asked_email=True, name=profile_name, first_seen=time.time())
        send(to, f"Hi{' ' + profile_name if profile_name else ''}! I'm Rachel, Bevvi's beverage specialist. To get started, what email address should I use for your account?")
        return

    # Slow-reply note, only if Rachel takes a while (WhatsApp has no ephemeral placeholder).
    # Race fix: the note thread woke at the threshold just as the reply arrived, and
    # Twilio delivered the note AFTER the answer. Now the note re-checks `done` right
    # before sending, and the reply JOINS the note thread so a note in flight always
    # lands first. Threshold raised so ordinary 8s lookups don't trigger it.
    done = threading.Event()
    def slow_note():
        if not done.wait(SLOW_NOTE_AFTER) and not done.is_set():
            send(to, "One moment — putting that together 🍷")
    t = threading.Thread(target=slow_note, daemon=True); t.start()
    try:
        reply = ask_rachel(phone, text, email)
    finally:
        done.set()
    t.join(timeout=3)   # let an in-flight note finish before the reply goes out
    send(to, reply)

@app.route("/whatsapp/webhook", methods=["POST"])
def webhook():
    sig = request.headers.get("X-Twilio-Signature", "")
    if not validator.validate(PUBLIC_URL, request.form.to_dict(), sig):
        log.warning("[webhook] bad signature"); return Response("forbidden", status=403)
    sid   = request.form.get("MessageSid", "")
    frm   = request.form.get("From", "")          # "whatsapp:+1917..."
    body  = (request.form.get("Body") or "").strip()
    pname = request.form.get("ProfileName", "")
    phone = frm.replace("whatsapp:", "")
    now = time.time()
    for k in [k for k, t in _seen_sids.items() if now - t > 600]: _seen_sids.pop(k, None)
    if not sid or sid in _seen_sids or not body or not frm.startswith("whatsapp:"):
        return Response("<Response></Response>", mimetype="application/xml")
    _seen_sids[sid] = now
    if ALLOWED and phone not in ALLOWED:
        log.info(f"[webhook] blocked {phone}"); return Response("<Response></Response>", mimetype="application/xml")
    log.info(f"[{phone}] {body[:80]}")
    threading.Thread(target=handle, args=(frm, phone, body, pname), daemon=True).start()
    return Response("<Response></Response>", mimetype="application/xml")   # ack now; reply via REST

@app.route("/whatsapp/health")
def health(): return {"ok": True, "from": FROM}

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "3600")))
