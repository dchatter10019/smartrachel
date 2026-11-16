// Contact details (name, phone, email) from a customer's last PLACED order, keyed by account email.
// Real complaint (DC, Sep 29, Slack): a returning customer was asked "What is your full name?" on
// every order — savedCustomer lived only in the session and was wiped by reset / idle expiry.
// Contact details are not compliance state (age is, and stays per session), so they persist here.
// QA identities are never saved: their scenarios must see the same questions every run.
const fs = require('fs');
const FILE = require('./data-dir.js').file('customer-contacts.json');
const QA_RE = /^(qa-[^@]*|rachel_qa)@getbevvi\.com$/i;

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; } }

function get(email) {
  if (!email) return null;
  const c = readAll()[String(email).toLowerCase()];
  return c && c.name ? c : null;
}

function save(email, c, log = console.log) {
  if (!email || !c || !c.name) return;
  if (QA_RE.test(String(email))) { log('[contacts] not saved for QA identity ' + email); return; }
  const all = readAll();
  all[String(email).toLowerCase()] = { name: c.name, phone: c.phone || '', email: c.email || '', savedAt: new Date().toISOString() };
  try { fs.writeFileSync(FILE, JSON.stringify(all, null, 1)); log('[contacts] saved for ' + email + ' from the placed order'); }
  catch (e) { log('[contacts] save failed for ' + email + ': ' + e.message); }
}

// A channel profile name ("Dipanjan Chatterjee" from Slack real_name) is usable only as a first
// and last name: one word, an email or a handle is not a name for the order.
function profileName(s) {
  const n = String(s || '').replace(/\s+/g, ' ').trim();
  return /^[A-Za-zÀ-ÿ'.-]+(?: [A-Za-zÀ-ÿ'.-]+){1,3}$/.test(n) ? n : '';
}

// A correction to a prefilled name ("no, it's Jane Doe", "use jane doe", "Jane Doe"), or null.
// Lowercase is accepted only after a correction phrase; a bare reply must be capitalized words, so
// "same" / "sounds good" are never read as a name.
function nameCorrection(m) {
  const t = String(m || '').trim().replace(/[.!]+$/, '');
  const pre = t.match(/^(?:(?:no|nope)[,.!]?\s*)?(?:it'?s|it should be|should be|use|put it under|under|make it|the name is|name is|name should be|change (?:the )?name to)\s+([a-zà-ÿ'.-]+(?:\s+[a-zà-ÿ'.-]+){1,3})$/i);
  const bare = t.match(/^(?:(?:no|nope)[,.!]?\s+)?([A-Z][A-Za-zà-ÿ'.-]+(?:\s+[A-Z][A-Za-zà-ÿ'.-]+){1,3})$/);
  const nm = pre ? pre[1] : bare ? bare[1] : null;
  // "use the same", "use my email", "Same Please": about the email, not a name.
  return nm && !/\b(same|email|e-mail|mail|account|my|mine|me|that|this|it|one|please|thanks|ok|okay|yes|sure)\b/i.test(nm) ? nm : null;
}
// "no" / "that's wrong" with no name: the prefilled name is refused, ask for it.
const refusesName = m => /^\s*(?:no|nope|wrong|not me|that'?s (?:wrong|not me|not right)|someone else|different name)\s*[.!]?\s*$/i.test(String(m || ''));

// A recipient named inside another answer: "The Name of the recipient is Khira Patel but the email is x@y.com",
// "recipient: Khira Patel". Real (Oct 5, DC, Slack): the email was taken and the name dropped — the order went out
// under the prefilled Slack name.
function recipientNameIn(m) {
  const t = String(m || '');
  const k = t.match(/\b(?:(?:the\s+)?name\s+of\s+the\s+recipient|recipient'?s?\s+(?:full\s+)?name|(?:the\s+)?recipient|deliver(?:y|ing)?\s+(?:is\s+)?(?:to|for)|(?:it'?s|order\s+is)\s+for)\s*(?:is|should\s+be|will\s+be|=|:)?\s+/i);
  if (!k) return null;
  const rest = t.slice(k.index + k[0].length);
  const n = rest.match(/^([A-Z][A-Za-zà-ÿ'.-]+(?:\s+[A-Z][A-Za-zà-ÿ'.-]+){1,3})\b/);
  if (!n) return null;
  const nm = n[1].split(/\s+/).filter(w => !/^(But|And|Her|His|The|Email|Phone|Same)$/.test(w)).join(' ');
  return nm.split(' ').length >= 2 && !/\b(same|email|account|bevvi)\b/i.test(nm) ? nm : null;
}

// The reply to "Ordering as <name>, <phone>, <email> — tell me if any of that should change. What delivery date and time?"
// -> { name?, phone?, email?, rest } (rest = the message without the contact parts, for the delivery-time reader), or null.
// Real (Nov 16, DC on Slack): "Frank Acosta, 6466103382, <mailto:x@y.com|x@y.com>, tomorrow 3 pm EST" — only the time was
// read and the order went out under the prefilled Slack name and phone.
function contactChangeIn(m) {
  const t = String(m || '').replace(/<mailto:[^|>]+\|([^>]+)>/gi, '$1').replace(/<tel:[^|>]+\|([^>]+)>/gi, '$1');
  const out = {}; let rest = t;
  const em = t.match(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/);
  if (em) { out.email = em[0].toLowerCase(); rest = rest.replace(em[0], ' '); }
  const ph = rest.match(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  if (ph) { out.phone = ph[0].trim(); rest = rest.replace(ph[0], ' '); }
  // A name = a comma / newline part that is 2-4 capitalized words (or "name is X" / "for X"), never time words.
  const TIMEW = /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|am|pm|est|edt|et|pt|pst|ct|cst|mt|noon|same|none|please|thanks)\b/i;
  for (const part of rest.split(/\s*[,;\n]\s*/)) {
    const p0 = part.trim().replace(/^(?:(?:no|nope)[,.!]?\s*)?(?:(?:the\s+)?name\s+(?:is|should\s+be)|it'?s\s+for|for|under|use)\s+/i, '').replace(/[.!]+$/, '');
    if (/^[A-Z][A-Za-zà-ÿ'.-]+(?:\s+[A-Z][A-Za-zà-ÿ'.-]+){1,3}$/.test(p0) && !TIMEW.test(p0) && !/\b(same|email|account|bevvi|my|me)\b/i.test(p0)) {
      out.name = p0; rest = rest.replace(part, ' '); break;
    }
  }
  if (!Object.keys(out).length) return null;
  out.rest = rest.replace(/(?:\s*,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  return out;
}

module.exports = { get, save, profileName, nameCorrection, refusesName, recipientNameIn, contactChangeIn };
