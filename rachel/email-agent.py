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

def get_unread(service):
    r = service.users().messages().list(userId='me', q='is:unread -from:rachelai@getbevvi.com', maxResults=10).execute()
    return r.get('messages', [])

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
    return {'id': msg_id, 'thread_id': msg['threadId'],
            'from': headers.get('from', ''), 'subject': headers.get('subject', ''), 'body': body.strip(),
            'message_id': headers.get('message-id', ''), 'references': headers.get('references', '')}

def chat_with_rachel(message, session_id, sender_email):
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
                'age_verified': True
            }
        }, timeout=120)
        return r.json().get('text', '')
    except Exception as e:
        log.error(f'Rachel chat error: {e}')
        return None

def send_reply(service, thread_id, to, subject, body, pdf_path=None, in_reply_to=None, references=None):
    msg = MIMEMultipart()
    msg['To'] = to
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
    log.info(f'Reply sent to {to}')

def save_to_gbrain(sender_email, thread_id):
    subprocess.Popen(['node', '-e',
        f"const {{getD2CSession,saveD2CSession}}=require('/home/ubuntu/rachel/gbrain.js');"
        f"getD2CSession('{sender_email}').then(s=>{{"
        f"const merged=Object.assign({{email:'{sender_email}',onboarded:true,age_verified:true}},s,"
        f"{{last_channel:'email',last_thread_id:'{thread_id}',last_seen:new Date().toISOString()}});"
        f"saveD2CSession('{sender_email}',merged).then(()=>console.log('GBrain saved'));"
        f"}});"],
        cwd='/home/ubuntu/rachel')

def process(service, email):
    log.info(f"Processing: {email['from']} | {email['subject']}")
    sender = email['from']
    sender_email = sender.split('<')[1].strip('>') if '<' in sender else sender.strip()

    skip_senders = ['noreply', 'no-reply', 'mailer-daemon', 'postmaster', 'mail-noreply']
    if any(s in sender_email.lower() for s in skip_senders):
        log.info(f'Skipping automated email from {sender_email}')
        service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
        return

    thread_id = email['thread_id']

    # Check if this is a continuation of an existing thread
    if thread_id in THREAD_SESSIONS:
        session_id = THREAD_SESSIONS[thread_id]
        rachel_response = chat_with_rachel(email['body'], session_id, sender_email)
        if rachel_response:
            send_reply(service, thread_id, sender_email, email['subject'], rachel_response, in_reply_to=email.get('message_id'), references=email.get('references'))
            log.info(f'Continuation reply sent for thread {thread_id[:8]}...')
        service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
        return

    # New thread: every email goes through Rachel's chat, like every other channel. Her
    # state machine handles the age gate (keeping the order text to replay after "yes"),
    # the address, named products and event requests. The old email-only parser asked
    # customers for "guests, budget, event_type" when they had simply named products.
    session_id = f'email-{thread_id[:16]}-{sender_email.split("@")[0]}'
    rachel_response = chat_with_rachel(email['body'], session_id, sender_email)
    if rachel_response:
        send_reply(service, thread_id, sender_email, email['subject'], rachel_response, in_reply_to=email.get('message_id'), references=email.get('references'))
        log.info('Initial reply sent via Rachel chat')
        save_to_gbrain(sender_email, thread_id)

    # Save session for this thread
    THREAD_SESSIONS[thread_id] = session_id; _persist_threads()
    log.info(f'Thread {thread_id[:8]}... -> session {session_id}')

    service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()

def main():
    log.info('=== Rachel Email Agent Starting ===')
    log.info(f'Monitoring: {RACHEL_EMAIL}')
    service = get_service()
    log.info('Gmail connected')
    while True:
        try:
            emails = get_unread(service)
            if emails:
                log.info(f'{len(emails)} unread email(s)')
                for ref in emails:
                    process(service, get_email(service, ref['id']))
        except Exception as e:
            log.error(f'Error: {e}')
        time.sleep(POLL_INTERVAL)

if __name__ == '__main__':
    main()
