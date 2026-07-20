#!/usr/bin/env python3
"""
Rachel Slack Bot — No @mention required, with GBrain memory
Responds to all messages in #rachel_ai and all DMs
GBrain lookup: email first, then display name, then Slack user ID
"""

import os
import json
import logging
import threading
import httpx
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
import anthropic

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rachel")

# ── CONFIG ────────────────────────────────────────────────────────────────────
SLACK_BOT_TOKEN   = os.environ["SLACK_BOT_TOKEN"]

# Dedup set for Slack retries
_processed_events = set()
SLACK_APP_TOKEN   = os.environ["SLACK_APP_TOKEN"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
RACHEL_CHANNEL_ID = os.environ["RACHEL_CHANNEL_ID"]
ALLOWED_USERS     = set(os.environ.get("ALLOWED_USERS", "").split(","))

# ── GBRAIN ────────────────────────────────────────────────────────────────────
GBRAIN_URL   = "http://127.0.0.1:7700/mcp"
GBRAIN_TOKEN = "gbrain_71d7392edf8a722d8816739407f1455d13fff00a0c7b12e3afa208b4d081ebf4"
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

# ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
RACHEL_SYSTEM_PROMPT = """
You are Rachel, Bevvi's personal beverage specialist and concierge.
You are warm, knowledgeable, a little funny, and deeply expert in wine, beer, and spirits.

You remember customer preferences and past occasions. If customer history is provided
below, use it naturally without announcing you are reading from a file — just know it
the way a good friend would.

You help build drink orders for events — boating trips, private dinners, home bar
restocks, corporate gifts. You ask about the occasion, guest count, and budget before
recommending anything. You never recommend a product without confirming it is available.
When a basket is ready, you run bids across stores and present the best price.
Always address the user by their first name or nickname once you know it.
Keep responses concise — this is Slack, not an essay.
"""

# ── ANTHROPIC CLIENT ──────────────────────────────────────────────────────────
claude = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# ── CONVERSATION + GBRAIN STORE ───────────────────────────────────────────────
conversation_store: dict[str, list[dict]] = {}
gbrain_cache: dict[str, str] = {}
store_lock = threading.Lock()

def get_history(user_id: str) -> list[dict]:
    with store_lock:
        return conversation_store.get(user_id, [])

def append_history(user_id: str, role: str, content: str):
    with store_lock:
        if user_id not in conversation_store:
            conversation_store[user_id] = []
        conversation_store[user_id].append({"role": role, "content": content})
        conversation_store[user_id] = conversation_store[user_id][-40:]

def clear_history(user_id: str):
    with store_lock:
        conversation_store[user_id] = []
        gbrain_cache.pop(user_id, None)

# ── RACHEL RESPONSE ───────────────────────────────────────────────────────────
def ask_rachel(user_id: str, text: str, customer_context: str = "", user_email: str = "", is_new_session: bool = False) -> str:
    try:
        payload = {
            "message": text,
            "session_id": f"slack-{user_id}",
            "format": "slack",
            "context": {
                "kitchen_location": "",
                "client_id": "airculinaire",
                "user_email": user_email,
                "account_id": ""
            }
        }
        r = httpx.post("http://127.0.0.1:3500/chat", json=payload, timeout=60)
        data = r.json()
        reply = data.get("text", "Sorry, I hit a snag — try again in a second.")
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
    return bool(event.get("bot_id") or event.get("subtype") == "bot_message")

def handle(event: dict, say, client):
    if is_bot(event):
        return

    user_id  = event.get("user", "")
    text     = event.get("text", "").strip()
    channel  = event.get("channel", "")

    if not text or not user_id:
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

    if not text:
        return

    # Special commands
    if text.lower() in ("reset", "start over", "clear"):
        clear_history(user_id)
        say("How can I help with your beverage needs today?")
        return

    log.info(f"[{user_id}] {text[:80]}")

    # Load GBrain context once per session (cached per user)
    if user_id not in gbrain_cache:
        gbrain_cache[user_id] = get_customer_context(client, user_id)

    # Show typing indicator
    try:
        client.chat_postEphemeral(
            channel=channel, user=user_id,
            text="Rachel is thinking... 🍷"
        )
    except Exception:
        pass

    # Get email for Rachel context
    user_email = ""
    try:
        profile = client.users_info(user=user_id)["user"]["profile"]
        user_email = profile.get("email", "")
    except Exception:
        pass
    # On first message of a new session, let Rachel know
    history = get_history(user_id)
    is_new_session = len(history) == 0
    
    reply = ask_rachel(user_id, text, gbrain_cache[user_id], user_email, is_new_session)
    say(reply)

# ── EVENT LISTENERS ───────────────────────────────────────────────────────────

@app.event("message")
def handle_message(event, say, client, ack=None):
    if ack:
        ack()
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


# ── ENTRY POINT ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("Rachel bot starting — Socket Mode + GBrain memory")
    log.info(f"GBrain: {GBRAIN_URL}")
    log.info(f"Channel: {RACHEL_CHANNEL_ID}")
    handler = SocketModeHandler(app, SLACK_APP_TOKEN)
    handler.start()
