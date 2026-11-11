// A proposal that was never ordered survives a fresh conversation (DC, Nov 11: "I am trying to add more products to an
// existing order that I have not placed yet"). The iCapital proposal (6 lines, Nov 12) was made in the evening; 6h later
// "add the following to iCapital: Sancerre 5 btls ..." started a fresh conversation ("your earlier cart and proposal
// aren't carried over"), the proposal was gone, and the request was later merged into an older PLACED order instead.
// Now resetState keeps a pointer to the conversation's last proposal (state.keptProposal, 14 days), and a message that
// names that proposal's client or "the proposal / quote" brings it back as the cart (server.js [kept-proposal]).
const fs = require('fs');
const path = require('path');

const ITEMS_DIR = process.env.PROPOSAL_ITEMS_DIR || '/home/ubuntu/logs/proposal-items';
const KEEP_MS = 14 * 24 * 3600 * 1000;
// Client names too generic to mean "that proposal" when they appear in a message.
const GENERIC = /^(?:bevvi|client|company|event|party|office|team|test|none|tbd|n\/?a|proposal|quote|menu|order|drinks?)$/i;

function pdfOf(url) {
  const m = String(url || '').match(/(bevvi-proposal[\w.-]*\.pdf)/);
  return m ? m[1] : '';
}

function load(pdf) {
  if (!pdf) return null;
  try { return JSON.parse(fs.readFileSync(path.join(ITEMS_DIR, path.basename(pdf) + '.json'), 'utf8')); } catch (e) { return null; }
}

// What resetState carries into the new conversation: the old conversation's latest proposal, else what it had kept.
function keepFrom(old, now) {
  if (!old) return null;
  const t = now || Date.now();
  const pdf = pdfOf(old.lastProposalUrl);
  if (pdf && load(pdf)) return { pdf, at: t };
  const kp = old.keptProposal;
  if (kp && kp.pdf && t - (kp.at || 0) < KEEP_MS && load(kp.pdf)) return kp;
  return null;
}

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Does this message refer to the kept proposal? Its client named as a whole word ("add the following to iCapital"), or
// "the / my / that / earlier proposal | quote".
function refersTo(message, prop) {
  const m = String(message || '');
  if (!prop) return '';
  const client = String(prop.client_name || '').trim();
  if (client && !GENERIC.test(client) && fold(client).length >= 3) {
    const c = fold(client), t = ' ' + fold(m) + ' ';
    if (t.includes(' ' + c + ' ')) return 'client ' + JSON.stringify(client);
  }
  if (/\b(?:the|my|our|that|this|last|earlier|previous|existing|same)\s+(?:proposal|quote|pdf)\b/i.test(m)) return 'names the proposal';
  return '';
}

// The delivery address printed on it ("Delivery: 60 E 42nd St, 10th floor, New York, NY 10165.").
function addressOf(prop) {
  const n = String((prop && (prop.address || prop.notes)) || '');
  const m = n.match(/(?:^|\b)(?:Delivery|Deliver to|Address)\s*:\s*([^\n]*?\b\d{5})(?:-\d{4})?\b/i) || n.match(/(\d+[^\n]*?,[^\n]*?\b[A-Z]{2}\s+\d{5})\b/);
  return m ? m[1].trim() : '';
}

function lineCount(prop) {
  let li = prop && prop.line_items;
  try { if (typeof li === 'string') li = JSON.parse(li); } catch (e) { li = []; }
  return Array.isArray(li) ? li.length : 0;
}

function lines(prop) {
  let li = prop && prop.line_items;
  try { if (typeof li === 'string') li = JSON.parse(li); } catch (e) { li = []; }
  return Array.isArray(li) ? li : [];
}

function label(prop) {
  const n = lineCount(prop);
  return (prop.client_name ? prop.client_name + ' ' : '') + 'proposal' + (prop.event_date ? ' for ' + prop.event_date : '') + ' (' + n + ' item' + (n === 1 ? '' : 's') + ')';
}

module.exports = { pdfOf, load, keepFrom, refersTo, addressOf, lines, lineCount, label, KEEP_MS };
