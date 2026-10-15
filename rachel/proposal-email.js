// Emailing a proposal PDF from the connector (rachel_generate_proposal send_to / cc; DC, Oct 15, for Voiceflow).
// The tool runs without the age check when the caller sends the drinks, so who it may email is limited in code:
// an address must be the caller's own email, in the caller's domain (never for consumer mail — gmail.com is not
// "one company"), or @getbevvi.com. Others are dropped and reported (rejected + email_error), the rest still get it.
// Bevvi keeps a copy of every proposal sent (bcc). QA identities never send (rule 5): the caller is QA, or every
// address it would go to is QA.

const BEVVI_DOMAIN = 'getbevvi.com';
const BCC = (process.env.PROPOSAL_BCC || 'bevvi-support@getbevvi.com').split(',').map(s => s.trim()).filter(Boolean);   // proposals@ does not exist (checked Oct 15)
const MAX_RECIPIENTS = 10;
const QA_RE = /^(qa-[^@]*|rachel_qa)@getbevvi\.com$/i;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
  'qq.com', '163.com', 'tutanota.com']);
const domainOf = e => String(e).split('@')[1] || '';
const isFreeMail = d => FREE_MAIL.has(d) || /^(yahoo|hotmail|outlook|live)\.[a-z.]+$/.test(d);

// "a@x.com, b@x.com" / ["a@x.com"] / "Name <a@x.com>" -> ['a@x.com', ...] (lower-cased)
function addressList(v) {
  const parts = Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/);
  return parts.map(p => { const s = String(p || '').trim(), m = s.match(/<([^>]+)>/); return (m ? m[1] : s).trim().toLowerCase(); }).filter(Boolean);
}

// -> { to, cc, rejected: [{address, why}] }
function allowedRecipients(callerEmail, sendTo, cc) {
  const caller = String(callerEmail || '').trim().toLowerCase();
  const callerDomain = domainOf(caller);
  const seen = new Set(), rejected = [], out = { to: [], cc: [] };
  const check = a => {
    if (!EMAIL_RE.test(a)) return 'not an email address';
    const d = domainOf(a);
    if (a === caller || d === BEVVI_DOMAIN) return null;
    if (callerDomain && d === callerDomain && !isFreeMail(callerDomain)) return null;
    return isFreeMail(callerDomain) || !callerDomain ? 'not the caller\'s own address or @' + BEVVI_DOMAIN
      : 'not in the caller\'s domain (' + callerDomain + ') or @' + BEVVI_DOMAIN;
  };
  for (const [list, key] of [[addressList(sendTo), 'to'], [addressList(cc), 'cc']]) {
    for (const a of list) {
      if (seen.has(a)) continue; seen.add(a);
      const why = check(a);
      if (why) { rejected.push({ address: a, why }); continue; }
      if (out.to.length + out.cc.length >= MAX_RECIPIENTS) { rejected.push({ address: a, why: 'more than ' + MAX_RECIPIENTS + ' recipients' }); continue; }
      out[key].push(a);
    }
  }
  if (!out.to.length && out.cc.length) out.to.push(out.cc.shift());   // an email needs a To
  return Object.assign(out, { rejected });
}

const isQA = (callerEmail, to, cc) => QA_RE.test(String(callerEmail || '')) || [...to, ...cc].every(a => QA_RE.test(a));

// "dipanjan@..." -> "Dipanjan"; a role mailbox ("events@", "info@") or anything not name-like -> '' ("Hi there,")
const ROLE = /^(info|sales|support|admin|team|events?|orders?|hello|contact|office|billing|accounts?|ap|ar|finance|catering|hr|ops|noreply|no-reply|reception|bookings?|reservations?|qa-.*|rachel_qa)$/i;
function firstName(recipientName, address) {
  const n = String(recipientName || '').trim().split(/\s+/)[0];
  if (n && /^[a-z][a-z'-]+$/i.test(n)) return n[0].toUpperCase() + n.slice(1);
  const local = String(address || '').split('@')[0].split(/[._+-]/)[0];
  return local && !ROLE.test(local) && /^[a-z]{2,}$/i.test(local) ? local[0].toUpperCase() + local.slice(1).toLowerCase() : '';
}

const usd = n => '$' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function subjectFor(clientName, eventDate) {
  return 'Your Bevvi proposal – ' + (String(clientName || '').trim() || 'your event') + (eventDate ? ' – ' + eventDate : '');
}

// Rachel's email voice (email-agent.py dress()): "Hi <first>," ... "Warmly, Rachel / Your personal mixologist at Bevvi".
// No download link: the PDF is attached.
function bodyFor({ first, clientName, eventDate, totals }) {
  const t = totals || {};
  const parts = [];
  if (t.tax_label) parts.push(t.tax_label + ' ' + usd(t.tax));
  if (t.service) parts.push(t.service_label + ' ' + usd(t.service));
  if (t.tip) parts.push(t.tip_label + ' ' + usd(t.tip));
  parts.push('delivery ' + usd(t.delivery));
  return (first ? 'Hi ' + first + ',' : 'Hi there,') + '\n\n' +
    'Your Bevvi proposal' + (clientName ? ' for ' + clientName : '') + ' is attached' + (eventDate ? ', for ' + eventDate : '') + '.\n\n' +
    'Total: ' + usd(t.grand_total) + ' (products ' + usd(t.products) + ', ' + parts.join(', ') + ').\n\n' +
    'Reply to this email with any changes and I\'ll update it for you.' +
    '\n\nWarmly,\nRachel\nYour personal mixologist at Bevvi';
}

module.exports = { allowedRecipients, addressList, isQA, firstName, subjectFor, bodyFor, BCC, MAX_RECIPIENTS };
