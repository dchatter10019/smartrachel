#!/usr/bin/env python3
"""Rachel Email Agent - monitors rachelai@getbevvi.com"""

import os, json, base64, time, logging, requests, subprocess
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from google.oauth2 import service_account
from googleapiclient.discovery import build

SERVICE_ACCOUNT_FILE = '/home/ubuntu/config/gmail-service-account.json'
RACHEL_EMAIL = 'rachelai@getbevvi.com'
POLL_INTERVAL = 60
THREAD_SESSIONS = {}  # thread_id -> session_id for Rachel chat continuity
# Rachel may take minutes on a big list (18 products + catalog-guard market-price lookups). Real loss
# (Sep 29): Sean's 18-item quote request timed out at 120 s, the email was marked read with no reply and
# no retry — silently dropped. Email isn't live chat: wait longer, and on failure leave it UNREAD and retry.
CHAT_TIMEOUT = int(os.environ.get('RACHEL_EMAIL_TIMEOUT', '300'))
MAX_ATTEMPTS = 3
FAILED_ATTEMPTS = {}  # gmail message id -> failed Rachel calls (retried on the next poll while < MAX_ATTEMPTS)

def _slack_alert(text):
    # QA Slack channel, same creds as catalog-guard (/etc/rachel.env). Never raises.
    try:
        env = {}
        for line in open('/etc/rachel.env'):
            if '=' in line and not line.startswith('#'):
                k, v = line.rstrip('\n').split('=', 1); env[k.strip()] = v.strip()
        tok, ch = env.get('SLACK_BOT_TOKEN'), env.get('QA_SLACK_CHANNEL')
        if not tok or not ch:
            log.error('[alert] Slack not configured — alert logged only: ' + text); return
        requests.post('https://slack.com/api/chat.postMessage', headers={'Authorization': 'Bearer ' + tok},
                      json={'channel': ch, 'text': text}, timeout=10)
    except Exception as e:
        log.error(f'[alert] Slack alert failed: {e} — {text}')
THREAD_FILE = '/home/ubuntu/logs/email-thread-sessions.json'
try:
    import json as _json
    THREAD_SESSIONS = _json.load(open(THREAD_FILE))
except Exception:
    THREAD_SESSIONS = {}
def _persist_threads():
    try:
        import json as _json
        _json.dump(THREAD_SESSIONS, open(THREAD_FILE, 'w'))
    except Exception as e:
        log.error(f'thread persist failed: {e}')

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s',
    handlers=[logging.FileHandler('/home/ubuntu/logs/email-agent.log')])
log = logging.getLogger(__name__)

SCOPES = ['https://www.googleapis.com/auth/gmail.modify']

def get_service():
    creds = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)
    return build('gmail', 'v1', credentials=creds.with_subject(RACHEL_EMAIL))

# Which inbox emails Rachel has handled — NOT the Gmail UNREAD label. Real miss (Sep 29): Sean's forwarded
# Gen II edits were opened in the rachelai@ inbox before the next poll; the agent only fetched is:unread,
# so the email was never processed and nothing was logged. Now every inbox email from the last 3 days
# that isn't in this set is processed, read or not (a read one is logged as such).
PROCESSED_FILE = '/home/ubuntu/logs/email-processed.json'
def _load_processed():
    try:
        return set(json.load(open(PROCESSED_FILE)))
    except Exception:
        return None
PROCESSED = _load_processed()
def mark_processed(msg_id):
    PROCESSED.add(msg_id)
    try:
        json.dump(sorted(PROCESSED)[-5000:], open(PROCESSED_FILE, 'w'))
    except Exception as e:
        log.error(f'processed-list persist failed: {e}')

INBOX_QUERY = 'in:inbox newer_than:3d -from:rachelai@getbevvi.com'
def get_unread(service):
    # Oldest first, anything not yet handled (the name is kept for callers; "unread" = unhandled).
    r = service.users().messages().list(userId='me', q=INBOX_QUERY, maxResults=50).execute()
    return [m for m in reversed(r.get('messages', [])) if m['id'] not in PROCESSED]

def get_email(service, msg_id):
    msg = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
    headers = {h['name'].lower(): h['value'] for h in msg['payload']['headers']}
    body = ''
    def get_body(p):
        nonlocal body
        if p.get('mimeType') == 'text/plain':
            data = p.get('body', {}).get('data', '')
            if data: body += base64.urlsafe_b64decode(data).decode('utf-8', errors='ignore')
        for part in p.get('parts', []): get_body(part)
    get_body(msg['payload'])
    return {'id': msg_id, 'thread_id': msg['threadId'], 'unread': 'UNREAD' in (msg.get('labelIds') or []),
            'from': headers.get('from', ''), 'subject': headers.get('subject', ''), 'body': body.strip(),
            'message_id': headers.get('message-id', ''), 'references': headers.get('references', ''),
            'to': headers.get('to', ''), 'cc': headers.get('cc', '')}

