#!/usr/bin/env python3
"""
Rachel Slack Bot — No @mention required, with GBrain memory
Responds to all messages in #rachel_ai and all DMs
GBrain lookup: email first, then display name, then Slack user ID
"""

import os
import re
import json
import time
import subprocess
import logging
import threading
import httpx
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rachel")

# ── CONFIG ────────────────────────────────────────────────────────────────────
SLACK_BOT_TOKEN   = os.environ["SLACK_BOT_TOKEN"]

# Dedup set for Slack retries
_processed_events = set()
SLACK_APP_TOKEN   = os.environ["SLACK_APP_TOKEN"]
RACHEL_CHANNEL_ID = os.environ["RACHEL_CHANNEL_ID"]
ALLOWED_USERS     = set(os.environ.get("ALLOWED_USERS", "").split(","))

# ── GBRAIN ────────────────────────────────────────────────────────────────────
GBRAIN_URL   = "http://127.0.0.1:7700/mcp"
GBRAIN_TOKEN = os.environ.get("GBRAIN_TOKEN", "")  # /etc/gbrain.env
GBRAIN_HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {GBRAIN_TOKEN}",
    "Accept": "application/json, text/event-stream",
}

def gbrain_query(query: str) -> str | None:
    """Query GBrain for customer context — mirrors gbrain.js logic"""
    try:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "query", "arguments": {"query": query}}
        }
        r = httpx.post(GBRAIN_URL, headers=GBRAIN_HEADERS, json=payload, timeout=5)
        for line in r.text.splitlines():
            if line.startswith("data: "):
                try:
                    data = json.loads(line[6:])
                    text = data.get("result", {}).get("content", [{}])[0].get("text", "")
                    if text:
                        rows = json.loads(text)
                        if isinstance(rows, list) and rows:
                            matches = [row for row in rows if query.lower() in json.dumps(row).lower()]
                            if matches:
                                return "\n\n---\n\n".join(
                                    row.get("chunk_text", json.dumps(row)) for row in matches
                                )
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
        return None
    except Exception as e:
        log.error(f"[gbrain] query error: {e}")
        return None

def get_customer_context(client, user_id: str) -> str:
    """
    Pull customer context from GBrain.
    Tries in order: Slack email → display name → Slack user ID
    Email is the most reliable match since GBrain stores customer emails.
    """
    name  = ""
    email = ""
    try:
        result  = client.users_info(user=user_id)
        profile = result["user"]["profile"]
        name    = profile.get("display_name") or profile.get("real_name") or ""
        email   = profile.get("email", "")
    except Exception as e:
        log.warning(f"[gbrain] could not fetch Slack profile for {user_id}: {e}")

    # 1. Try email first — most reliable
    context = None
    if email:
        context = gbrain_query(email)
        log.info(f"[gbrain] email lookup '{email}' → {'found' if context else 'not found'}")

    # 2. Fallback: display name
    if not context and name:
        context = gbrain_query(name)
        log.info(f"[gbrain] name lookup '{name}' → {'found' if context else 'not found'}")

    # 3. Last resort: Slack user ID
    if not context:
        context = gbrain_query(user_id)
        log.info(f"[gbrain] user_id lookup '{user_id}' → {'found' if context else 'not found'}")

    if context:
        return f"\n\n## Customer history from Bevvi\n{context}"
    return ""

# ── CONVERSATION + GBRAIN STORE ───────────────────────────────────────────────
gbrain_cache: dict[str, str] = {}
store_lock = threading.Lock()

def clear_history(user_id: str):
    with store_lock:
        gbrain_cache.pop(user_id, None)

