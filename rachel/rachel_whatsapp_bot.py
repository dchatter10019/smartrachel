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
from flask import Flask, request, Response, render_template_string, abort
import secrets, base64, io
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
INVITES_FILE  = os.environ.get("WHATSAPP_INVITES_FILE", "/home/ubuntu/logs/whatsapp-invites.json")
PENDING_FILE  = os.environ.get("WHATSAPP_PENDING_FILE", "/home/ubuntu/logs/whatsapp-pending.json")
CODE_TTL      = 30 * 60   # seconds a JOIN code stays valid
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

# ── INVITE GATE ────────────────────────────────────────────────────────────────
# Invite link -> customer enters phone -> page shows a 6-digit code + "Open WhatsApp"
# (prefills "JOIN <code>") -> the JOIN message arrives FROM their phone -> verified.
# User-initiated, so no SMS (A2P) or WhatsApp template (OTP) is needed, and the phone is
# proven by the message itself rather than by a typed number.
_inv_lock = threading.Lock()
def _jload(path):
    try:
        with open(path) as f: return json.load(f)
    except Exception: return {}
def _jsave(path, d):
    tmp = path + ".tmp"
    with open(tmp, "w") as f: json.dump(d, f, indent=1)
    os.replace(tmp, path)
def norm_phone(raw: str) -> str:
    d = re.sub(r"\D", "", raw or "")
    if len(d) == 10: d = "1" + d
    return ("+" + d) if 11 <= len(d) <= 15 else ""
def invite_valid(tok: str):
    inv = _jload(INVITES_FILE).get(tok)
    if not inv or inv.get("revoked") or inv.get("expires", 0) < time.time() or inv.get("uses_left", 0) <= 0: return None
    return inv
def is_verified(phone: str) -> bool:
    return bool(get_identity(phone).get("verified"))
def issue_code(tok: str, phone: str) -> str:
    with _inv_lock:
        pend = _jload(PENDING_FILE)
        now = time.time()
        for k in [k for k, v in pend.items() if v.get("expires", 0) < now]: pend.pop(k, None)
        code = "".join(secrets.choice("0123456789") for _ in range(6))
        while code in pend: code = "".join(secrets.choice("0123456789") for _ in range(6))
        pend[code] = {"phone": phone, "token": tok, "expires": now + CODE_TTL}
        _jsave(PENDING_FILE, pend)
    return code
def redeem_code(code: str, phone: str):
    """Returns (ok, message). On success the phone is verified and the invite consumed."""
    with _inv_lock:
        pend = _jload(PENDING_FILE); rec = pend.get(code)
        if not rec or rec.get("expires", 0) < time.time(): return False, "That code isn't valid or has expired — open your invite link again to get a new one."
        if rec.get("phone") != phone: return False, "That code was issued for a different phone number — open your invite link from this phone to get one for it."
        invs = _jload(INVITES_FILE); inv = invs.get(rec["token"])
        if not inv or inv.get("revoked") or inv.get("uses_left", 0) <= 0: return False, "That invite is no longer active."
        inv["uses_left"] = inv.get("uses_left", 1) - 1; inv.setdefault("used_by", []).append(phone); invs[rec["token"]] = inv; _jsave(INVITES_FILE, invs)
        pend.pop(code, None); _jsave(PENDING_FILE, pend)
    fields = {"verified": True, "invite": rec["token"], "first_seen": time.time()}
    if inv.get("email"): fields["email"] = inv["email"].lower()
    if inv.get("name"):  fields["name"]  = inv["name"]
    set_identity(phone, **fields)
    log.info(f"[invite] {phone} verified via {rec['token']} ({inv.get('name','')})")
    return True, ""
_told_invite_only: dict = {}   # phone -> ts of the one polite refusal per day

