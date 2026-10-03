// The customer's original request vs the basket, line by line, computed in code (rule 6). Real case (Oct 2, DC's
// Goody thread): "take my original request and this proposal and see if they are the same" was answered by the LLM
// from memory — it recommended three changes, applied one, and later called its own pending list "a system error".
// The LLM now gets this table as fact and narrates it.
//
// parseRequest(text, onHand) -> [{ text, qty, units, ml, names: [..] }]  item lines (bullets / "N x ..."), on-hand lines skipped
// compare(text, items, onHand) -> { rows: [{ asked, status: ok|short|over|missing, have, line }], extra: [names] }
// render(result) -> the table text
const DT = require('./drink-type.js');
const OH = require('./on-hand.js');

const norm = s => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/é/g, 'e');
const GENERIC = new Set(['the', 'and', 'or', 'of', 'a', 'x', 'pack', 'packs', 'case', 'cases', 'bottle', 'bottles', 'can', 'cans', 'ml', 'l', 'oz', 'liter', 'litre', 'unsweetened', 'if', 'you', 'carry', 'them']);
const words = s => norm(s).replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz|liter|litre)\b/g, ' ').split(/[^a-z0-9/']+/).map(w => w.replace(/^n\/a$/, 'na')).filter(w => w && !GENERIC.has(w) && !/^\d+$/.test(w) && w.length >= 2);

function sizeMl(s) {
  const m = norm(s).match(/(\d+(?:\.\d+)?)\s*(ml|l|oz|liter|litre)\b/);
  if (!m) return null;
  const v = +m[1], u = m[2];
  return u === 'ml' ? v : u === 'oz' ? v * 29.5735 : v * 1000;
}
function packOf(s) {
  const t = norm(s);
  const m = t.match(/(\d+)\s*x\s*\d+(?:\.\d+)?\s*oz/) || t.match(/(\d+)\s*-?\s*(?:pk|pack|ct)\b/) || t.match(/\b(\d+)pkc?\b/);
  return m ? +m[1] : 1;
}

function parseRequest(text, onHand) {
  const out = [];
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    // a bulleted line, or a quantity-led one ("5 x The Prisoner Red Blend 750 mL"). Until Oct 3 only bullets counted, so an
    // unbulleted list parsed as empty: the LLM's left-out lines were never re-added (full suite: Tito's, Lillet, Hendrick's
    // vanished from a "just beer and wine" event list without the "Left out" note naming them).
    const m = raw.match(/^\s*(?:[-•*·]|\d+[.)])\s+(.+?)\s*$/) || (/^\s*\d{1,3}\s*[x×]\s*[A-Za-z]/i.test(raw) ? [raw, raw.trim()] : null);
    if (!m) continue;
    for (let part of m[1].split(/\s\+\s/)) {
      if (onHand && OH.isOnHand(part, onHand)) continue;
      const alt = (part.match(/\((?:or\s+)?([^)]*)\)/i) || [])[1] || '';
      const orAlt = /^\s*or\b/i.test(((part.match(/\(([^)]*)\)/) || [])[1]) || '') ? alt.replace(/^\s*\d+\s*[x×]\s*/i, '') : '';
      part = part.replace(/\([^)]*\)/g, m0 => /^\(\s*or\b/i.test(m0) ? '' : ' ' + m0.slice(1, -1) + ' ').trim();
      const qm = part.match(/^\s*(\d+)\s*[x×]\s*/i);
      let qty = qm ? +qm[1] : null;
      let rest = qm ? part.slice(qm[0].length) : part;
      const isCase = /\bcase\b/i.test(rest);
      if (qty == null) qty = 1;
      const pack = /\b(\d+)\s*-?\s*packs?\b/i.test(rest) ? +rest.match(/\b(\d+)\s*-?\s*packs?\b/i)[1] : (isCase ? 24 : 1);
      const ml = sizeMl(rest);
      out.push({ text: part.replace(/\s+/g, ' ').trim(), qty, counted: !!qm, pack, units: qty * pack, ml: ml ? ml * qty * (pack > 1 ? pack : 1) : null, names: [rest].concat(orAlt ? [orAlt] : []) });
    }
  }
  return out;
}

