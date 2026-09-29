// A NEW email thread that continues an earlier quote: which session it belongs to — decided in code.
// Real case (Sep 29, Gen II Fund): Sean FORWARDED the customer's edits ("can you make these modifications to
// the proposal curated for Gen II Fund earlier today?") — a new Gmail thread, so the email agent started a
// fresh session with no basket, and the edits had nothing to apply to.
//
// pick(msg, candidates, now) -> { session_id, reason } | { session_id: null, reason }
//   msg:        { sender_email, subject, body }
//   candidates: [{ session_id, sender_email, client, subject, last_active (ms), has_quote }]
// Rules, in order (only the SAME sender, only sessions with a quote, active in the last 30 days):
//   1. the earlier quote's client name ("Gen II Fund") appears in the new subject/body -> newest such session
//   2. the email is about changing a quote/proposal/order and this sender has exactly ONE quote in 14 days
//   otherwise a new session (never a guess between two quotes).

const GENERIC = new Set('the of and a an fund funds inc llc ltd co company corp corporation group services service partners holdings team office'.split(' '));
const DAY = 864e5;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const clientFromSubject = s => ((String(s || '').match(/\s[-–—|:]\s*([^-–—|:]{2,60})$/) || [])[1] || '').trim();
function clientTokens(client) {
  return norm(client).split(/[^a-z0-9]+/).filter(w => w && !GENERIC.has(w));
}
function mentions(text, client) {
  const toks = clientTokens(client);
  if (!toks.length || (toks.length === 1 && toks[0].length < 4)) return false;   // "Co" alone is not a name
  const t = ' ' + norm(text).replace(/[^a-z0-9]+/g, ' ') + ' ';
  return toks.every(w => t.includes(' ' + w + ' '));
}
const ABOUT_QUOTE = /\b(?:proposal|quote|order|estimate|invoice)\b/i;
const CHANGE = /\b(?:modif\w*|change\w*|updat\w*|remov\w*|adjust\w*|revis\w*|edit\w*|swap\w*|add\w*|reduc\w*|increas\w*|instead)\b/i;

function pick(msg, candidates, now = Date.now()) {
  const sender = norm(msg.sender_email).trim();
  const pool = (candidates || []).filter(c => norm(c.sender_email).trim() === sender && c.has_quote && now - (c.last_active || 0) <= 30 * DAY)
    .sort((a, b) => (b.last_active || 0) - (a.last_active || 0));
  if (!pool.length) return { session_id: null, reason: 'no earlier quote from ' + sender + ' in 30 days' };
  const text = (msg.subject || '') + '\n' + (msg.body || '');
  const hits = pool.filter(c => { const cl = c.client || clientFromSubject(c.subject); return cl && mentions(text, cl); });
  if (hits.length) {
    const c = hits[0];
    return { session_id: c.session_id, reason: 'client name "' + (c.client || clientFromSubject(c.subject)) + '" in the email' + (hits.length > 1 ? ' (newest of ' + hits.length + ')' : '') };
  }
  const recent = pool.filter(c => now - (c.last_active || 0) <= 14 * DAY);
  if (ABOUT_QUOTE.test(text) && CHANGE.test(text) && recent.length === 1) {
    return { session_id: recent[0].session_id, reason: 'about changing a quote, and the only quote from this sender in 14 days' };
  }
  return { session_id: null, reason: pool.length + ' earlier quote(s) from this sender, none named in the email' + (recent.length > 1 ? ' — not guessing between them' : '') };
}

module.exports = { pick, clientFromSubject, mentions };