# ── RACHEL RESPONSE ───────────────────────────────────────────────────────────
def ask_rachel(user_id: str, text: str, customer_context: str = "", user_email: str = "", images=None, user_name: str = "") -> str:
    try:
        # Session key: prefer the customer's email over the raw Slack user_id.
        # Real bug found: the same person has DIFFERENT Slack user_ids across different
        # workspaces/clients, so keying the session on user_id meant switching Slack
        # clients silently started a brand-new empty session (lost basket/address mid-
        # conversation). A person's Slack profile email is stable across workspaces, so
        # keying on it gives one continuous session everywhere. Fall back to user_id only
        # when no email is available (so behavior is never worse than before).
        session_key = f"slack-{user_email}" if user_email else f"slack-{user_id}"
        payload = {
            "message": text,
            "session_id": session_key,
            "format": "slack",
            "gbrain_context": customer_context,
            "context": {
                "kitchen_location": "",
                "client_id": "airculinaire",
                "user_email": user_email,
                "user_name": user_name,   # Slack real_name: Rachel states it at checkout instead of asking (customer-contacts.js)
                "account_id": ""
            }
        }
        if images: payload["images"] = images
        r = httpx.post("http://127.0.0.1:3500/chat", json=payload, timeout=240)
        data = r.json()
        reply = data.get("text", "Sorry, I hit a snag — try again in a second.")
        # An empty reply is refused by Slack (no_text) and the customer sees silence (Sep 29: twice in a row).
        if not (reply or "").strip():
            log.error(f"[rachel] EMPTY reply from Rachel for {session_key} on {text[:60]!r} — sent the fallback instead")
            reply = "Sorry, I lost my reply there — could you say that again?"
        return reply
    except Exception as e:
        log.error(f"[rachel] error: {e}")
        return "Sorry, I hit a snag — try again in a second."

# ── SLACK APP ─────────────────────────────────────────────────────────────────
app = App(token=SLACK_BOT_TOKEN)

def is_allowed(user_id: str) -> bool:
    if not ALLOWED_USERS or ALLOWED_USERS == {""}:
        return True
    return user_id in ALLOWED_USERS

def is_bot(event: dict) -> bool:
    # Messages posted by a human THROUGH an app (user token) carry bot_id/app_id but a
    # real user — those are customers (and the QA harness). Only true bot messages and
    # Rachel's own posts are ignored. Real bug: the QA user's DMs were silently dropped.
    if event.get("subtype") == "bot_message": return True
    if event.get("bot_id") and not event.get("user"): return True
    return event.get("user") == _BOT_USER_ID

_BOT_USER_ID = None

# Per-user serialization. Slack Bolt runs each event in its own thread, so two
# DIFFERENT messages from the same user sent in quick succession ran ask_rachel
# concurrently against the same session. Real bug: customer sent "Margarita" then
# "Old Fashioned" before the first reply; both built in parallel, neither saw the
# other, and the customer got two partial packages out of order. The existing
# dedup only catches IDENTICAL messages. This lock makes message B for a user wait
# until message A has fully completed (Rachel call + reply + saved package), so B
# correctly sees A's result and can ADD to it instead of racing it.
_user_locks: dict = {}
_user_locks_guard = threading.Lock()

def _lock_for(user_id: str) -> threading.Lock:
    with _user_locks_guard:
        if user_id not in _user_locks:
            _user_locks[user_id] = threading.Lock()
        return _user_locks[user_id]

def handle(event: dict, say, client):
    user_id = event.get("user", "")
    with _lock_for(user_id):
        return _handle_unlocked(event, say, client)

import base64 as _b64
SUPPORTED_MEDIA = ("image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf")
def fetch_slack_files(event: dict):
    """Photos/scans of an order attached to a Slack message. Needs the files:read scope."""
    out = []
    for f in (event.get("files") or [])[:4]:
        ct = (f.get("mimetype") or "").lower(); url = f.get("url_private_download") or f.get("url_private")
        if not url or ct not in SUPPORTED_MEDIA: continue
        try:
            r = httpx.get(url, headers={"Authorization": f"Bearer {SLACK_BOT_TOKEN}"}, follow_redirects=True, timeout=30)
            if r.status_code != 200 or r.headers.get("content-type", "").startswith("text/html"):
                log.warning(f"[files] fetch failed ({r.status_code}) — is the files:read scope granted?"); continue
            if len(r.content) > 15 * 1024 * 1024: log.warning("[files] too large, skipped"); continue
            out.append({"media_type": ct, "data": _b64.b64encode(r.content).decode()})
        except Exception as e:
            log.error(f"[files] error: {e}")
    return out

