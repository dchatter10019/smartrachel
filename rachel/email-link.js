// A NEW email thread that continues an earlier quote: which session it belongs to — decided in code.
// Real case (Sep 29, Gen II Fund): Sean FORWARDED the customer's edits ("can you make these modifications to
// the proposal curated for Gen II Fund earlier today?") — a new Gmail thread, so the email agent started a
// fresh session with no basket, and the edits had nothing to apply to.
//
// pick(msg, candidates, now) -> { session_id, reason } | { session_id: null, reason, ask?: [candidate] }
//   msg:        { sender_email, subject, body, pdfs? (proposal PDF names attached/linked in the email) }
//   candidates: [{ session_id, sender_email, client, subject, last_active (ms), has_quote,
//                  event_date?, address?, zip?, total?, items?, pdfs? }]
// Rules, in order (only the SAME sender, only sessions with a quote, active in the last 30 days):
//   1. a proposal PDF of that session is attached to / linked in the email -> that session
//   2. the earlier quote's client name ("Gen II Fund") appears in the new subject/body -> that session
//      (several: the weaker signals below pick among them, else the newest)
//   3. an email about changing a quote whose event date / venue / total matches exactly ONE quote -> that one
//   4. an email about changing a quote, and this sender has exactly ONE quote in 14 days -> that one
//   5. an email about changing a quote, several possible -> `ask`: the caller asks "which proposal?" (never a
//      guess between two quotes); answer(reply, choices) reads the answer
//   otherwise a new session.

const GENERIC = new Set('the of and a an fund funds inc llc ltd co company corp corporation group services service partners holdings team office'.split(' '));
const DAY = 864e5;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const clientFromSubject = s => ((String(s || '').match(/\s[-–—|:]\s*([^-–—|:]{2,60})$/) || [])[1] || '').trim();
const clientOf = c => c.client || clientFromSubject(c.subject);
function clientTokens(client) {
  return norm(client).split(/[^a-z0-9]+/).filter(w => w && !GENERIC.has(w));
}
const words = text => ' ' + norm(text).replace(/[^a-z0-9]+/g, ' ') + ' ';
function mentions(text, client) {
  const toks = clientTokens(client);
  if (!toks.length || (toks.length === 1 && toks[0].length < 4)) return false;   // "Co" alone is not a name
  const t = words(text);
  return toks.every(w => t.includes(' ' + w + ' '));
}
const ABOUT_QUOTE = /\b(?:proposal|quote|order|estimate|invoice)\b/i;
const CHANGE = /\b(?:modif\w*|change\w*|updat\w*|remov\w*|adjust\w*|revis\w*|edit\w*|swap\w*|add\w*|reduc\w*|increas\w*|instead)\b/i;
const isEdit = text => ABOUT_QUOTE.test(text) && CHANGE.test(text);

