// EDIT READER — the model reads a basket change, the code checks it and makes it (DC, Nov 14: "why aren't you using a llm to
// parse the intent and then call the appropriate code ... yes build it"). Same day, two regex readers misread DC's email:
//  - "Yes do that" to "Want me to swap the Cloudy Bay out for the Nicolas Idiart Sancerre and regenerate the proposal?" ADDED
//    the Sancerre and asked "How many bottles?" (swap-target.js read the new wine as the line);
//  - "Take out the cloudy bay and regenerate the proposal." re-sent the PDF with the Cloudy Bay (quote-edits.js took "cloudy bay
//    and regenerate the proposal" as the name) — while the classifier HAD read remove_item 0.92, unused.
//
// ONE forced-tool Sonnet 4.6 call (like fact-reader.js; memoized per message + basket + Rachel's last reply; 8s timeout) sees the
// customer's message, Rachel's last reply, the basket as numbered lines (L1..) and the products Rachel just showed (P1..), and
// returns OPERATIONS that point at those numbers — never free product names:
//   remove {line} · set_qty {line, qty} · units {line, qty: single bottles/cans of a pack line — the CODE converts} ·
//   replace {line, product, qty?} · add {product, qty}
// plus regenerate_proposal and `also` (what else the message asks: fees / order / proposal / question / search / other).
// server.js EDIT READER validates every op (the line / product exists, qty 1..2000, one op per line, a replacement is not the
// line itself) — one bad op = the whole reading is dropped and the code's own readers run as before — then applies them with
// the existing functions (applyBasketSubstitute, the basket lines, quotePdf) and logs [edit-reader]. The regex readers are the
// fallback (no answer / timeout / invalid); where they would have read something else it is recorded (gap() -> self-corrections
// kind reader_gap -> monitor -> nightly fixer).
//
// read(message, { basket, lastReply, shown, qa }) -> Promise<{ ops, regenerate_proposal, also } | null>

const MODEL = process.env.RACHEL_EDIT_MODEL || 'claude-sonnet-4-6';

const SYSTEM = `You read ONE message a customer sent to a beverage-ordering assistant (Rachel) and report the changes it makes to the customer's basket. You do not reply to the customer.
You get: Rachel's last message, the basket as numbered lines (L1, L2, ...), and products Rachel just showed or offered (P1, P2, ...). Report ONLY changes the customer asks for or agrees to, pointing at those numbers:
- remove {line}: take a basket line out ("take out the cloudy bay", "drop the Stella", "we don't need the rosé").
- set_qty {line, qty}: change how many of a line — also a line the customer lists under "remove" but with a new count ("remove the following: - Whitehaven (I only need 2 bottles)" -> set_qty Whitehaven 2, NOT remove) ("make the Tito's 6", "only 2 cases of Stella" when Stella is 1 case a line -> qty 2). qty is the number of basket units of that line (cases/packs for a pack line; bottles otherwise), as the customer states it.
  A count added ON TOP of a line ("another 167 bottles", "167 more", "plus 20 for the welcome drink") is set_qty to the new TOTAL: the line's count (or the new base count the same message sets) + the extra ("puts another 167 bottles on the order ... reduce the Prosecco from 50 to 30" -> set_qty Prosecco 197).
- units {line, qty}: the customer counts SINGLE bottles/cans of a PACK line ("we need 24 bottles not 4 cases" on "4x Goose Island IPA 12 x 12 OZ") -> units {line, qty: 24}. Copy their count; never convert it to packs yourself.
- replace {line, product, qty?}: swap a basket line for a shown product. qty only when the customer states a new count; otherwise omit it (the line keeps its quantity).
- add {product, qty}: add a shown product as a NEW line (qty = the count the customer states; 0 if they state none).
A REVISED LIST of drink types + counts — typed, or in an email the sender forwards asking to apply it ("please revise as follows: White – Pinot Grigio or Sauvignon Blanc 8 / Red – Pinot Noir 6 / Prosecco 5", "new numbers: Prosecco 15 bottles") — is set_qty on the basket line of each type (its grape / style / colour, e.g. "Red – Pinot Noir" = the Pinot Noir line). "A or B" with a basket line that is A or B = that line, kept (set_qty; never replace it with the other). A type with no basket line is "search" in also; a line the revised list leaves out is unchanged unless the customer says to remove it.
A "yes" / "do that" / "sounds good" to a change Rachel offered in her last message = that change (e.g. Rachel: "Want me to swap the Cloudy Bay out for the Nicolas Idiart Sancerre?" + customer: "yes" -> replace {line: <Cloudy Bay's line>, product: <the Sancerre's P number>}). Rachel offering to swap X for Y means X is the basket line and Y is the new product.
Never invent a line or product number. A product that is not in the P list cannot be added or swapped in: put "search" in also instead. A price limit per bottle ("wines under $15") is not an op: put "other" in also.
regenerate_proposal = true when the customer asks for a new/updated/regenerated proposal, PDF or quote, or says yes to Rachel's offer that included regenerating it.
also = everything else the message asks for, from: "fees" (tax, tip, service charge, delivery fee, free delivery), "order" (place / create the order, checkout, payment link), "proposal" (a proposal is asked but nothing else changes), "question" (asks something), "search" (wants a product that is not in the P list, or alternatives/options), "details" (address, date, time, client, contact, delivery instructions), "other" (any other REQUEST). Statements, thanks and comments ("Everything looks good except for the beer", "thanks!", "perfect") are not requests — never "other". Empty when the message asks nothing else.
If the message is not about the basket at all, return ops: [] .
Answer by calling the edits tool once.`;