def _react(client, channel, ts, add=None, remove=None):
    """Reaction feedback: 👀 while working, ✅ when replied. Needs the reactions:write scope;
    fails quietly without it."""
    try:
        if remove: client.reactions_remove(channel=channel, timestamp=ts, name=remove)
    except Exception: pass
    try:
        if add: client.reactions_add(channel=channel, timestamp=ts, name=add)
    except Exception as e:
        if "missing_scope" in str(e): log.warning("[slack] reactions need the reactions:write scope")

def _handle_unlocked(event: dict, say, client):
    if is_bot(event):
        return

    user_id  = event.get("user", "")
    text     = event.get("text", "").strip()
    channel  = event.get("channel", "")

    images = fetch_slack_files(event) if event.get("files") else []
    if (not text and not images) or not user_id:
        return

    if not is_allowed(user_id):
        log.info(f"[slack] blocked user {user_id}")
        return

    # Strip any accidental @rachel mention
    try:
        bot_id = client.auth_test()["user_id"]
        text = text.replace(f"<@{bot_id}>", "").strip()
    except Exception:
        pass

    if not text and not images:
        return

    # Special commands
    if text.lower() in ("reset", "start over", "clear"):
        clear_history(user_id)
        gbrain_cache.pop(user_id, None)
        # Get greeting via rachel so age badge shows
        try:
            profile = client.users_info(user=user_id)["user"]["profile"]
            user_email = profile.get("email", "")
        except Exception:
            user_email = ""
        if user_id not in gbrain_cache:
            gbrain_cache[user_id] = get_customer_context(client, user_id)
        reply = ask_rachel(user_id, "__greeting__", gbrain_cache.get(user_id, ""), user_email)
        say(reply)
        return

    log.info(f"[{user_id}] {text[:80]}")

    # Load GBrain context once per session (cached per user)
    if user_id not in gbrain_cache:
        gbrain_cache[user_id] = get_customer_context(client, user_id)

    # Show typing indicator
    _react(client, channel, event.get("ts"), add="eyes")
    try:
        client.chat_postEphemeral(
            channel=channel, user=user_id,
            text=("Reading your photo... 📷 (this takes a moment)" if images else "Rachel is thinking... 🍷")
        )
    except Exception:
        pass

    # Get email for Rachel context
    user_email = ""
    user_name = ""
    try:
        profile = client.users_info(user=user_id)["user"]["profile"]
        user_email = profile.get("email", "")
        user_name = profile.get("real_name", "")   # real_name, not display_name: the order needs first + last
    except Exception:
        pass
    reply = ask_rachel(user_id, text, gbrain_cache[user_id], user_email, images or None, user_name)
    say(reply)
    _react(client, channel, event.get("ts"), add="white_check_mark", remove="eyes")

# ── EVENT LISTENERS ───────────────────────────────────────────────────────────

@app.event("message")
def handle_message(event, say, client, ack=None):
    if ack:
        ack()
    # Ignore Slack system messages (channel joins/leaves, edits, deletions, bot messages, etc.)
    # These come through as "message" events with a subtype, not real customer messages.
    # A photo/scan of an order arrives as subtype 'file_share' — that IS a real customer
    # message. Every other subtype (joins, edits, deletions, bot messages) is still dropped.
    if event.get("subtype") and event.get("subtype") != "file_share":
        return
    # Fast dedup check BEFORE any async work
    msg_id = event.get("client_msg_id") or event.get("event_ts") or event.get("ts", "")
    text_check = event.get("text", "").strip().lower()
    # Don't dedup special commands
    if msg_id and msg_id in _processed_events and text_check not in ("reset", "start over", "clear"):
        log.info(f"[slack] duplicate ignored: {msg_id}")
        return
    if msg_id:
        _processed_events.add(msg_id)
        if len(_processed_events) > 500:
            _processed_events.clear()

    channel_type = event.get("channel_type", "")
    channel      = event.get("channel", "")

    if channel_type == "im":
        handle(event, say, client)
        return

    if channel == RACHEL_CHANNEL_ID:
        handle(event, say, client)
        return

    if OPS_CHANNEL and channel in (OPS_CHANNEL, OPS_TEST):
        handle_ops_message(event, client)
        return


