#!/usr/bin/env python3
"""Rachel Email Agent - monitors rachelai@getbevvi.com"""

import os, json, base64, time, logging, requests, subprocess
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from google.oauth2 import service_account
from googleapiclient.discovery import build
import logging as _logging
_logging.getLogger('googleapiclient.discovery_cache').setLevel(_logging.ERROR)

SERVICE_ACCOUNT_FILE = '/home/ubuntu/config/gmail-service-account.json'
RACHEL_EMAIL = 'rachelai@getbevvi.com'
ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
SHOPPING_AGENT_URL = 'http://127.0.0.1:8300/mcp'
POLL_INTERVAL = 60
THREAD_SESSIONS = {}  # thread_id -> session_id for Rachel chat continuity
LOG_FILE = '/home/ubuntu/logs/email-agent.log'

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s',
    handlers=[logging.FileHandler(LOG_FILE)])
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
    r = requests.post('https://api.anthropic.com/v1/messages',
        headers={'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        json={'model':'claude-haiku-4-5-20251001','max_tokens':1000,'messages':[{'role':'user','content':f"""Extract beverage order info from this email. Return ONLY JSON.

From: {from_email}
Subject: {subject}
Body: {body}

JSON fields: guests(int), hours(float), budget(float), categories(list), named_products(list of {{name,qty}}), event_date(str), client_name(str), delivery_address(str), confidence("high"/"low"), missing_fields(list if low)

confidence=high only if guests+budget+categories all present."""}]})
    text = r.json()['content'][0]['text']
    try: return json.loads(text.strip().replace('```json','').replace('```',''))
    except: return {'confidence':'low','missing_fields':['Could not parse request']}

def build_package(order, sender_email):
    intent = 'custom_list' if order.get('named_products') else 'menu_build'
    args = {'zip':'10010','email':sender_email,'guests':order.get('guests',20),
            'hours':order.get('hours',3),'budget':order.get('budget',1000)}
    if intent == 'menu_build': args['categories'] = order.get('categories',['wine','beer','spirits'])
    else: args['named_products'] = order.get('named_products',[])
    r = requests.post(SHOPPING_AGENT_URL, json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':intent,'arguments':args}})
    line = next((l for l in r.text.split('\n') if l.startswith('data:')), None)
    if not line: return None
    result = json.loads(json.loads(line.replace('data:','').strip())['result']['content'][0]['text'])
    return result if result.get('success') else None

def gen_pdf(package, client_name, event_date):
    ts = int(time.time())
    out = f'/home/ubuntu/logs/bevvi-proposal-email-{ts}.pdf'
    data = json.dumps({'client_name':client_name or 'Valued Client','event_date':event_date or '','line_items':package.get('line_items','[]'),'notes':''})
    r = subprocess.run(['node','/home/ubuntu/rachel/generate-proposal.js',data,out],cwd='/home/ubuntu/rachel',capture_output=True,text=True,timeout=30)
    return out if r.returncode == 0 and os.path.exists(out) else None

def send_reply(service, thread_id, to_email, subject, body, attachment=None):
    msg = MIMEMultipart()
    msg['to'] = to_email
    msg['from'] = RACHEL_EMAIL
    msg['subject'] = f"Re: {subject}" if not subject.startswith('Re:') else subject
    msg.attach(MIMEText(body, 'plain'))
    if attachment and os.path.exists(attachment):
        with open(attachment,'rb') as f:
            part = MIMEBase('application','octet-stream')
            part.set_payload(f.read())
        encoders.encode_base64(part)
        part.add_header('Content-Disposition',f'attachment; filename="{os.path.basename(attachment)}"')
        msg.attach(part)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service.users().messages().send(userId='me',body={'raw':raw,'threadId':thread_id}).execute()
    log.info(f'Reply sent to {to_email}')

def format_package(package, order):
    items = json.loads(package.get('line_items','[]'))
    cats = {}
    for item in items:
        cat = item.get('category','Other')
        cats.setdefault(cat,[]).append(item)
    lines = [f"Dear {order.get('client_name','Valued Client')},\n",
             "Thank you for reaching out to Bevvi! Here's your beverage package:\n",
             "="*50]
    for cat, citems in cats.items():
        lines.append(f"\n{cat.upper()}")
        for i in citems: lines.append(f"  - {i['qty']}x {i['name']} — ${i['price']:.2f}")
    lines.extend(["","="*50,
        f"Product Total: ${package.get('product_total','0')}",
        f"Estimated Grand Total: ${package.get('estimated_grand_total','0')}",
        "\nA PDF proposal is attached.",
        "\nReply CONFIRM to place this order, or let me know any changes needed.",
        "\nBest regards,\nRachel\nBevvi AI Beverage Specialist\nrachelai@getbevvi.com"])
    return '\n'.join(lines)

def format_clarification(order, missing):
    questions = {'guests':'- How many guests?','hours':'- How many hours is the event?',
        'budget':'- What is your total budget?','categories':'- What beverages? (wine, beer, spirits, champagne)',
        'delivery_address':'- What is the delivery address?','event_date':'- What is the event date?'}
    lines = [f"Dear {order.get('client_name','there')},\n",
             "Thank you for contacting Bevvi! To build your package I need a few more details:\n"]
    for f in missing: lines.append(questions.get(f,f'- {f}'))
    lines.extend(["\nI'll send a full proposal right away once I have these details!",
        "\nBest regards,\nRachel\nBevvi AI Beverage Specialist\nrachelai@getbevvi.com"])
    return '\n'.join(lines)

def chat_with_rachel(message, session_id, sender_email, zip_code='10010'):
    """Send message to Rachel chat endpoint"""
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
        }, timeout=60)
        return r.json().get('text', '')
    except Exception as e:
        log.error(f'Rachel chat error: {e}')
        return None

def extract_pdf_from_response(rachel_response):
    """Check if Rachel's response contains a proposal PDF link"""
    import re
    # Look for proposal URL in response
    match = re.search(r'http://[^\s]+proposals/[^\s]+\.pdf', rachel_response)
    return match.group(0) if match else None

def download_pdf(url):
    """Download PDF from Rachel's proposal server"""
    try:
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            import tempfile
            tmp = tempfile.mktemp(suffix='.pdf')
            with open(tmp, 'wb') as f:
                f.write(r.content)
            return tmp
    except Exception as e:
        log.error(f'PDF download error: {e}')
    return None

def process(service, email):
    log.info(f"Processing: {email['from']} | {email['subject']}")
    sender = email['from']
    sender_email = sender.split('<')[1].strip('>') if '<' in sender else sender.strip()
    
    # Skip automated/noreply senders
    skip_senders = ['noreply', 'no-reply', 'mailer-daemon', 'postmaster', 'mail-noreply']
    if any(s in sender_email.lower() for s in skip_senders):
        log.info(f'Skipping automated email from {sender_email}')
        service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
        return

    thread_id = email['thread_id']
    subject = email['subject']
    body = email['body']
    
    # Check if this is a reply to existing thread (modification request)
    is_reply = thread_id in THREAD_SESSIONS
    
    if is_reply:
        # Route through Rachel chat for conversational handling
        session_id = THREAD_SESSIONS[thread_id]
        log.info(f'Reply in thread {thread_id[:8]}... routing to Rachel chat session {session_id}')
        
        rachel_response = chat_with_rachel(body, session_id, sender_email)
        if not rachel_response:
            send_reply(service, thread_id, sender_email, subject,
                "I apologize, I had trouble processing your request. Please try again.")
            service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
            return
        
        log.info(f'Rachel response: {rachel_response[:100]}...')
        
        # Check if Rachel generated a new proposal PDF
        pdf_url = extract_pdf_from_response(rachel_response)
        pdf_path = download_pdf(pdf_url) if pdf_url else None
        
        # Clean up response for email (remove URLs)
        import re
        clean_response = re.sub(r'http://\S+proposals/\S+\.pdf', '', rachel_response).strip()
        
        if pdf_path:
            clean_response += '\n\nAn updated PDF proposal is attached.'
        
        send_reply(service, thread_id, sender_email, subject, clean_response, pdf_path)
        
    else:
        # New email — parse and build initial package
        order = parse_with_claude(email['from'], subject, body)
        order['sender_email'] = sender_email
        log.info(f"Parsed: confidence={order.get('confidence')}, guests={order.get('guests')}, budget={order.get('budget')}")
        
        # Create Rachel session for this thread
        session_id = f'email-{thread_id[:12]}-{sender_email.split("@")[0]}'
        
        if order.get('confidence') == 'low':
            # Send clarification via Rachel chat
            initial_msg = f"I received an email from {sender_email} about: {subject}. Body: {body[:500]}"
            rachel_response = chat_with_rachel(initial_msg, session_id, sender_email)
            
            if rachel_response:
                send_reply(service, thread_id, sender_email, subject, rachel_response)
            else:
                clarification = format_clarification(order, order.get('missing_fields',['event details']))
                send_reply(service, thread_id, sender_email, subject, clarification)
        else:
            # Build package via Rachel chat for full conversational context
            order_msg = (
                f"I need a beverage package for {order.get('guests',0)} people, "
                f"{order.get('hours',3)} hours, ${order.get('budget',1000)} budget, "
                f"categories: {', '.join(order.get('categories',[]) or ['wine','beer','spirits'])}. "
                f"Delivery to {order.get('delivery_address','11 Madison Ave New York NY 10010')}. "
                f"Client: {order.get('client_name','')}"
            )
            
            rachel_response = chat_with_rachel(order_msg, session_id, sender_email)
            
            if not rachel_response:
                send_reply(service, thread_id, sender_email, subject,
                    "I apologize, I couldn't process your order. Please contact orders@getbevvi.com.")
                service.users().messages().modify(userId='me',id=email['id'],body={'removeLabelIds':['UNREAD']}).execute()
                return
            
            # Generate PDF proposal
            package = build_package(order, sender_email)
            pdf_path = None
            if package:
                pdf_path = gen_pdf(package,
                    order.get('client_name', sender_email.split('@')[0]),
                    order.get('event_date',''))
            
            email_body = format_package(package, order) if package else rachel_response
            if pdf_path:
                email_body += '\n\nA PDF proposal is attached.'
            
            send_reply(service, thread_id, sender_email, subject, email_body, pdf_path)
            log.info(f"Initial proposal sent: ${package.get('estimated_grand_total') if package else 'N/A'}")
        
        # Save session for this thread
        THREAD_SESSIONS[thread_id] = session_id
        log.info(f'Thread {thread_id[:8]}... → session {session_id}')
    
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