const TOOL = { name: 'edits', description: 'The basket changes the customer message makes.', input_schema: { type: 'object', properties: {
  ops: { type: 'array', items: { type: 'object', properties: {
    op: { type: 'string', enum: ['remove', 'set_qty', 'replace', 'add', 'units'] },
    line: { type: 'integer', description: 'basket line number (L#)' },
    product: { type: 'integer', description: 'shown product number (P#)' },
    qty: { type: 'integer' } }, required: ['op'] } },
  regenerate_proposal: { type: 'boolean' },
  also: { type: 'array', items: { type: 'string', enum: ['fees', 'order', 'proposal', 'question', 'search', 'details', 'other'] } } },
  required: ['ops'] } };

// Worth a call? A basket, and wording that can change it or accept an offer. ("2" after a numbered list, product lists and
// whole new requests keep their own deterministic paths.)
// "revise / update / adjust / new numbers / quantities" too (Nov 16, DC forwarding Bella: "update the original proposal" +
// "please revise as follows: White – Pinot Grigio or Sauvignon Blanc 8 / Red – Pinot Noir 6 / Prosecco 5" was rebuilt by the model
// from scratch, which swapped the quote's Sauvignon Blanc for a Pinot Grigio).
const EDIT_WORDS = /\b(?:revise[ds]?|revision|update[ds]?|adjust(?:ed|ments?)?|new (?:numbers|quantities|counts)|quantit(?:y|ies)|remove|take (?:out|off)|drop|delete|get rid of|without|no (?:more|need)|don'?t (?:need|want)|do not (?:need|want)|swap|switch|replace|substitute|instead|change|make (?:it|that|them|those|the|this)|only|just|increase|decrease|reduce|bump|lower|more|less|fewer|add|include|go with|keep|cut|exclude|leave out)\b/i;
const YES = /^\W*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|sounds good|looks good|perfect|great|go ahead|please do|do (?:it|that|those|these|so)|let'?s do (?:it|that)|approved?|confirmed?|that works|works for me)\b/i;
const OFFER = /\b(?:swap|switch|replace|substitut|go with|use|change|instead|in place of|add)\w*\b[^?\n]*\?/i;
function wants(message, ctx = {}) {
  const m = String(message || '').trim();
  if (!m || m.length > 1500 || !(ctx.basket || []).length) return false;
  if (/^[\d\s,.#&+-]*(?:and)?[\d\s,.#&+-]*$/i.test(m)) return false;   // a bare pick ("2", "1, 4, 7") — the pick paths
  return EDIT_WORDS.test(m) || (YES.test(m) && OFFER.test(String(ctx.lastReply || '')));
}

const money = n => '$' + (Number(n) || 0).toFixed(2);
// The products to show the model: those Rachel's last reply names (or offered: pendingAddOffer), else the newest shown.
function shownFor(shown, lastReply, offer) {
  const nz = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ');
  const reply = nz(lastReply);
  const key = p => nz(p.name).split(/\s+/).filter(w => w.length >= 3 && !/^(?:the|and|750|ml|bottle|bottles|pack)$/.test(w)).slice(0, 2);
  let list = (shown || []).filter(p => p && p.name && key(p).length && key(p).every(w => reply.includes(w)));
  if (!list.length) list = (shown || []).filter(p => p && p.name).slice(-15);
  if (offer && offer.name && !list.some(p => nz(p.name) === nz(offer.name))) list.push({ name: offer.name, price: offer.price, size: offer.size });
  const seen = new Set();
  return list.filter(p => { const k = nz(p.name); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
}

function prompt(message, basket, lastReply, shown) {
  return 'Rachel\'s last message:\n"""\n' + String(lastReply || '(none)').slice(-2500) + '\n"""\n\nBasket:\n'
    + basket.map((li, i) => 'L' + (i + 1) + ': ' + (li.qty || li.quantity || 1) + 'x ' + String(li.name || li.label || '') + ' — ' + money(li.price) + ' ea').join('\n')
    + '\n\nProducts Rachel just showed or offered:\n' + (shown.length ? shown.map((p, i) => 'P' + (i + 1) + ': ' + p.name + (p.price ? ' — ' + money(p.price) : '')).join('\n') : '(none)')
    + '\n\nCustomer message:\n"""\n' + String(message).slice(0, 1500) + '\n"""';
}

const memo = new Map();
async function callModel(user, opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 8000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, temperature: 0, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [TOOL], tool_choice: { type: 'tool', name: 'edits' }, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) { console.log('[edit-reader] model error ' + r.status + ': ' + JSON.stringify(j).slice(0, 160)); return null; }
    try { require('./ai-spend.js').record('edit-reader', MODEL, j.usage, { qa: opts.qa }); } catch (e) {}
    const use = (j.content || []).find(c => c.type === 'tool_use' && c.name === 'edits');
    return use && use.input && typeof use.input === 'object' ? use.input : null;
  } catch (e) {
    console.log('[edit-reader] no answer (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ') — the code\'s readers decide');
    return null;
  } finally { clearTimeout(timer); }
}

// -> { ops, regenerate_proposal, also, shown } | null. ctx.basket = the live basket lines; ctx.shown = products just shown.
function read(message, ctx = {}) {
  if (!wants(message, ctx)) return Promise.resolve(null);
  const basket = ctx.basket || [], shown = shownFor(ctx.shown, ctx.lastReply, ctx.offer);
  const user = prompt(message, basket, ctx.lastReply, shown);
  const now = Date.now();
  for (const [k, v] of memo) if (now - v.at > 10 * 60000) memo.delete(k);
  if (!memo.has(user)) {
    const p = callModel(user, ctx).then(r => {
      if (!r) return null;
      const out = { ops: Array.isArray(r.ops) ? r.ops : [], regenerate_proposal: !!r.regenerate_proposal, also: Array.isArray(r.also) ? r.also : [], shown };
      console.log('[edit-reader] read: ' + JSON.stringify({ ops: out.ops, regenerate_proposal: out.regenerate_proposal, also: out.also }));
      return out;
    });
    memo.set(user, { at: now, p });
  }
  return memo.get(user).p;
}

// Does the message name this basket line right after a replace cue ("instead of", "in place of", "replace", "swap (out)",
// "switch")? The line's distinctive words (brand / name, not type, colour or size words) within the next 8 words of that sentence.
const REPLACE_CUE = /\b(?:instead\s+of|in\s+place\s+of|replace|swap(?:\s+out)?|switch(?:\s+out)?)\b/gi;
const LINE_GENERIC = /^(?:wine|wines|vodka|tequila|gin|rum|whiskey|whisky|bourbon|scotch|beer|white|red|rose|superior|blanco|silver|reserve|estate|bottles?|cans?|pack|case|cases|with|from|that|this|those|these|them|ml|oz)$/;
function wantsReplaced(message, line) {
  const nrm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '');
  const lineW = nrm(line && (line.name || line.label)).replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz)\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !/^\d+$/.test(w) && !LINE_GENERIC.test(w));
  if (!lineW.length) return false;
  const msg = nrm(message);
  for (const m of msg.matchAll(REPLACE_CUE)) {
    const after = msg.slice(m.index + m[0].length).split(/[.!?;\n]/)[0].split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8);   // this sentence only
    if (after.some(w => lineW.includes(w))) return true;
  }
  return false;
}