# ── DEBUG-AND-FIX LOOP: ✅ / ❌ on a fixer post in #rachel-ops (spec Part D) ───────────────────────────────────
# Inactive until /etc/rachel.env has OPS_SLACK_CHANNEL and OPS_APPROVERS (comma-separated Slack user ids), and the
# Slack app subscribes to reaction_added (reactions:read). ✅ by an approver runs ops/deploy-fix.sh <id> (staging-first
# deploy, rollback on failure) and replies in the thread; ❌ discards the branch. Anyone else gets "only approvers can
# deploy." Thread replies are for people — the fixer does not converse. The post's finding id is read from its text.
OPS_CHANNEL   = os.environ.get("OPS_SLACK_CHANNEL", "")
OPS_TEST      = os.environ.get("OPS_TEST_CHANNEL", "")
OPS_APPROVERS = {u.strip() for u in os.environ.get("OPS_APPROVERS", "").split(",") if u.strip()}
_fix_runs = set()

@app.event("reaction_added")
def handle_reaction(event, client, ack=None):
    if ack:
        ack()
    item = event.get("item") or {}
    ch, ts, user, name = item.get("channel", ""), item.get("ts", ""), event.get("user", ""), event.get("reaction", "")
    # 👎 on a Rachel reply (any channel / DM) = feedback for the debug-and-fix loop (DC, Oct 3): logs/feedback.jsonl ->
    # monitor finding -> nightly fixer. The person is thanked in the thread.
    if name in ("-1", "thumbsdown") and event.get("item_user") == _BOT_USER_ID and ch not in (OPS_CHANNEL, OPS_TEST):
        text, email = "", ""
        try: text = client.conversations_history(channel=ch, latest=ts, inclusive=True, limit=1)["messages"][0].get("text", "")
        except Exception as e: log.warning(f"[feedback] 👎 recorded without the reply text ({e})")
        try: email = client.users_info(user=user)["user"]["profile"].get("email", "") or ""
        except Exception: pass
        entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": "thumbs_down", "session": f"slack-{email}" if email else f"slack-{user}",
                 "who": email or user, "channel": "slack", "text": "👎 on Rachel's reply", "rachel_said": text[:1500],
                 "qa": bool(re.match(r"^(qa-[^@]*|rachel_qa)@getbevvi\.com$", email or "", re.I))}
        try:
            with open(os.path.join(os.environ.get("RACHEL_DATA_DIR", "/home/ubuntu/logs"), "feedback.jsonl"), "a") as f: f.write(json.dumps(entry) + "\n")
            log.info(f"[feedback] 👎 by {email or user} on a Rachel reply recorded")
            client.chat_postMessage(channel=ch, thread_ts=ts, text="Thanks for flagging this — I've passed it to the team so it gets fixed.")
        except Exception as e: log.warning(f"[feedback] 👎 could not be recorded: {e}")
        return
    if not OPS_CHANNEL or ch not in (OPS_CHANNEL, OPS_TEST) or name not in ("white_check_mark", "heavy_check_mark", "x"):
        return
    try:
        msg = client.conversations_history(channel=ch, latest=ts, inclusive=True, limit=1)["messages"][0]
    except Exception as e:
        log.warning(f"[fix-review] could not read the reacted message: {e}"); return
    m = re.search(r"(?:Fix ready|Needs a decision) — (F-\d{4})", msg.get("text", ""))
    if not m or "Fix ready" not in msg.get("text", ""):
        log.info(f"[fix-review] :{name}: by {user} on a message that is not a fix post — ignored"); return
    _act_on_fix(client, ch, ts, m.group(1), user, "x" if name == "x" else "approve")


