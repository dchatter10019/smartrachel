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

module.exports = { get, save, profileName, nameCorrection, refusesName };
