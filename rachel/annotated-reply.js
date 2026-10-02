// An email reply that answers Rachel line by line: the customer pastes lines of her last reply and writes an
// answer after "->". Read in code, pair by pair (rule 6). Real case (Oct 2, DC's Goody thread):
//   Want me to swap the Diet for the regular 4-pack, keeping 4x? -> do you have
//   any other non diet Ginger Beer the same size?
//   San Pellegrino 500 ML 12-pack — $19.94 (need 4x to hit 48 units) -> this is
//   good
// went to the substitute heuristics: San Pellegrino was added at 1x ("replaced null") instead of 4x replacing the
// sparkling water line, and the ginger beer question was never answered.
//
// parse(message, lastReply) -> [{ quote, answer, accept, qty, header }]  only pairs whose left side is a line of
//   Rachel's last reply (anything else is an ordinary "A -> B" swap, instructions.js)
// productFor(quote, shown) -> the ONE product just shown that the quoted option line is (brand word + price), or null
// headerFor(quote, lastReply) -> the section the quoted option sits under ("SPARKLING WATER — no 24-pack ...")
const norm = s => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
const ACCEPT = /^(?:(?:this|that|it)(?:'s|\s+is|\s+looks|\s+sounds|\s+works)?\s+)?(?:good|great|fine|perfect|ok|okay|works|correct|right)\b|^(?:yes|yep|yeah|sure|ok|okay|perfect|works|sounds good|looks good|go with (?:this|that|it)|keep (?:this|that|it)|take (?:this|that|it))\b/;

function inReply(quote, lastReply) {
  const q = norm(quote).replace(/[*_]/g, ''), r = norm(lastReply).replace(/[*_]/g, '');
  return q.length >= 8 && r.indexOf(q) >= 0;
}

function parse(message, lastReply) {
  if (!lastReply) return [];
  const lines = String(message || '').replace(/\r/g, '').split('\n');
  const pairs = [];
  let cur = null, pendingQuote = '';
  for (const raw of lines) {
    const l = raw.replace(/-&gt;/g, '->').replace(/^\s*[>*]+\s?/, '').trimEnd();
    const a = l.indexOf('->');
    if (a >= 0) {
      const left = (pendingQuote ? pendingQuote + ' ' : '') + l.slice(0, a).trim();
      pendingQuote = '';
      cur = { quote: left.replace(/[,;]\s*$/, '').trim(), answer: l.slice(a + 2).trim() };
      pairs.push(cur);
    } else if (!l.trim()) {
      continue;
    } else if (inReply(l, lastReply) && !(cur && !cur.answer)) {
      // a quoted line on its own: either the start of the next pair's quote, or (no arrow follows) context
      cur = null; pendingQuote = (pendingQuote ? pendingQuote + ' ' : '') + l.trim();
    } else if (cur) {
      cur.answer = (cur.answer + ' ' + l.trim()).trim();   // the answer wrapped onto the next line
    }
  }
  return pairs.filter(p => inReply(p.quote, lastReply)).map(p => {
    const ans = norm(p.answer).replace(/[.!]+$/, '');
    const qm = p.quote.match(/\bneed\s+(\d+)\s*x\b/i) || p.quote.match(/^\s*(\d+)\s*x\s/i) || p.quote.match(/\bkeeping\s+(\d+)\s*x\b/i);
    return { quote: p.quote, answer: p.answer, accept: ans.split(' ').length <= 6 && ACCEPT.test(ans), qty: qm ? +qm[1] : null, header: headerFor(p.quote, lastReply) };
  });
}

// The ALL-CAPS section label above the quoted line in Rachel's reply ("BUNDABERG", "SPARKLING WATER").
function headerFor(quote, lastReply) {
  const lines = String(lastReply || '').split('\n');
  const q = norm(quote).replace(/[*_]/g, '').slice(0, 40);
  const i = lines.findIndex(l => norm(l).replace(/[*_]/g, '').indexOf(q) >= 0);
  for (let j = i - 1; j >= 0; j--) {
    const m = lines[j].replace(/[*_]/g, '').match(/^\s*([A-Z][A-Z0-9 &'/.-]{2,40}?)\s*(?:[—–:-]|$)/);
    if (m && m[1] === m[1].toUpperCase() && /[A-Z]{3}/.test(m[1])) return m[1].trim();
  }
  return '';
}

// The option line names a product as Rachel wrote it ("San Pellegrino 500 ML 12-pack — $19.94") — not the catalog
// name. Match on its price AND its brand (first word) among the products just shown; exactly one, else null.
function productFor(quote, shown) {
  const pm = String(quote).match(/\$\s?(\d+(?:\.\d{2})?)/);
  if (!pm) return null;
  const price = +pm[1];
  const brand = norm(String(quote).split(/\s[—–-]\s|\$/)[0]).split(/[^a-z0-9']+/).filter(Boolean)[0];
  if (!brand) return null;
  const seen = new Set();
  const hits = (shown || []).filter(p => {
    const k = p.product_id || p.name; if (seen.has(k)) return false; seen.add(k);
    return Math.abs((parseFloat(p.price) || 0) - price) < 0.005 && norm(p.name).split(/[^a-z0-9']+/).indexOf(brand) >= 0;
  });
  return hits.length === 1 ? hits[0] : null;
}

// The basket line a section header stands for: every header word in the line's label (what was asked) or name.
function lineForHeader(header, items) {
  const hw = norm(header).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  if (!hw.length) return -1;
  const hits = [];
  (items || []).forEach((it, i) => { const t = norm((it.label || '') + ' ' + (it.name || '')); if (hw.every(w => t.indexOf(w) >= 0)) hits.push(i); });
  return hits.length === 1 ? hits[0] : -1;
}

// An answer about a BASKET line, applied in code: "Remove this", "Make this 2 bottles", "This is good" (keep).
// Real (Oct 2, DC's Goody thread): "1x Owen's Transfusion ... -> Remove this", "1x Tito's ... -> Make this 2
// bottles", "4x Conundrum White ... -> This is good" all went to the LLM. -> { remove } | { qty } | { keep } | null
function lineAction(answer) {
  const a = String(answer || '').trim().replace(/[.!]+$/, '').trim();
  if (/^(?:please\s+)?(?:remove|delete|drop|cut|take\s+(?:it|this|that)\s+(?:out|off))(?:\s+(?:this|it|that)(?:\s+one)?)?(?:\s+please)?$|^(?:not\s+needed|no\s+need|don'?t\s+need(?:\s+(?:this|it))?)$/i.test(a)) return { remove: true };
  const q = a.match(/^(?:please\s+)?(?:(?:make|change|set|update|bump|increase|reduce|lower)\s+(?:this|it|that)?\s*(?:to\s+)?|just\s+|only\s+)?(\d{1,3})\s*(?:x|bottles?|cans?|packs?|cases?|units?|of\s+(?:this|these|them))?(?:\s+please)?$/i);
  if (q && +q[1] > 0) return { qty: +q[1] };
  if (/^(?:this|that|it)?\s*(?:is|looks|'s)?\s*(?:good|great|fine|perfect|ok(?:ay)?|correct|right)(?:\s+as\s+is)?$|^(?:keep(?:\s+(?:this|it))?(?:\s+as\s+is)?|leave\s+(?:it|this)(?:\s+as\s+is)?|no\s+change)$/i.test(a)) return { keep: true };
  return null;
}
// The basket product a reply line names: "4x Troublemaker Red Wine - 750 ML — $22.00 ea = $88.00" -> "Troublemaker Red Wine - 750 ML"
const quoteName = q => String(q || '').replace(/^\s*(?:[-•*·]\s*)?\d+\s*x\s+/i, '').replace(/\s+[—–-]\s+\$[\d,.]+.*$/, '').trim();

module.exports = { parse, productFor, headerFor, lineForHeader, lineAction, quoteName };
