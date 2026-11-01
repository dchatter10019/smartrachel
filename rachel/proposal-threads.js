// Proposals the CONNECTOR emailed (rachel_generate_proposal send_to), so a reply to that email reaches its quote.
// Real (F-0122, Oct 30, DC): claude.ai emailed "Your Bevvi proposal – withatwist"; DC replied "Can you take the address
// out and resend the proposal" (and later forwarded it). The email thread was a new Rachel session with no basket and no
// address — the connector's PDF belonged to no /chat session — so Rachel asked for a delivery address twice.
// Now: rachel-mcp records every emailed proposal (POST /internal/proposal-emailed -> record) and an email session with
// no quote of its own looks it up (find) by the Gmail thread id in its session id, else by the sender being a recipient
// + the same subject (minus Re:/Fwd:), within 30 days; server.js loads that PDF's saved lines into the session.
const fs = require('fs');
const FILE = () => require('./data-dir.js').file('proposal-emails.jsonl');
const DAY = 864e5;
const low = s => String(s || '').trim().toLowerCase();
const subj = s => String(s || '').replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

function record(r) {
  const row = { at: new Date().toISOString(), pdf: String(r.pdf || ''), thread_id: r.thread_id ? String(r.thread_id) : '',
    subject: String(r.subject || ''), to: [].concat(r.to || [], r.cc || []).map(low).filter(Boolean),
    caller: low(r.caller), client_name: String(r.client_name || '') };
  if (!row.pdf) return null;
  fs.appendFileSync(FILE(), JSON.stringify(row) + '\n');
  return row;
}

// find({ session_id, sender, subject }) -> the newest matching record, or null.
function find({ session_id, sender, subject }, now = Date.now()) {
  let rows = [];
  try { rows = fs.readFileSync(FILE(), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return null; }
  rows = rows.filter(r => now - (Date.parse(r.at) || 0) <= 30 * DAY).reverse();
  const tid = (String(session_id || '').match(/^email-([0-9a-f]{8,})-/i) || [])[1];
  if (tid) { const r = rows.find(x => x.thread_id && x.thread_id.toLowerCase() === tid.toLowerCase()); if (r) return Object.assign({ why: 'gmail thread ' + tid }, r); }
  const who = low(sender), s = subj(subject);
  if (!who || !s) return null;
  const r = rows.find(x => subj(x.subject) === s && (x.to.includes(who) || x.caller === who));
  return r ? Object.assign({ why: 'subject "' + r.subject + '" sent to ' + who }, r) : null;
}

// The delivery address the PDF's notes carry ("100 guests, 4 hours, 15188 Park of Commerce Blvd suite 5, Jupiter, FL
// 33478, USA" / "Delivery: 132 W 32nd St, New York, NY 10001.") -> { address, zip } | null.
function addressFromNotes(notes) {
  const a = require('./address-extract.js').findAddress(String(notes || '').replace(/^\s*delivery\s*:\s*/i, ''));
  if (!a) return null;
  const parts = a.split(',').map(x => x.trim());
  while (parts.length > 1 && /^\d+\s+(?:guests?|hours?|hrs?|people|persons?|pax|drinks?|bottles?)\b/i.test(parts[0])) parts.shift();
  const address = parts.join(', ');
  const zip = (address.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/) || [])[1];
  return zip && /^\d{1,6}\s+[A-Za-z]/.test(address) ? { address, zip } : null;
}

module.exports = { record, find, addressFromNotes, _subj: subj };
