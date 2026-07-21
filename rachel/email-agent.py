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
ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
POLL_INTERVAL = 60
THREAD_SESSIONS = {}  # thread_id -> session_id for Rachel chat continuity

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
            'from': headers.get('from', ''), 'subject': headers.get('subject', ''), 'body': body.strip()}

def parse_with_claude(from_email, subject, body):
    prompt = f"""Extract beverage order info from this email. Return ONLY JSON with these fields:
{{
  "confidence": "high|low",
  "guests": <number or null>,
  "budget": <number or null>,
  "event_date": "<string or null>",
  "event_type": "<string or null>",
  "client_name": "<string or null>",
  "missing_fields": ["field1", ...]
}}

From: {from_email}
Subject: {subject}
Body: {body[:2000]}"""
    r = requests.post('https://api.anthropic.com/v1/messages',
        headers={'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        json={'model':'claude-haiku-4-5-20251001','max_tokens':500,'messages':[{'role':'user','content':prompt}]})
    text = r.json()['content'][0]['text'].strip()
    if text.startswith('```'): text = text.split('```')[1].lstrip('json').strip()
    return json.loads(text)

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

def build_package(order, sender_email):
    """Call ShoppingAgent MCP directly to build a beverage package"""
    try:
        payload = {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "menu_build",
                "arguments": {
                    "zip": "10010",
                    "email": sender_email,
                    "guests": order.get('guests', 20),
                    "hours": order.get('hours', 3),
                    "budget": order.get('budget', 1000),
                    "categories": order.get('categories', ['wine', 'beer', 'spirits']),
                    "intent": "menu_build"
                }
            },
            "id": 1
        }
        r = requests.post('http://127.0.0.1:8300/mcp', json=payload, timeout=120)
        text = r.text.strip()
        if text.startswith('data: '): text = text[6:]
        result = json.loads(text).get('result', {})
        content = result.get('content', [{}])
        if isinstance(content, list) and len(content) > 0:
            data = json.loads(content[0].get('text', '{}'))
            return data
        return None
    except Exception as e:
        log.error(f'ShoppingAgent error: {e}')
        return None

def gen_pdf(package, client_name, event_date):
    try:
        r = requests.post('http://127.0.0.1:8300/generate-pdf', json={
            'package': package,
            'client_name': client_name,
            'event_date': event_date
        }, timeout=60)
        if r.status_code == 200:
            path = f'/tmp/proposal-{int(time.time())}.pdf'
            with open(path, 'wb') as f: f.write(r.content)
            return path
    except Exception as e:
        log.error(f'PDF gen error: {e}')
    return None

def format_package(package, order):
    if not package or not package.get('success'):
        return "Thank you for your inquiry. Please contact orders@getbevvi.com for assistance."
    try:
        items = json.loads(package['line_items']) if isinstance(package.get('line_items'), str) else package.get('line_items', [])
        lines = []
        lines.append(f"Hi {order.get('client_name', 'there')},")
        lines.append(f"\nThank you for reaching out to Bevvi! Here is your beverage proposal for {order.get('guests', '?')} guests.\n")
        
        # Group by category
        by_cat = {}
        for item in items:
            cat = item.get('label', item.get('category', 'Other'))
            by_cat.setdefault(cat, []).append(item)
        
        for cat, cat_items in by_cat.items():
            lines.append(f"--- {cat.upper()} ---")
            for item in cat_items:
                subtotal = round(item['qty'] * item['price'], 2)
                lines.append(f"  {item['qty']}x {item['name']} ({item['size']}) — ${item['price']} ea = ${subtotal}")
            lines.append("")
        
        lines.append(f"Product Total:     ${package.get('product_total', '?')}")
        lines.append(f"Estimated Tax:     ${package.get('estimated_tax', '?')}")
        lines.append(f"Service Fee:       ${package.get('estimated_service', '?')}")
        lines.append(f"Delivery:          ${package.get('delivery_fee', '?')}")
        lines.append(f"GRAND TOTAL:       ${package.get('estimated_grand_total', '?')}")
        lines.append(f"\nTotal drinks: ~{package.get('total_drinks', '?')}")
        lines.append("\nReply to this email to place your order or request any changes.")
        lines.append("\nCheers,\nRachel\nBevvi Beverage Specialist")
        return "\n".join(lines)
    except Exception as e:
        log.error(f"format_package error: {e}")
        return "Thank you for your inquiry. Please contact orders@getbevvi.com for assistance."

def format_clarification(order, missing):
    fields = ', '.join(missing)
    return f"Thank you for reaching out to Bevvi! To prepare your beverage proposal, I need a few more details: {fields}. Please reply with this information and I'll get your proposal ready right away."

def send_reply(service, thread_id, to, subject, body, pdf_path=None):
    msg = MIMEMultipart()
    msg['To'] = to
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
            send_reply(service, thread_id, sender_email, email['subject'], rachel_response)
            log.info(f'Continuation reply sent for thread {thread_id[:8]}...')
        service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
        return

    # New thread — parse and build proposal
    session_id = f'email-{thread_id[:16]}-{sender_email.split("@")[0]}'
    order = parse_with_claude(email['from'], email['subject'], email['body'])
    order['sender_email'] = sender_email
    log.info(f"Parsed: confidence={order.get('confidence')}, guests={order.get('guests')}, budget={order.get('budget')}")

    rachel_response = chat_with_rachel(email['body'], session_id, sender_email)

    if order.get('confidence') == 'low':
        body = format_clarification(order, order.get('missing_fields', ['event details']))
        send_reply(service, thread_id, sender_email, email['subject'], body)
    else:
        package = build_package(order, sender_email)
        pdf_path = None
        if package:
            pdf_path = gen_pdf(package,
                order.get('client_name', sender_email.split('@')[0]),
                order.get('event_date', ''))

        email_body = format_package(package, order) if package else rachel_response
        if pdf_path:
            email_body += '\n\nA PDF proposal is attached.'

        send_reply(service, thread_id, sender_email, email['subject'], email_body, pdf_path)
        log.info(f"Initial proposal sent: ${package.get('estimated_grand_total') if package else 'N/A'}")

        # Save to GBrain for cross-channel continuity
        save_to_gbrain(sender_email, thread_id)

    # Save session for this thread
    THREAD_SESSIONS[thread_id] = session_id
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
