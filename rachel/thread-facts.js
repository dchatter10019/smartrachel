// EVERYTHING THE EMAIL THREAD ALREADY SAYS, gathered in code on every email turn (DC, Nov 14: "provide a solution where it
// always checks the entire email thread and gathers all the information and only if it can't find a required piece of
// information, it asks"). Real cases the same day: the HI USA forward — address, order and date sat in the email the
// forwarded reply QUOTED, and Rachel asked for the address, then "How many bottles?", then the client and the event date.
//
// gather(emails, ctx) -> facts
//   emails: email-body.js customerEmails() — the customer side of the whole thread (every Gmail thread of the session,
//           forwards and the history the first email quotes included), NEWEST first, each { text, sent, current }.
//   ctx:    { subject, senderName, senderEmail }
//   facts:  { address, eventDate, client, contactName, contactEmail, phone, window, instructions, bottlePrice, items }
//           each { value, from } ('this email' | 'N email(s) back'), absent when the thread doesn't say it.
//           Newest statement wins (a later "the date is now Nov 20" beats the first email), except items: the FIRST email
//           with a list (the original request).
// note(facts)            -> the "KNOWN FROM THE EMAIL THREAD" block for the model's notes ('' when nothing is known)
// askedKnown(reply, f)   -> [{ field, value }] — questions in a reply whose answer the thread already gives (logged and
//                           recorded for the nightly fixer by server.js: every such ask is a gap in the code).

const AX = require('./address-extract.js');
const ED = require('./event-date.js');
const ES = require('./email-subject.js');
const EO = require('./email-order.js');
const BP = require('./bottle-price.js');

const LIST_LINE = /^\s*(?:[-•*·]\s+\S|\d{1,4}\s*(?:x|×)\s*\S)|\S.*\s[–—-]\s*\d{1,4}\s*(?:x\s*)?(?:bottles?|btls?|cans?|cases?|packs?)\b/i;
const unquote = t => String(t || '').replace(/\r/g, '').split('\n').map(l => l.replace(/^\s*(?:>\s?)+/, '')).join('\n');
const fromLabel = (k, e) => (k === 0 ? 'this email' : k + ' email(s) back') + (e && /\n\s*>|wrote:\s*$/m.test(e.text) ? ', incl. quoted history' : '');

function gather(emails, ctx = {}) {
  const list = (emails || []).filter(e => e && String(e.text || '').trim());
  const f = {};
  const set = (key, value, k) => { if (value && !f[key]) f[key] = { value: String(value).trim(), from: fromLabel(k, list[k]) }; };
  list.forEach((e, k) => {
    const t = unquote(e.text);
    set('address', AX.addressAfterLabel(t) || AX.findAddress(AX.cleanTyped(t)) || AX.findAddressNoZip(t), k);
    const d = ED.findEventDateIn(t, e.sent);
    if (d && /\d/.test(d)) set('eventDate', d, k);
    set('client', ES.clientLabeledIn(t), k);
    try {
      const x = EO.extract(t, { name: ctx.senderName, email: ctx.senderEmail }, e.sent || new Date());
      const own = (x.source === 'sender' || !x.source) && EO.isStaff(ctx.senderEmail);   // a Bevvi forwarder is never the contact
      if (!own) { set('contactName', x.name, k); set('contactEmail', x.email && !EO.isStaff(x.email) ? x.email : '', k); set('phone', x.phone, k); }
      set('instructions', x.instructions, k);
    } catch (err) {}
    const w = t.match(/\bdelivery\s+(?:window|time)\s*:?\s*\**\s*([0-9][^\n*]{3,40})/i);
    if (w) set('window', w[1].replace(/\s+/g, ' ').trim(), k);
    const bp = BP.read(t);
    if (bp) set('bottlePrice', JSON.stringify(bp), k);
  });
  // The original request's list: the OLDEST email that has 2+ list lines.
  for (let k = list.length - 1; k >= 0; k--) {
    const lines = unquote(list[k].text).split('\n').filter(l => LIST_LINE.test(l)).map(l => l.trim());
    if (lines.length >= 2) { f.items = { value: lines.slice(0, 60).join('\n'), from: fromLabel(k, list[k]), count: lines.length }; break; }
  }
  // The client: a "Client:" line, else the subject, else the forwarded sender's company (never a Bevvi sender's name).
  if (!f.client) {
    const sc = ES.clientFromSubject(ctx.subject || '');
    if (sc) f.client = { value: sc, from: 'the subject' };
    else for (let k = list.length - 1; k >= 0 && !f.client; k--) { const fc = ES.clientFromForward(unquote(list[k].text)); if (fc) f.client = { value: fc, from: fromLabel(k, list[k]) }; }
  }
  return f;
}

const LABEL = { address: 'Delivery address', eventDate: 'Event / delivery date', client: 'Client', contactName: 'Customer / delivery contact',
  contactEmail: 'Contact email', phone: 'Phone', window: 'Delivery window', instructions: 'Delivery instructions', bottlePrice: 'Per-bottle price limit', items: 'Items requested' };
function show(key, v) {
  if (key === 'bottlePrice') { try { const b = JSON.parse(v); return b.category + ' ' + (b.min ? '$' + b.min + '-' : 'up to ') + '$' + b.max + ' a bottle'; } catch (e) { return v; } }
  return key === 'items' ? '\n' + v : v;
}
function note(f) {
  const keys = Object.keys(LABEL).filter(k => f && f[k]);
  if (!keys.length) return '';
  return '## KNOWN FROM THE EMAIL THREAD (gathered in code from every email, incl. forwards and quoted history — newest statement wins)\n'
    + keys.map(k => '- ' + LABEL[k] + ' (' + f[k].from + '): ' + show(k, f[k].value)).join('\n')
    + '\nUse these. Never ask the customer for anything listed here; ask only for what is missing and needed.';
}

const ASKS = [
  ['address', /\bwhat(?:'s| is) (?:your|the) delivery address\b|\bwhere (?:should|do) (?:we|i) deliver\b/i],
  ['eventDate', /\bwhat is the (?:event|delivery) date\b|\bwhat(?:'s| is) the date of (?:the|your) event\b|\bwhen is (?:the|your) event\b/i],
  ['client', /\bclient or company name\b|\bwhat(?:'s| is) the (?:client|company)(?: name)?\b/i],
  ['phone', /\b(?:your|a|the) (?:phone|mobile|cell)(?: number)?\b[^.\n]{0,40}\?/i],
  ['contactEmail', /\bwhat email should we use\b/i],
  ['items', /\bhow many bottles would you like on the proposal\b|\bwhat (?:beverages|drinks) (?:are|do you|would you)\b/i],
];
function askedKnown(reply, f) {
  const r = String(reply || '');
  return ASKS.filter(([k, re]) => f && f[k] && re.test(r)).map(([k]) => ({ field: k, value: f[k].value.slice(0, 120), from: f[k].from }));
}

module.exports = { gather, note, askedKnown, LIST_LINE };