function matchScore(name, li) {
  const w = words(name);
  if (!w.length) return 0;
  const t = ' ' + norm((li.label || '') + ' ' + (li.name || '')).replace(/[^a-z0-9/']+/g, ' ') + ' ';
  const hits = w.filter(x => t.indexOf(' ' + x + ' ') >= 0 || (x === 'na' && /\bn\/a\b|\bnon[- ]?alc/.test(t))).length;
  const tAsk = DT.typeOf({ name }), tLi = DT.typeOf({ name: li.name });
  if (tAsk && tLi && tAsk === tLi && hits === 0) return 0.5;          // "vodka" -> Ketel One
  return hits === w.length ? 1 + hits / 10 : hits / w.length >= 0.5 ? hits / w.length : 0;
}

function compare(text, items, onHand) {
  const req = parseRequest(text, onHand);
  // One-to-one: every (request row, basket line) score, strongest first; a line answers ONE row (Oct 2 replay:
  // "sparkling water" and "bottled water" both took the FIJI line and got two conflicting fixes). A row may take
  // several lines that tie on its best score ("1L lime juice + ..." split rows never share).
  const pairs = [];
  req.forEach((r, ri) => (items || []).forEach((li, i) => { const sc = Math.max(...r.names.map(n => matchScore(n, li))); if (sc > 0) pairs.push({ ri, i, sc }); }));
  pairs.sort((a, b) => b.sc - a.sc);
  const used = new Set(), bestOf = {}, rowsLines = req.map(() => []);
  for (const pr of pairs) {
    if (used.has(pr.i)) continue;
    if (bestOf[pr.ri] != null && pr.sc < bestOf[pr.ri] - 1e-9) continue;
    if (bestOf[pr.ri] == null) bestOf[pr.ri] = pr.sc;
    used.add(pr.i); rowsLines[pr.ri].push(pr.i);
  }
  const rows = req.map((r, ri) => {
    const best = rowsLines[ri];
    if (!best.length) return { asked: r.text, status: 'missing', have: '', line: null };
    const lis = best.map(i => items[i]);
    const have = lis.map(li => (li.qty || li.quantity || 1) + 'x ' + li.name).join(' + ');
    let hu = 0, hml = 0, mlKnown = true;
    for (const li of lis) {
      const q = li.qty || li.quantity || 1, p = packOf(li.name), s = sizeMl(li.name);
      hu += q * p; if (s) hml += q * p * s; else mlKnown = false;
    }
    // Units can only be counted when each line's pack is in its name ("4pk", "12x12 OZ") or it says it is a single
    // ("Btl", "Can"). "Nixie Sparkling Water - 12 OZ" at $7.34 is probably an 8-pack — never guessed (Oct 2).
    const packKnown = lis.every(li => packOf(li.name) > 1 || /\b(?:btl|bottle|single|can|each|ea)\b/i.test(li.name));
    let status = 'ok';
    if (!(r.ml && mlKnown && hml) && r.units > 1 && !packKnown) status = 'unclear';
    else if (r.ml && mlKnown && hml) status = hml < r.ml * 0.97 ? 'short' : hml > r.ml * 1.6 ? 'over' : 'ok';
    else status = hu < r.units ? 'short' : hu > r.units * 1.6 ? 'over' : 'ok';
    // One line, short: the quantity that covers the ask (same product, its pack/size) — a fix code can apply.
    let fix = null;
    if (status === 'short' && lis.length === 1) {
      const li = lis[0], q = li.qty || li.quantity || 1, per = (r.ml && mlKnown && hml) ? hml / q : hu / q;
      const need = r.ml && mlKnown && hml ? r.ml : r.units;
      const to = Math.ceil(need / per - 1e-9);
      if (per > 0 && to > q && to <= q * 50) fix = { name: li.name, from: q, to };
    }
    const amt = status === 'unclear' ? '' : (r.ml && mlKnown && hml) ? ' (' + (Math.round(hml / 10) / 100) + ' L vs ' + (Math.round(r.ml / 10) / 100) + ' L asked)' : ' (' + hu + ' unit(s) vs ' + r.units + ' asked)';
    return { asked: r.text, status, have: have + amt, line: lis.map(l => l.name), fix };
  });
  const extra = (items || []).filter((li, i) => !used.has(i)).map(li => (li.qty || li.quantity || 1) + 'x ' + li.name);
  return { rows, extra };
}

function render(c) {
  const tag = { ok: 'MATCHES', short: 'SHORT', over: 'MORE THAN ASKED', missing: 'NOT IN BASKET', unclear: 'PACK SIZE UNKNOWN' };
  return c.rows.map(r => '- ' + r.asked + ' -> ' + tag[r.status] + (r.have ? ': ' + r.have : '')).join('\n')
    + (c.extra.length ? '\n- In the basket but not in the original request: ' + c.extra.join(', ') : '');
}

// The customer's reply, written in code (Oct 2: the LLM, given the table as fact, still said the dropped wine was in
// the basket and San Pellegrino was 1x). -> { text, fixes }
function reply(c, onHand) {
  const tag = { ok: '✓', short: 'SHORT', over: 'more than asked', missing: 'NOT IN THE QUOTE', unclear: 'CHECK (the catalog name doesn\'t give the pack size)' };
  const fixes = c.rows.filter(r => r.fix).map(r => r.fix);
  const lines = c.rows.map(r => '- ' + r.asked + ' — ' + tag[r.status] + (r.have ? ': ' + r.have : '') + (r.fix ? ' → change to ' + r.fix.to + 'x' : ''));
  const bad = c.rows.filter(r => r.status !== 'ok');
  let t = 'Your original request vs the current quote:\n\n' + lines.join('\n');
  if (onHand && onHand.length) t += '\n\nNot ordered — you already have: ' + onHand.map(o => (o.qty ? o.qty + 'x ' : '') + o.name).join(', ') + '.';
  if (c.extra.length) t += '\n\nIn the quote but not in your original request: ' + c.extra.join(', ') + ' — keep or remove?';
  if (!bad.length && !c.extra.length) t += '\n\nEverything in your original request is covered.';
  if (fixes.length) t += '\n\nTo match your request I\'d change: ' + fixes.map(f => f.name + ' ' + f.from + 'x → ' + f.to + 'x').join('; ') + '. Reply "make the changes" and I\'ll update the quote.';
  const missing = c.rows.filter(r => r.status === 'missing');
  if (missing.length) t += '\n\nNot in the quote yet: ' + missing.map(r => r.asked).join(', ') + ' — want me to find options?';
  return { text: t, fixes };
}
const isCompareAsk = m => /\b(?:original|initial|first|earlier)\s+(?:request|order|list|ask|email)\b|\bwhat i (?:asked|requested)\b|\b(?:my|the)\s+request\b/i.test(m)
  && /\b(?:compare|same|match(?:es)?|check|differen\w*|missing|changes?|verify|line up|cover(?:s|ed)?)\b/i.test(m)
  && !/\b(?:add|remove|swap|replace)\b/i.test(m);
const isApplyAsk = m => String(m || '').trim().split(/\s+/).length <= 14
  && /\b(?:make|apply|do)\s+(?:the|these|those|both|all|all the|your)?\s*(?:changes|updates|fixes|recommendations)\b|^\s*(?:yes|yep|yeah|ok|okay|sure|please do|go ahead|do it|sounds good)\b/i.test(m)
  && !/\b(?:but|except|not|instead)\b/i.test(m);

// Notes on the customer's OWN request lines: "• <line of the original request> -> <verdict>". Real case (Oct 2, DC):
//   • 4 × 4-packs Bundaberg ginger beer (or 1 × 12-pack Fever-Tree) -> Bundaberg ginger beer or Fever-Tree not both
//   • 2 × 24-packs sparkling water -> Nixie Wtrmln Mint Sparkling Water - 12 OZ doesn;t look rith
//   • 1 case bottled water -> San Pellegrino Plastic (PET) - 500 ML doesn't look right
// -> [{ quote, answer, kind: 'not_both' | 'wrong' | 'other', rows: [request rows it quotes] }]
const NB = /\bnot both\b|\bonly one\b|\bone or the other\b|\beither\b/i;
function requestNotes(message, originalRequest, onHand) {
  const IN = require('./instructions.js');
  const req = parseRequest(originalRequest, onHand);
  const n = x => norm(x).replace(/[^a-z0-9]+/g, ' ').trim();
  const out = [];
  for (const raw of IN.joinArrowWraps(message).split('\n')) {
    const l = raw.replace(/^\s*(?:[-•*·–]|\d+[.)])\s*/, '').replace(/\*/g, '').trim();
    const a = l.indexOf('->');
    if (a < 0) continue;
    const quote = l.slice(0, a).trim(), answer = l.slice(a + 2).trim();
    const nq = n(quote);
    if (nq.length < 5 || n(originalRequest).indexOf(nq) < 0) continue;            // not a line of THEIR request
    const rows = req.filter(r => nq.indexOf(n(r.text)) >= 0 || n(r.text).indexOf(nq) >= 0);
    if (!rows.length) continue;
    const kind = NB.test(answer) ? 'not_both' : IN.VERDICT.test(answer) ? 'wrong' : 'other';
    out.push({ quote, answer, kind, rows });
  }
  return out;
}
// "A (or B) -> not both": keep A (the customer's first choice), remove the basket lines that are B and not A.
function applyNotBoth(items, note) {
  const removed = [];
  const r = note.rows.find(x => x.names.length > 1);
  if (!r) return { items, removed, why: 'the line has no "(or ...)" alternative' };
  const keep = (items || []).filter(li => {
    const isAlt = matchScore(r.names[1], li) >= 1, isMain = matchScore(r.names[0], li) >= 1;
    if (isAlt && !isMain) { removed.push((li.qty || li.quantity || 1) + 'x ' + li.name); return false; }
    return true;
  });
  return { items: keep, removed, main: r.names[0].replace(/^\s*\d+\s*[x×]\s*/i, '').replace(/^\d+-?packs?\s+/i, '').trim(), alt: r.names[1].trim() };
}

// The LLM's named_products checked against the customer's own lines, in code (rule 6). Real bugs (Oct 2, DC's Goody
// list, first build): "3L mango purée" -> {name: "Mango Puree", qty: 3} (3 bottles, 1.5 L); "1L lemon juice" ->
// "Lemon Juice 1L" -> UNAVAILABLE (size mismatch) with 375 mL on the shelf. A line with an amount and no count is an
// amount of liquid (np.volume_ml: any bottle size, buildPackage sizes the qty); a counted line keeps its count.
// -> [log lines]; namedProducts edited in place.
// A request row that is an instruction or a question, not a product line. Real (Oct 2, DC's Goody change email):
// "can we swap the ketel one for titos?", "remove the water case", "can we add back some wine?" were added as
// products — Owen's Transfusion, Dr Pepper, San Pellegrino, and "remove the water case isn't available".
const NOT_A_PRODUCT_LINE = /\?\s*$|^\s*(?:can|could|would|will|should|please|pls|remove|delete|drop|take|swap|switch|replace|change|add|include|make|keep|update|send|we|i|it|this|that|these|those|they|there|so|also|and|but|because|since|if|let'?s|ok|okay|thanks?)\b|\b(?:remove|swap|switch|replace|instead of|on hand|left\s*over|leftover|from last time)\b/i;
function reconcileNamed(namedProducts, text) {
  const all = parseRequest(text, OH.parseOnHand(text));
  const rows = all.filter(r => !NOT_A_PRODUCT_LINE.test(String(r.text || '')));
  if (rows.length < all.length) console.log('[list-reconcile] not product lines (instructions / questions), ignored: ' + JSON.stringify(all.filter(r => !rows.includes(r)).map(r => r.text)));
  const log = [];
  if (rows.length < 3 || !Array.isArray(namedProducts)) return log;
  const covered = new Set();
  for (const np of namedProducts) {
    if (!np || !np.name) continue;
    let best = null, bs = 0;
    for (const r of rows) { const sc = Math.max(...r.names.map(n => matchScore(n, { name: np.name }))); if (sc > bs) { bs = sc; best = r; } }
    if (!best || bs < 1) continue;
    covered.add(best);
    if (!best.counted && best.ml && best.pack === 1) {
      const was = JSON.stringify({ name: np.name, qty: np.qty });
      np.volume_ml = Math.round(best.ml);
      np.name = String(np.name).replace(/\s*\b\d+(?:\.\d+)?\s*(?:ml|l|liters?|litres?|oz)\b/ig, '').trim();
      np.qty = 1; np.qty_from_customer = true;
      log.push(JSON.stringify(best.text) + ' is an amount (' + np.volume_ml + ' mL), not a count: ' + was + ' -> ' + JSON.stringify({ name: np.name, volume_ml: np.volume_ml }));
    } else if (best.counted && np.qty != null && +np.qty !== best.qty) {
      log.push(JSON.stringify(best.text) + ' asks for ' + best.qty + ': ' + np.name + ' qty ' + np.qty + ' -> ' + best.qty);
      np.qty = best.qty; np.qty_from_customer = true;
    }
  }
  // A line of the customer's list the LLM left out is added here — never a silent drop (Oct 2: "3L mango purée"
  // was missing from the LLM's list on one run, and nothing said so).
  const llmItems = namedProducts.slice();   // only the LLM's own items say a line is covered — never one added here
  for (const r of rows) {
    if (covered.has(r)) continue;
    const part = llmItems.find(np => np && Math.max(...r.names.map(n => matchScore(n, { name: np.name }))) > 0.5);
    if (part) { log.push(JSON.stringify(r.text) + ' partly matches ' + JSON.stringify(part.name) + ' — taken as that line'); continue; }
    const isVol = !r.counted && r.ml && r.pack === 1;
    let base = r.names[0].replace(/^\s*\d+\s*[x×]\s*/i, '').replace(/^\s*(?:\d+|a|one)\s+(cases?)\s+(.+)$/i, '$2 $1');   // "1 case bottled water" -> "bottled water case"
    const packM = base.match(/\b(\d+)\s*-?\s*packs?\b/i);
    base = base.replace(/\b\d+\s*-?\s*packs?\b/ig, '');
    if (isVol) base = base.replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|liters?|litres?|oz)\b/ig, '');
    base = base.replace(/\s+/g, ' ').trim();
    if (!base) continue;
    const sizeM = isVol ? null : base.match(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz)\b/i);
    let name = sizeM ? (base.replace(sizeM[0], '').replace(/\s+/g, ' ').trim() + ' ' + sizeM[0].replace(/\s+/g, '')) : base;
    if (packM) name += ' ' + packM[1] + '-pack';
    const t = DT.typeOf({ name: base });
    const category = /\b(?:water|juice|syrup|pur[eé]e|soda|tonic|ginger beer|ginger ale|club soda|seltzer water|bitters|mixer|n\/?a|non[- ]?alc\w*)\b/i.test(base) ? 'mixer'
      : /\b(?:liqueur|triple sec|vermouth|cointreau|amaretto|schnapps)\b/i.test(base) ? 'spirits'
      : /\b(?:beer|lager|ipa|ale|stout|seltzer|cider)\b/i.test(base) ? 'beer'
      : ['red', 'white', 'rose', 'sparkling', 'fortified', 'aperitif'].indexOf(t) >= 0 ? 'wine' : t ? 'spirits' : 'mixer';
    const np = { name, category, qty: r.counted ? r.qty : 1, qty_from_customer: true };
    if (isVol) np.volume_ml = Math.round(r.ml);
    namedProducts.push(np);
    log.push(JSON.stringify(r.text) + ' was missing from the list — added ' + JSON.stringify(np));
  }
  return log;
}

module.exports = { reconcileNamed, parseRequest, compare, render, reply, isCompareAsk, isApplyAsk, requestNotes, applyNotBoth };
