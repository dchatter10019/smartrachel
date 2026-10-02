// Per-turn basket checks, in code, before anything else reads the basket (DC, Oct 2: "this needs to be more
// deterministic"). Real case (Oct 2, DC's Goody thread, after the on-hand / original-request fixes went live):
// - the wine DC already has (La Crema, Prisoner, Conundrum — "we have the below inventory from last time") was
//   still on every PDF: the basket predated on-hand.js and nothing re-checked it
// - "Still need a substitute for: Vodka 1.75L, Lemon Juice 1L, Simple Syrup 2L" was repeated for three lines that
//   were already in the basket (Ketel One 2x, 3x lemon juice 375 mL, 3x simple syrup) — pendingSubstitutes was
//   never cleared, so Rachel offered vodkas and then called it "a system error"
// - the PDF went out billed to "Goody Dipanjan Chatterjee CEO |" — a client saved before the signature fix
//
// check(state, { originalRequest, userName }) -> { items, onHand, droppedOnHand, pendingCleared, client } (pure)
const OH = require('./on-hand.js');
const pendingOriginalByType = require('./pending-original.js');

function check(state, opts) {
  opts = opts || {};
  let items = [];
  try { items = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems || '[]') : (state.lastLineItems || []); } catch (e) {}
  if (!Array.isArray(items)) items = [];

  // 1. On-hand stock: from the messages (state.onHand) and the original request (a thread's first email).
  let onHand = (state.onHand || []).slice();
  const src = opts.originalRequest || state.originalRequest;
  if (src) for (const o of OH.parseOnHand(src)) if (!onHand.some(p => p.name.toLowerCase() === o.name.toLowerCase())) onHand.push(o);
  const droppedOnHand = [];
  if (onHand.length) {
    items = items.filter(li => {
      const o = OH.isOnHand(li && li.name, onHand);
      if (o && !li.keepOnHand) { droppedOnHand.push({ name: li.name, qty: li.qty, price: li.price, onHand: o.name }); return false; }
      return true;
    });
  }

  // 2. Pending not-carried lines that a basket line of the same kind already stands in for.
  const pending = Array.isArray(state.pendingSubstitutes) ? state.pendingSubstitutes : [];
  const pendingCleared = [];
  for (const pn of pending) {
    // A line that answers ANOTHER requested item (its label is that item: "Lime Juice 1L") never counts —
    // only a line labeled with this item, or one added by product name (label = its own name / none).
    const by = items.find(li => li && li.name && pendingOriginalByType([pn], li.name) === pn
      && (!li.label || li.label === pn || li.label === li.name || String(li.label).toLowerCase().startsWith(String(li.name).toLowerCase().slice(0, 12))));
    if (by) pendingCleared.push({ pending: pn, by: by.name });
  }

  return { items, onHand, droppedOnHand, pendingCleared, client: cleanClient(state.savedClientName, opts.userName) };
}

// A client name with the sender's signature glued on ("Goody Dipanjan Chatterjee CEO |") -> "Goody".
// Cut at the sender's own name, else at a trailing "Title |" signature fragment. Unchanged when clean.
const TITLES = /\b(?:CEO|CFO|COO|CTO|CMO|VP|SVP|EVP|Founder|Co-Founder|President|Director|Manager|Head of [A-Za-z]+|Owner|Partner)\b/;
function cleanClient(name, userName) {
  let c = String(name || '').trim();
  if (!c) return c;
  const u = String(userName || '').trim();
  if (u && u.length >= 3) {
    const i = c.toLowerCase().indexOf(u.toLowerCase());
    if (i > 0) c = c.slice(0, i);
  }
  const t = c.match(TITLES);
  if (t && /\|/.test(c.slice(t.index))) c = c.slice(0, t.index);
  c = c.replace(/[\s|,;:–—-]+$/, '').trim();
  return c || String(name).trim();
}

module.exports = { check, cleanClient };
