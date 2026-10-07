// Event log (Learning Phase 1, Part A). One JSON line per /chat turn in logs/events.jsonl, written from
// the res.json wrapper in server.js so every channel is covered without touching the bots. Each request
// gets its own event record (AsyncLocalStorage, like log-tag.js): any code serving the turn — server.js
// deterministic paths, rachel.js tool dispatch — calls note() / action() / unmatched() without threading
// state through. The wrapper fills state_out / basket_* / latency and writes. A write never blocks the
// reply; a failure is logged once and ignored. Fields that don't apply are omitted, never null.
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const FILE = process.env.RACHEL_EVENTS_FILE || require('./data-dir.js').file('events.jsonl');

// What Rachel did, strongest first: when several paths fire in one turn, the most consequential wins.
const ACTION_RANK = ['placed_order', 'generated_proposal', 'started_order', 'built_basket', 'updated_basket', 'showed_basket',
  'listed_options', 'searched', 'accepted_address', 'asked_address', 'asked_age', 'refused', 'answered'];

function run(fn) { return als.run({ ev: {}, actions: [], unmatched: [], t0: Date.now() }, fn); }
function cur() { return als.getStore(); }
function note(fields) { const s = cur(); if (s) Object.assign(s.ev, fields); }
function action(a) { const s = cur(); if (s && a && !s.actions.includes(a)) s.actions.push(a); }
function unmatched(names) { const s = cur(); if (!s) return; for (const n of [].concat(names || [])) { const t = String(n || '').trim(); if (t && !s.unmatched.includes(t)) s.unmatched.push(t); } }

function stateLabel(st) {
  if (!st) return 'age';
  if (st.orderStep) return 'order:' + st.orderStep;
  if (st.proposalStep) return 'proposal:' + st.proposalStep;
  return st.step || 'age';
}
function channelOf(format, context) {
  const c = context && context.channel;
  if (c) return String(c).toLowerCase();
  return ({ slack: 'slack', whatsapp: 'whatsapp', plain: 'email', email: 'email' })[String(format || '').toLowerCase()] || 'web';
}
function basketOf(st) {
  let items = []; try { items = JSON.parse((st && st.lastLineItems) || '[]') || []; } catch (e) {}
  const total = items.reduce((s, li) => s + (Number(li.qty || li.quantity || 1) * (parseFloat(li.price) || 0)), 0);
  return { n: items.length, total: Math.round(total * 100) / 100, sig: items.map(li => (li.product_id || li.name) + 'x' + (li.qty || li.quantity || 1)).sort().join('|') };
}

// Fallback when no path recorded an action: read it off the state transition and the reply.
function inferAction(ev, before, after, reply) {
  const r = String(reply || '');
  if (ev.state_in === 'age' && /21 or older/i.test(r)) return 'asked_age';
  if (/must be 21|can(?:'|no)t (?:help|serve|sell)|not able to (?:help|serve)/i.test(r) && ev.state_out === 'age') return 'refused';
  if (/^addr/.test(ev.state_in) && ev.state_out === 'ready') return 'accepted_address';
  if (/^addr/.test(ev.state_out) || /delivery address\?|what is your delivery address/i.test(r)) return 'asked_address';
  if (/^order:/.test(ev.state_out) && !/^order:/.test(ev.state_in)) return 'started_order';
  if (after.sig !== before.sig) return before.n === 0 ? 'built_basket' : 'updated_basket';
  if ((r.match(/^\s*\d+[.)]\s.*\$\d/gm) || []).length >= 2) return 'listed_options';
  return 'answered';
}

// Called by the wrapper with the final reply. Returns the event written (or null).
function finish({ st, stateIn, basketBefore, sessionKey, format, context, email, isQA, reply, extra, message }) {
  const s = cur();
  if (!s) return null;
  try {
    const after = basketOf(st);
    const ev = Object.assign({ ts: new Date().toISOString(), session: sessionKey, channel: channelOf(format, context) }, s.ev, extra || {});
    if (email) ev.customer = String(email).toLowerCase();
    ev.qa = !!isQA;
    ev.state_in = stateIn;
    ev.state_out = stateLabel(st);
    // intent: the classifier label when it routed, else the path that handled the turn.
    if (!ev.intent) ev.intent = ev.handled_by === 'llm' ? 'llm' : stateIn === 'age' ? 'age_gate' : /^addr/.test(stateIn) ? 'address' : /^order:/.test(stateIn) ? 'order_flow' : /^proposal:/.test(stateIn) ? 'proposal_flow' : (ev.path || 'deterministic');
    delete ev.handled_by; delete ev.path; delete ev.discussed_capture;
    const ranked = s.actions.filter(a => ACTION_RANK.includes(a)).sort((a, b) => ACTION_RANK.indexOf(a) - ACTION_RANK.indexOf(b));
    ev.action = ranked[0] || inferAction(ev, basketBefore, after, reply);
    ev.basket_items = after.n;
    ev.basket_total = after.total;
    if (s.unmatched.length) ev.unmatched = s.unmatched.slice(0, 20);
    ev.latency_ms = Date.now() - s.t0;
    if (isQA) ev.dry_run = true;
    for (const k of Object.keys(ev)) if (ev[k] === null || ev[k] === undefined || ev[k] === '') delete ev[k];
    write(ev);
    // The turn's words too (transcripts.js, DC Oct 7): every channel, every outcome — the nightly review reads them.
    s.transcribed = true;
    try { require('./transcripts.js').write({ ts: ev.ts, session: sessionKey, channel: ev.channel, customer: ev.customer, qa: ev.qa, message, reply,
      action: ev.action, intent: ev.intent, state_out: ev.state_out, basket_items: ev.basket_items, basket_total: ev.basket_total, latency_ms: ev.latency_ms }); } catch (e) { warnOnce('transcript', e); }
    return ev;
  } catch (e) { warnOnce('build', e); return null; }
}

let warned = {};
function warnOnce(k, e) { if (!warned[k]) { warned[k] = true; console.log('[events] ' + k + ' failed (logged once): ' + e.message); } }
function write(ev) { fs.appendFile(FILE, JSON.stringify(ev) + '\n', e => { if (e) warnOnce('write', e); }); }

module.exports = { run, note, action, unmatched, finish, ctx: cur, stateLabel, basketOf, channelOf, FILE, ACTION_RANK };