def reply_all_cc(email, sender_email):
    # Reply-all (DC, Sep 29): everyone on the email's To and Cc gets Rachel's reply, except Rachel and the
    # sender (who is the To). Addresses parsed properly ("Name, Jr." <a@b>, lists), lowercased, deduped.
    from email.utils import getaddresses
    seen, out = {RACHEL_EMAIL.lower(), (sender_email or '').lower()}, []
    for _name, addr in getaddresses([email.get('to', ''), email.get('cc', '')]):
        a = (addr or '').strip().lower()
        if '@' in a and a not in seen:
            seen.add(a); out.append(a)
    return out

def chat_with_rachel(message, session_id, sender_email, sender_name='', subject='', request_id=''):
    try:
        r = requests.post('http://127.0.0.1:3500/chat', json={
            'message': message,
            'session_id': session_id,
            'format': 'plain',
            'context': {
                'kitchen_location': '',
                'client_id': 'fooda',
                'account_id': '',
                'user_email': sender_email,
                'user_name': sender_name,      # From display name: the quote PDF's client fallback
                'email_subject': subject,      # "... - Gen II Fund" names the client; "quote"/"proposal" asks for the PDF
                'age_verified': True
            },
            'request_id': request_id           # the Gmail message id: a retry gets the SAME reply, never a second run
        }, timeout=CHAT_TIMEOUT)
        return r.json().get('text', '') or None   # an empty reply is a failure, never sent
    except Exception as e:
        log.error(f'Rachel chat error: {e}')
        return None

def proposal_pdf(reply):
    # A Rachel proposal link in the reply -> the PDF on disk, attached to the email (the file generate_proposal wrote).
    import re
    m = re.search(r'/proposals/(bevvi-proposal[\w.-]*\.pdf)', reply or '')
    p = os.path.join('/home/ubuntu/logs', m.group(1)) if m else None
    return p if p and os.path.exists(p) else None

def send_reply(service, thread_id, to, subject, body, pdf_path=None, in_reply_to=None, references=None, cc=None):
    msg = MIMEMultipart()
    msg['To'] = to
    if cc:
        msg['Cc'] = ', '.join(cc)
    # Threading headers so the CUSTOMER's client (Outlook, Apple Mail, Gmail) groups the
    # reply with their email and their next reply comes back into the same thread/session.
    if in_reply_to:
        msg['In-Reply-To'] = in_reply_to
        msg['References'] = ((references or '') + ' ' + in_reply_to).strip()
    msg['Subject'] = subject if subject.startswith('Re:') else f'Re: {subject}'
    msg.attach(MIMEText(body, 'plain'))
    if pdf_path and os.path.exists(pdf_path):
        with open(pdf_path, 'rb') as f:
            part = MIMEBase('application', 'octet-stream')
            part.set_payload(f.read())
        encoders.encode_base64(part)
        part.add_header('Content-Disposition', f'attachment; filename="bevvi-proposal.pdf"')
        msg.attach(part)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service.users().messages().send(userId='me', body={'raw': raw, 'threadId': thread_id}).execute()
    log.info(f'Reply sent to {to}' + (f' (cc: {", ".join(cc)})' if cc else ''))

def save_to_gbrain(sender_email, thread_id):
    subprocess.Popen(['node', '-e',
        f"const {{getD2CSession,saveD2CSession}}=require('/home/ubuntu/rachel/gbrain.js');"
        f"getD2CSession('{sender_email}').then(s=>{{"
        f"const merged=Object.assign({{email:'{sender_email}',onboarded:true,age_verified:true}},s,"
        f"{{last_channel:'email',last_thread_id:'{thread_id}',last_seen:new Date().toISOString()}});"
        f"saveD2CSession('{sender_email}',merged).then(()=>console.log('GBrain saved'));"
        f"}});"],
        cwd='/home/ubuntu/rachel')

def _failed(service, email, sender_email, where):
    # Rachel gave no reply: leave the email UNREAD so the next poll retries it; after MAX_ATTEMPTS, alert
    # QA Slack and tell the customer a person will follow up (never a silent drop).
    n = FAILED_ATTEMPTS.get(email['id'], 0) + 1
    FAILED_ATTEMPTS[email['id']] = n
    if n < MAX_ATTEMPTS:
        log.error(f"NO REPLY from Rachel ({where}) for {sender_email} | {email['subject']} — attempt {n}/{MAX_ATTEMPTS}, left unread for retry")
        return
    log.error(f"NO REPLY from Rachel after {n} attempts for {sender_email} | {email['subject']} — alerting QA Slack, holding reply sent")
    _slack_alert(f":rotating_light: Rachel email: no reply after {n} attempts to {sender_email} — \"{email['subject']}\". Needs a person.")
    try:
        send_reply(service, email['thread_id'], sender_email, email['subject'],
                   "Thanks for your email — I'm putting this together and a member of the Bevvi team will follow up with you shortly.",
                   in_reply_to=email.get('message_id'), references=email.get('references'), cc=reply_all_cc(email, sender_email))
    except Exception as e:
        log.error(f'holding reply failed: {e}')
    service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
    FAILED_ATTEMPTS.pop(email['id'], None)
    mark_processed(email['id'])