// The model's ops checked against the basket and the shown products. -> { ok, ops: [{op, index, item, product, qty}], why }
function validate(reading, basket, message) {
  if (!reading) return { ok: false, why: 'no reading' };
  const ops = [], used = new Set(), shown = reading.shown || [];
  const nz = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const o of reading.ops || []) {
    const kind = o && o.op;
    if (!['remove', 'set_qty', 'replace', 'add', 'units'].includes(kind)) return { ok: false, why: 'unknown op ' + JSON.stringify(o) };
    let index = -1, product = null;
    if (kind !== 'add') {
      index = (parseInt(o.line, 10) || 0) - 1;
      if (index < 0 || index >= basket.length) return { ok: false, why: kind + ': no basket line L' + o.line };
      if (used.has(index)) return { ok: false, why: 'two changes to L' + o.line };
      used.add(index);
    }
    if (kind === 'replace' || kind === 'add') {
      const pi = (parseInt(o.product, 10) || 0) - 1;
      // An ADD of a product not shown yet ("Add 25 bottles of Banshee Cabernet") is a search for the model — the reading's other
      // ops still stand (Nov 25, DC on Slack: the whole reading — two removals + Prosecco 197 — was dropped for that one add).
      if ((pi < 0 || pi >= shown.length) && kind === 'add') { console.log('[edit-reader] add P' + o.product + ' NOT applied - no such shown product; left to the model as a search'); reading.also = [...new Set([].concat(reading.also || [], 'search'))]; continue; }
      if (pi < 0 || pi >= shown.length) return { ok: false, why: kind + ': no shown product P' + o.product };
      product = shown[pi];
      if (kind === 'replace' && nz(product.name) === nz(basket[index].name)) return { ok: false, why: 'replace: P' + o.product + ' is already line L' + o.line };
    }
    let qty = o.qty == null ? null : parseInt(o.qty, 10);
    if (qty != null && (!(qty >= 0) || qty > 2000)) return { ok: false, why: kind + ': quantity ' + o.qty };
    if (kind === 'set_qty' && !(qty >= 1)) return { ok: false, why: 'set_qty without a quantity (use remove for 0)' };
    if (kind === 'units') {
      // the code converts single bottles / cans to packs: ceil(count / pack size), the pack size read from the line's name
      const nm = String(basket[index].name || '') + ' ' + String(basket[index].size || '');
      const pm = nm.match(/\b(\d{1,2})\s*(?:x|pk\b|pack\b|-pack\b)/i) || nm.match(/\((\d{1,2})pk/i);
      const pack = pm ? parseInt(pm[1], 10) : 0;
      if (!(qty >= 1)) return { ok: false, why: 'units without a count' };
      if (!(pack > 1)) return { ok: false, why: 'units on L' + o.line + ', which is not a pack line' };
      ops.push({ op: 'set_qty', index, item: basket[index], product: null, qty: Math.ceil(qty / pack), units: { count: qty, pack } });
      continue;
    }
    // A pack line's quantity is PACKS. A count the customer gave in single bottles / cans ("we need 24 bottles not 4 cases") is
    // never a pack count — the units reader (quote-edits.js) converts it (Nov 14: the model set 24 x 12-packs = 288 bottles).
    if ((kind === 'set_qty' || (kind === 'replace' && qty)) && index >= 0 && /\b\d{1,2}\s*(?:x|pk|pack)\s*\d|\b\d{1,2}\s*-?\s*pack\b|\(\d+pk/i.test(String(basket[index].name || '') + ' ' + String(basket[index].size || ''))
        && new RegExp('\\b' + qty + '\\s*(?:x\\s*)?(?:single\\s+)?(?:bottles?|cans?|btls?)\\b', 'i').test(String(message || ''))) {
      return { ok: false, why: kind + ' L' + o.line + ' to ' + qty + ': the customer counted single bottles/cans of a pack line (the units reader converts it)' };
    }
    // A line the customer wants REPLACED by something not chosen yet ("Instead of the Bacardi I'd like a higher end bourbon,
    // same 5 bottles — show me a few options") is not a removal: it stays, and the pick replaces it at its quantity through
    // the normal path. Nov 20 nightly (pick-plus-question / F-0016): the model read "remove", the 5x Bacardi was deleted and
    // the Buffalo Trace picked next went in at 1x. Only when the reading adds nothing that could be its replacement.
    if (kind === 'remove' && !(reading.ops || []).some(x => x && x.op === 'add') && wantsReplaced(message, basket[index])) {
      console.log('[edit-reader] remove L' + o.line + ' NOT applied - customer wants it replaced (' + basket[index].name + ')');
      continue;
    }
    // "They already have White Claw + Yuengling, so remove these" removes nothing else (Nov 25, on-hand.js removalAllowed).
    if (kind === 'remove') {
      const ra = require('./on-hand.js').removalAllowed(message, basket[index].name);
      if (!ra.ok) { console.log('[edit-reader] remove L' + o.line + ' NOT applied - ' + ra.why); reading.onHandKept = (reading.onHandKept || []).concat(basket[index].name); continue; }
    }
    if (kind === 'replace' && qty === 0) qty = null;
    // A revised list repeats lines that keep their count ("Red – Pinot Noir 6" on a 6x line): no change, not "6 -> 6" (Nov 16).
    if (kind === 'set_qty' && index >= 0 && qty === parseInt(basket[index].qty || basket[index].quantity || 0, 10)) { console.log('[edit-reader] set_qty L' + o.line + ' to ' + qty + ' skipped — already ' + qty); continue; }
    ops.push({ op: kind, index, item: index >= 0 ? basket[index] : null, product, qty });
  }
  return { ok: true, ops };
}

// What the code's own regex readers would have done, for the disagreement record (fallback stays the regexes).
function regexView(message, basket, lastReply) {
  const out = { removes: [], setQty: [], swapLine: null };
  try {
    const QE = require('./quote-edits.js'); const e = QE.parseEdits(message); const r = QE.applyEdits(basket, e);
    for (const c of r.changes) if (c.kind === 'removed') out.removes.push(c.name); else if (c.to != null) out.setQty.push(c.name + '->' + c.to);
  } catch (e) {}
  try { const t = require('./swap-target.js').swapTarget(lastReply, basket, ''); if (t && t.index >= 0) out.swapLine = t.name; } catch (e) {}
  return out;
}
function disagreement(ops, rv) {
  const nz = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const mRem = ops.filter(o => o.op === 'remove').map(o => nz(o.item.name)).sort().join('|');
  const rRem = rv.removes.map(nz).sort().join('|');
  const diffs = [];
  if (mRem !== rRem) diffs.push('removes: model ' + JSON.stringify(ops.filter(o => o.op === 'remove').map(o => o.item.name)) + ' vs code ' + JSON.stringify(rv.removes));
  const rep = ops.find(o => o.op === 'replace');
  if (rep && rv.swapLine && nz(rv.swapLine) !== nz(rep.item.name)) diffs.push('swap line: model ' + JSON.stringify(rep.item.name) + ' vs code ' + JSON.stringify(rv.swapLine));
  return diffs;
}

module.exports = { read, wants, validate, wantsReplaced, regexView, disagreement, shownFor, prompt, SYSTEM };
