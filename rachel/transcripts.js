// Conversation transcripts (DC, Oct 7: "log every conversation and analyze end of the night"). One JSON line per turn in
// RACHEL_DATA_DIR/transcripts.jsonl — what the customer said and what Rachel answered, on every channel, whatever the
// outcome. Until Oct 7 only conversations that ended in an order or a proposal were kept (conversations.jsonl), so the
// ones worth reviewing (dropped at the address question, "not available", gave up) left no transcript.
// Writers: events.finish (every /chat turn: Slack, WhatsApp, email, the connector's rachel_chat) and rachel-mcp.js (every
// connector tool call — rachel_search / rachel_recommend results included). Reader: ops/conversation-review.py (nightly).
// A write never blocks or fails a reply; a failure is logged once.
const fs = require('fs');
const FILE = process.env.RACHEL_TRANSCRIPTS_FILE || require('./data-dir.js').file('transcripts.jsonl');
const CAP = { message: 4000, reply: 6000, result: 4000 };

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…[+' + (s.length - n) + ' chars]' : s; };

let warned = false;
function write(entry) {
  try {
    const e = Object.assign({ ts: new Date().toISOString() }, entry);
    if (e.message != null) e.message = clip(e.message, CAP.message);
    if (e.reply != null) e.reply = clip(e.reply, CAP.reply);
    if (e.result != null) e.result = clip(typeof e.result === 'string' ? e.result : JSON.stringify(e.result), CAP.result);
    for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === null || e[k] === '') delete e[k];
    fs.appendFile(FILE, JSON.stringify(e) + '\n', err => { if (err && !warned) { warned = true; console.log('[transcripts] write failed (logged once): ' + err.message); } });
  } catch (err) { if (!warned) { warned = true; console.log('[transcripts] failed (logged once): ' + err.message); } }
}

// What a connector search / recommendation showed the client: name, size, price per product (the log had only counts).
function productSummary(result) {
  const out = [];
  const add = (p, q) => { if (p && (p.name || p.product_name)) out.push((q ? q + ': ' : '') + (p.name || p.product_name) + (p.size ? ' (' + p.size + ')' : '') + (p.price != null ? ' $' + p.price : '')); };
  try {
    if (result && Array.isArray(result.results)) result.results.forEach(r => { if (r.products && r.products.length) r.products.forEach(p => add(p, r.query)); else out.push((r.query || '?') + ': NOT FOUND'); });
    for (const k of ['recommendations', 'products', 'line_items']) {
      let v = result && result[k]; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
      if (Array.isArray(v)) v.forEach(p => add(p));
    }
  } catch (e) {}
  return out.length ? out.join('\n') : null;
}

module.exports = { write, productSummary, FILE };