def _finding_status(fid):
    """Status of a finding in logs/findings.jsonl (one line per finding), or '' when unknown."""
    try:
        for l in open("/home/ubuntu/logs/findings.jsonl"):
            try: d = json.loads(l)
            except Exception: continue
            if d.get("id") == fid: return d.get("status", "")
    except Exception as e:
        log.warning(f"[fix-review] could not read findings.jsonl: {e}")
    return ""

def _act_on_fix(client, ch, post_ts, fid, user, action):
    """action 'approve' -> ops/deploy-fix.sh, 'x' -> throw the branch away. Replies go in the fix post's thread."""
    if user not in OPS_APPROVERS:
        client.chat_postMessage(channel=ch, thread_ts=post_ts, text="Only the people allowed to approve fixes can put one live or throw it away.")
        log.info(f"[fix-review] {fid}: {action} by {user} — not an approver"); return
    status = _finding_status(fid)
    if status in ("deployed", "resolved", "discarded", "dismissed"):
        word = {"deployed": "already live", "resolved": "already live", "discarded": "already thrown away", "dismissed": "already closed"}[status]
        client.chat_postMessage(channel=ch, thread_ts=post_ts, text=f"{fid} is {word} — nothing to do.")
        log.info(f"[fix-review] {fid}: {action} by {user} ignored — status {status}"); return
    if fid in _fix_runs:
        log.info(f"[fix-review] {fid}: {action} by {user} ignored — already running"); return
    _fix_runs.add(fid)
    log.info(f"[fix-review] {fid}: {action} by {user} — starting")
    def run():
        try:
            if action == "x":
                r = subprocess.run(["bash", "-c", f"cd /home/ubuntu && git worktree remove --force work/{fid} 2>/dev/null; git branch -D fix/{fid} && python3 -c \"import sys;sys.path.insert(0,'ops');import monitor as M;s=M.Store();[f.update(status='discarded') for f in s.items if f['id']=='{fid}'];s._save()\""], capture_output=True, text=True, timeout=60)
                out = f"🗑️ Thrown away: {fid} will not go live. Nothing changed for customers." if r.returncode == 0 else f"⚠️ I couldn't fully throw {fid} away, but nothing went live. (tech: {(r.stderr or r.stdout)[-200:]})"
            else:
                client.chat_postMessage(channel=ch, thread_ts=post_ts, text=f"Putting {fid} live: testing it once more on a practice copy first, then on the real Rachel (about 5 minutes)…")
                r = subprocess.run(["/home/ubuntu/ops/deploy-fix.sh", fid], capture_output=True, text=True, timeout=1800)
                out = (r.stdout.strip().split("\n") or ["(no output)"])[-1]
            client.chat_postMessage(channel=ch, thread_ts=post_ts, text=out)
            log.info(f"[fix-review] {fid}: {action} by {user} -> {out[:160]}")
        except Exception as e:
            log.warning(f"[fix-review] {fid} failed: {e}")
            client.chat_postMessage(channel=ch, thread_ts=post_ts, text=f"⛔ Something went wrong with {fid} and nothing changed for customers. (tech: {e})")
        finally:
            _fix_runs.discard(fid)
    threading.Thread(target=run, daemon=True).start()

# A TYPED ✅ / ❌ in #rachel-ops counts like the reaction (Oct 5: DC typed ✅ as a new channel message under the F-0016 post;
# only reactions were handled, so it was silently ignored and the fix sat unapproved). Approve = a short message that is a
# check mark or "approve / deploy / go live / ship it"; reject = ❌ or "throw it away / discard / reject". It acts on
# the F-nnnn named in it, else the fix post it replies to (thread), else the one fix still waiting for review in the channel
# (several waiting: asks which). Anything else in the channel is ignored (logged).
_APPROVE_RE = re.compile(r"^(?:(?::white_check_mark:|:heavy_check_mark:|✅|✔️?)+|approved?|deploy(?: it)?|go live|put it live|ship it)[.!]*$", re.I)
_REJECT_RE  = re.compile(r"^(?:(?::x:|❌)+|reject(?:ed)?|discard(?: it)?|throw it away)[.!]*$", re.I)