INVITE_PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bevvi · Rachel invite</title><style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f3ef;color:#222}
.card{max-width:420px;margin:48px auto;background:#fff;border-radius:18px;padding:32px 28px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
.logo{width:56px;height:56px;border-radius:50%;background:#b0272b;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:18px}
h1{font-size:22px;margin:0 0 8px}p{line-height:1.45;color:#444}input{width:100%;box-sizing:border-box;font-size:18px;padding:14px;border:1px solid #ccc;border-radius:12px;margin:12px 0}
.btn{display:block;text-align:center;background:#25D366;color:#fff;text-decoration:none;font-weight:600;padding:16px;border-radius:12px;font-size:17px;border:0;width:100%;cursor:pointer}
.code{font-size:40px;letter-spacing:6px;font-weight:700;text-align:center;margin:18px 0;color:#b0272b}.muted{color:#777;font-size:14px}img{display:block;margin:16px auto;max-width:180px}
</style></head><body><div class="card"><div class="logo">bevvi</div>{{ body|safe }}</div></body></html>"""

@app.route("/whatsapp/invite/<tok>", methods=["GET", "POST"])
def invite_page(tok):
    inv = invite_valid(tok)
    if not inv:
        return render_template_string(INVITE_PAGE, body="<h1>This invite isn't active</h1><p>It may have expired or already been used. Ask your Bevvi contact for a fresh link.</p>"), 410
    who = (" " + inv["name"].split()[0]) if inv.get("name") else ""
    if request.method == "GET":
        return render_template_string(INVITE_PAGE, body=f"""<h1>You're invited{who}</h1>
<p>Rachel is Bevvi's beverage specialist on WhatsApp — order wine, spirits and beer, or plan a full bar for an event, by chatting.</p>
<form method="post"><label class="muted">Your mobile number (the one you use on WhatsApp)</label>
<input name="phone" type="tel" placeholder="(917) 555-0123" required autofocus>
<button class="btn" type="submit">Get my access code</button></form>""")
    phone = norm_phone(request.form.get("phone", ""))
    if not phone:
        return render_template_string(INVITE_PAGE, body="<h1>Hmm, that number didn't look right</h1><p>Please go back and enter your mobile number with area code.</p>"), 400
    code = issue_code(tok, phone)
    digits = re.sub(r"\D", "", FROM)
    wa = f"https://wa.me/{digits}?text=JOIN%20{code}"
    qr_html = ""
    try:
        import qrcode; buf = io.BytesIO(); qrcode.make(wa).save(buf, format="PNG")
        qr_html = f'<img src="data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}" alt="QR">'
    except Exception: pass
    return render_template_string(INVITE_PAGE, body=f"""<h1>One tap to start</h1>
<p>Tap below — it opens WhatsApp with your access code ready to send. Sending it from <b>{phone}</b> activates Rachel for you.</p>
<div class="code">{code}</div>
<a class="btn" href="{wa}">Open WhatsApp</a>
<p class="muted">On a computer? Scan with your phone, or message <b>+{digits}</b> on WhatsApp with: <b>JOIN {code}</b>. The code is valid for 30 minutes.</p>{qr_html}""")

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
    jm = re.match(r"^\s*join\s*#?\s*(\d{6})\s*$", body, re.I)
    if jm:
        def _join():
            ok, msg = redeem_code(jm.group(1), phone)
            if ok:
                ident = get_identity(phone)
                send(frm, ask_rachel(phone, "__greeting__", ident.get("email", "")))
            else:
                send(frm, msg)
        threading.Thread(target=_join, daemon=True).start()
        return Response("<Response></Response>", mimetype="application/xml")
    if not is_verified(phone) and phone not in ALLOWED:
        # One polite refusal per day, then silence (no reply burns no trial messages).
        if time.time() - _told_invite_only.get(phone, 0) > 86400:
            _told_invite_only[phone] = time.time()
            threading.Thread(target=send, args=(frm, "Hi! Rachel is invite-only right now. If you have an invite link from Bevvi, open it to get your access code and send it here. Otherwise ask your Bevvi contact for one."), daemon=True).start()
        log.info(f"[webhook] blocked (not verified) {phone}"); return Response("<Response></Response>", mimetype="application/xml")
    log.info(f"[{phone}] {body[:80]}")
    threading.Thread(target=handle, args=(frm, phone, body, pname), daemon=True).start()
    return Response("<Response></Response>", mimetype="application/xml")   # ack now; reply via REST

@app.route("/whatsapp/health")
def health(): return {"ok": True, "from": FROM}

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "3600")))