// ── Weaker signals ─────────────────────────────────────────────────────────────────────────────────────────
// Event date: "Oct 12", "October 12th", "12 October", "10/12", "10/12/2026", "2026-10-12" -> "10-12" keys.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
function datesIn(text) {
  const t = norm(text), out = new Set();
  const add = (m, d) => { m = +m; d = +d; if (m >= 1 && m <= 12 && d >= 1 && d <= 31) out.add(m + '-' + d); };
  const mi = s => MONTHS.indexOf(s.slice(0, 3)) + 1;
  let r;
  const a = new RegExp('\\b' + MON + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b', 'g');
  while ((r = a.exec(t))) add(mi(r[1]), r[2]);
  const b = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MON + '\\b', 'g');
  while ((r = b.exec(t))) add(mi(r[2]), r[1]);
  const c = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  while ((r = c.exec(t))) add(r[2], r[3]);
  const d = /(?:^|[^\d/-])(\d{1,2})\/(\d{1,2})(?:\/(?:\d{4}|\d{2}))?(?![\d/])/g;
  while ((r = d.exec(t))) add(r[1], r[2]);
  return out;
}
// Venue: the street ("100 Federal") or the zip of the quote's delivery address.
function venueMatch(text, c) {
  const t = words(text);
  const st = norm(String(c.address || '').split(',')[0]).match(/^(\d+[a-z]?)\s+([a-z]{3,})/);
  if (st && t.includes(' ' + st[1] + ' ' + st[2] + ' ')) return st[1] + ' ' + st[2];
  if (c.zip && new RegExp('\\b' + c.zip + '\\b').test(String(text))) return c.zip;
  return '';
}
// Total: a dollar amount within 10% of the quote's total (a PDF total can include tax/fees).
function amountsIn(text) {
  return [...String(text).matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map(m => parseFloat(m[1].replace(/,/g, ''))).filter(v => v >= 50);
}
function signals(text, c, pdfs) {
  const s = [];
  if (pdfs && pdfs.length && (c.pdfs || []).some(p => pdfs.includes(p))) s.push('proposal PDF');
  const ds = datesIn(text), cd = c.event_date ? [...datesIn(c.event_date)] : [];
  if (cd.length && cd.some(k => ds.has(k))) s.push('event date ' + c.event_date);
  const v = venueMatch(text, c); if (v) s.push('venue ' + v);
  if (c.total && amountsIn(text).some(a => Math.abs(a - c.total) <= c.total * 0.10)) s.push('total $' + Math.round(c.total));
  return s;
}
// Among cands: the ONE with the most weak signals (strictly more than any other), else null + the tied ones.
function bySignals(text, cands, pdfs) {
  const scored = cands.map(c => ({ c, s: signals(text, c, pdfs) })).filter(x => x.s.length);
  if (!scored.length) return { best: null, tied: [] };
  const max = Math.max(...scored.map(x => x.s.length));
  const top = scored.filter(x => x.s.length === max);
  return top.length === 1 ? { best: top[0], tied: [] } : { best: null, tied: top.map(x => x.c) };
}
function pdfsIn(msg) {
  const names = new Set((msg.pdfs || []).map(p => String(p).split('/').pop()));
  for (const m of String(msg.body_full || msg.body || '').matchAll(/bevvi-proposal[\w.-]*?\.pdf/gi)) names.add(m[0]);
  names.delete('bevvi-proposal.pdf');   // the generic name older replies attached with — matches every quote
  return [...names];
}

function pick(msg, candidates, now = Date.now()) {
  const sender = norm(msg.sender_email).trim();
  const pool = (candidates || []).filter(c => norm(c.sender_email).trim() === sender && c.has_quote && now - (c.last_active || 0) <= 30 * DAY)
    .sort((a, b) => (b.last_active || 0) - (a.last_active || 0));
  if (!pool.length) return { session_id: null, reason: 'no earlier quote from ' + sender + ' in 30 days' };
  const text = (msg.subject || '') + '\n' + (msg.body || '');
  const pdfs = pdfsIn(msg);
  const byPdf = pdfs.length ? pool.filter(c => (c.pdfs || []).some(p => pdfs.includes(p))) : [];
  if (byPdf.length) return { session_id: byPdf[0].session_id, reason: 'proposal PDF ' + pdfs.filter(p => (byPdf[0].pdfs || []).includes(p))[0] + ' in the email' };
  const hits = pool.filter(c => { const cl = clientOf(c); return cl && mentions(text, cl); });
  if (hits.length === 1) return { session_id: hits[0].session_id, reason: 'client name "' + clientOf(hits[0]) + '" in the email' };
  if (hits.length > 1) {
    const w = bySignals(text, hits, pdfs);
    if (w.best) return { session_id: w.best.c.session_id, reason: 'client name "' + clientOf(w.best.c) + '" in the email, ' + w.best.s.join(' + ') + ' (of ' + hits.length + ' quotes for that client)' };
    return { session_id: hits[0].session_id, reason: 'client name "' + clientOf(hits[0]) + '" in the email (newest of ' + hits.length + ')' };
  }
  if (!isEdit(text)) return { session_id: null, reason: pool.length + ' earlier quote(s) from this sender, none named — not about changing a quote' };
  const w = bySignals(text, pool, pdfs);
  if (w.best) return { session_id: w.best.c.session_id, reason: 'about changing a quote; ' + w.best.s.join(' + ') + ' matches only "' + (clientOf(w.best.c) || w.best.c.session_id) + '"' };
  const recent = pool.filter(c => now - (c.last_active || 0) <= 14 * DAY);
  if (!w.tied.length && recent.length === 1) {
    return { session_id: recent[0].session_id, reason: 'about changing a quote, and the only quote from this sender in 14 days' };
  }
  const ask = (w.tied.length ? w.tied : (recent.length ? recent : pool)).slice(0, 5);
  return { session_id: null, ask, reason: 'about changing a quote; ' + (w.tied.length ? w.tied.length + ' quotes match equally' : (recent.length || pool.length) + ' possible quotes') + ' — asking which one' };
}

// ── The question and its answer ────────────────────────────────────────────────────────────────────────────
const money = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function label(c) {
  const parts = [clientOf(c) || 'Quote (no client name)'];
  if (c.event_date) parts.push('event ' + c.event_date);
  if (c.address) {   // "100 Federal Street, Floor 6, Boston, MA 02110" -> "100 Federal Street, Boston"
    const seg = String(c.address).split(',').map(s => s.trim());
    parts.push(seg.length > 2 ? seg[0] + ', ' + seg[seg.length - 2] : seg[0]);
  }
  if (c.total) parts.push(money(c.total) + (c.items ? ' (' + c.items + ' item' + (c.items === 1 ? '' : 's') + ')' : ''));
  if (c.last_active) parts.push('last updated ' + new Date(c.last_active).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }));
  return parts.join(' — ');
}
function question(choices) {
  return 'Happy to make those changes. You have more than one proposal with me, so which one should I update?\n\n' +
    choices.map((c, i) => (i + 1) + '. ' + (c.label || label(c))).join('\n') +
    '\n\nReply with the number or the client name (or "new" if this is a new request).';
}
// answer(reply, choices) -> { index } | { new: true } | null (not an answer: ask again)
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, one: 1, two: 2, three: 3, four: 4, five: 5 };
function answer(reply, choices) {
  const t = norm(reply).trim();
  if (!t) return null;
  const n = t.match(/^(?:#|no\.?\s*|number\s+|option\s+|the\s+)?(\d)(?:st|nd|rd|th)?\b/) || t.match(/^(?:the\s+)?(first|second|third|fourth|fifth|one|two|three|four|five)\b/);
  if (n) { const i = (ORD[n[1]] || +n[1]) - 1; if (i >= 0 && i < choices.length) return { index: i }; }
  const hits = choices.map((c, i) => ({ c, i })).filter(x => clientOf(x.c) && mentions(reply, clientOf(x.c)));
  if (hits.length === 1) return { index: hits[0].i };
  const w = bySignals(reply, hits.length ? hits.map(x => x.c) : choices, pdfsIn({ body: reply }));
  if (w.best) return { index: choices.indexOf(w.best.c) };
  if (/^(?:(?:it'?s |this is )?(?:a )?(?:new|none|neither|separate|different)\b)/.test(t)) return { new: true };
  return null;
}

module.exports = { pick, clientFromSubject, mentions, datesIn, label, question, answer };