def _fix_posts(client, ch, limit=50):
    """Fix posts in the channel, newest first: [(ts, fid)]."""
    try: msgs = client.conversations_history(channel=ch, limit=limit).get("messages", [])
    except Exception as e:
        log.warning(f"[fix-review] could not read the channel: {e}"); return []
    out = []
    for msg in msgs:
        m = re.search(r"Fix ready — (F-\d{4})", msg.get("text", ""))
        if m: out.append((msg.get("ts", ""), m.group(1)))
    return out

def handle_ops_message(event, client):
    if is_bot(event): return
    ch, user, ts = event.get("channel", ""), event.get("user", ""), event.get("ts", "")
    text = re.sub(r"<@[A-Z0-9]+>", "", event.get("text", "")).strip()
    idm = re.search(r"\bF-\d{4}\b", text, re.I)
    fid = idm.group(0).upper() if idm else ""
    core = re.sub(r"\bF-\d{4}\b", "", text, flags=re.I).strip(" ,-")
    action = "approve" if _APPROVE_RE.match(core) else "x" if _REJECT_RE.match(core) else ""
    if not action:
        log.info(f"[fix-review] message in ops channel by {user} is not an approval — ignored: {text[:80]!r}"); return
    posts = _fix_posts(client, ch)
    thread = event.get("thread_ts")
    if not fid and thread:
        fid = next((f for t, f in posts if t == thread), "")
        if not fid:
            try:
                parent = client.conversations_replies(channel=ch, ts=thread, limit=1)["messages"][0].get("text", "")
                m = re.search(r"Fix ready — (F-\d{4})", parent); fid = m.group(1) if m else ""
            except Exception as e: log.warning(f"[fix-review] could not read the thread parent: {e}")
    reply_ts = thread or ts
    if not fid:
        waiting = [(t, f) for t, f in posts if _finding_status(f) == "review"]
        if len(waiting) == 1:
            fid = waiting[0][1]
        elif not waiting:
            client.chat_postMessage(channel=ch, thread_ts=reply_ts, text="There's no fix waiting for approval right now, so nothing changed.")
            log.info(f"[fix-review] {action} by {user} — no fix waiting"); return
        else:
            ids = ", ".join(f for _, f in waiting)
            client.chat_postMessage(channel=ch, thread_ts=reply_ts, text=f"Several fixes are waiting ({ids}). Which one? Reply \"✅ F-nnnn\" or react ✅ on its post.")
            log.info(f"[fix-review] {action} by {user} — ambiguous ({ids}), asked"); return
    post_ts = next((t for t, f in posts if f == fid), reply_ts)
    if post_ts != reply_ts and not thread and user in OPS_APPROVERS:
        client.chat_postMessage(channel=ch, thread_ts=ts, text=f"Got it — working on {fid}; updates are in its post's thread.")
    log.info(f"[fix-review] typed {action} by {user} -> {fid}")
    _act_on_fix(client, ch, post_ts, fid, user, action)


# ── ENTRY POINT ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("Rachel bot starting — Socket Mode + GBrain memory")
    log.info(f"GBrain: {GBRAIN_URL}")
    log.info(f"Channel: {RACHEL_CHANNEL_ID}")
    try:
        _BOT_USER_ID = app.client.auth_test()["user_id"]; log.info(f"Bot user id: {_BOT_USER_ID}")
    except Exception as e:
        log.warning(f"auth_test failed: {e}")
    handler = SocketModeHandler(app, SLACK_APP_TOKEN)
    handler.start()