def linked_session(sender_email, subject, body):
    # A NEW thread that continues an earlier quote (a forward, a fresh email about "the proposal"): Rachel's
    # server decides from its sessions (email-link.js) and logs why. None = start a new session.
    try:
        r = requests.post('http://127.0.0.1:3500/internal/email-link', json={'sender_email': sender_email, 'subject': subject, 'body': body}, timeout=10).json()
        log.info(f"[email-link] {subject[:60]!r} -> {r.get('session_id') or 'new session'} — {r.get('reason')}")
        return r.get('session_id')
    except Exception as e:
        log.error(f'[email-link] lookup failed ({e}) — starting a new session')
        return None

def process(service, email):
    log.info(f"Processing: {email['from']} | {email['subject']}" + ('' if email.get('unread', True) else ' (already marked read in Gmail — picked up anyway)'))
    sender = email['from']
    sender_email = sender.split('<')[1].strip('>') if '<' in sender else sender.strip()
    sender_name = sender.split('<')[0].strip().strip('"') if '<' in sender else ''

    skip_senders = ['noreply', 'no-reply', 'mailer-daemon', 'postmaster', 'mail-noreply']
    if any(s in sender_email.lower() for s in skip_senders):
        log.info(f'Skipping automated email from {sender_email}')
        service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
        mark_processed(email['id'])
        return

    thread_id = email['thread_id']

    # Check if this is a continuation of an existing thread
    if thread_id in THREAD_SESSIONS:
        session_id = THREAD_SESSIONS[thread_id]
        rachel_response = chat_with_rachel(email['body'], session_id, sender_email, sender_name, email['subject'], email['id'])
        if not rachel_response:
            return _failed(service, email, sender_email, 'continuation')
        send_reply(service, thread_id, sender_email, email['subject'], rachel_response, pdf_path=proposal_pdf(rachel_response), in_reply_to=email.get('message_id'), references=email.get('references'), cc=reply_all_cc(email, sender_email))
        log.info(f'Continuation reply sent for thread {thread_id[:8]}...')
        service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
        FAILED_ATTEMPTS.pop(email['id'], None)
        mark_processed(email['id'])
        return

    # New thread: every email goes through Rachel's chat, like every other channel. Her
    # state machine handles the age gate (keeping the order text to replay after "yes"),
    # the address, named products and event requests. The old email-only parser asked
    # customers for "guests, budget, event_type" when they had simply named products.
    # A retry uses the same session and request_id: the server returns the first run's reply (it may have
    # finished after our timeout) instead of running the email again.
    session_id = linked_session(sender_email, email['subject'], email['body']) or f'email-{thread_id[:16]}-{sender_email.split("@")[0]}'
    rachel_response = chat_with_rachel(email['body'], session_id, sender_email, sender_name, email['subject'], email['id'])
    if not rachel_response:
        return _failed(service, email, sender_email, 'new thread')   # thread not mapped: the retry gets the same reply (request_id)
    send_reply(service, thread_id, sender_email, email['subject'], rachel_response, pdf_path=proposal_pdf(rachel_response), in_reply_to=email.get('message_id'), references=email.get('references'), cc=reply_all_cc(email, sender_email))
    log.info('Initial reply sent via Rachel chat')
    save_to_gbrain(sender_email, thread_id)
    FAILED_ATTEMPTS.pop(email['id'], None)

    # Save session for this thread
    THREAD_SESSIONS[thread_id] = session_id; _persist_threads()
    log.info(f'Thread {thread_id[:8]}... -> session {session_id}')

    service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
    mark_processed(email['id'])

def main():
    log.info('=== Rachel Email Agent Starting ===')
    log.info(f'Monitoring: {RACHEL_EMAIL}')
    service = get_service()
    log.info('Gmail connected')
    global PROCESSED
    if PROCESSED is None:
        # First run with the processed list: inbox mail already READ counts as handled (under the old unread-only
        # rule it was, or it was answered by hand); unread mail is still processed, as before.
        r = service.users().messages().list(userId='me', q=INBOX_QUERY + ' -is:unread', maxResults=500).execute()
        PROCESSED = set()
        for m in r.get('messages', []):
            PROCESSED.add(m['id'])
        json.dump(sorted(PROCESSED), open(PROCESSED_FILE, 'w'))
        log.info(f'[processed] first run: {len(PROCESSED)} already-read inbox email(s) recorded as handled')
    while True:
        try:
            emails = get_unread(service)
            if emails:
                log.info(f'{len(emails)} new email(s)')
                for ref in emails:
                    process(service, get_email(service, ref['id']))
        except Exception as e:
            log.error(f'Error: {e}')
        time.sleep(POLL_INTERVAL)

if __name__ == '__main__':
    main()
