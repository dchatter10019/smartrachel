// Edits to a quote the customer already has — decided in code, never by the LLM.
// Real case (Sep 29, Gen II Fund): Sean forwarded Natalia's reply to the proposal: "Please remove the
// following items from the order: - Cantena Malbec - Pilsener Urquell (12 pk Bottles) - Octoberfest
// Bottles - ... - Founders All Day IPA (I only need 1 case). Additionally, please remove all beer in
// bottles ... could you please resend me an updated quote?" Rachel had no deterministic path for it:
// the LLM's update_quantity tool matched names by substring (no typo tolerance: "Cantena"), had no
// "all bottled beer" rule, and nothing regenerated the PDF.
//
// parseEdits(text) -> { removes: [name], setQty: [{name, qty}], attrs: [{category, packaging}],
//                       adds: bool, wantsQuote: bool, count }
// applyEdits(items, edits) -> { items, changes: [{kind, name, from, to, why}], notFound: [name],
//                               ambiguous: [{name, options}] }
// describe(result, before, after) -> the reply text listing every change (and what wasn't found).

const PM = require('./product-match.js');

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, single: 1 };
const num = s => (/^\d+$/.test(s) ? parseInt(s, 10) : NUM[String(s).toLowerCase()]);
const NUM_RE = '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|a|an|single)';
const UNIT_RE = '(?:cases?|packs?|bottles?|cans?|boxes?|units?)';
const CAT = { beer: 'beer', beers: 'beer', wine: 'wine', wines: 'wine', spirits: 'spirits', liquor: 'spirits',
  seltzer: 'beer', seltzers: 'beer', cider: 'beer', ciders: 'beer' };

const REMOVE_VERB = /\b(?:remove|take out|take off|drop|delete|exclude|cut|leave out|get rid of|no longer need|don'?t need|do not need)\b/i;
const ADD_VERB = /\b(?:add|include|also need|also want|throw in)\b/i;
const BULLET = /^\s*(?:[-•*·–]|\d{1,2}[.)])\s+(.+?)\s*$/;

// A quantity directive inside a line: "(I only need 1 case)", "only 2", "reduce to 1", "change to 3", "just one case".
function qtyDirective(s) {
  const m = s.match(new RegExp('\\b(?:only|just)\\s+(?:need|want)?\\s*' + NUM_RE + '(?:\\s+' + UNIT_RE + ')?\\b', 'i'))
    || s.match(new RegExp('\\b(?:reduce|lower|cut|change|make|set|increase|bump)\\b[^.()]*?\\bto\\s+' + NUM_RE + '(?:\\s+' + UNIT_RE + ')?\\b', 'i'))
    || s.match(new RegExp('\\b(?:need|want)\\s+' + NUM_RE + '\\s+' + UNIT_RE + '\\b', 'i'));
  return m ? num(m[1]) : null;
}
// The product named in a list line: drop the parenthetical note and the directive words.
function itemName(s) {
  return s.replace(/\([^)]*\)/g, ' ')
    .replace(new RegExp('\\b(?:i\\s+)?(?:only|just)\\s+(?:need|want)?\\s*' + NUM_RE + '(?:\\s+' + UNIT_RE + ')?\\b.*$', 'i'), ' ')
    .replace(/\b(?:reduce|lower|change|make|set)\b.*$/i, ' ')
    .replace(/[,;:.]+\s*$/, '').replace(/\s+/g, ' ').trim();
}

function parseEdits(text) {
  const out = { removes: [], setQty: [], attrs: [], adds: false, wantsQuote: false, count: 0 };
  const t = String(text || '').replace(/\r/g, '');
  let ctx = null, inList = 0;   // ctx: 'remove' | 'add' | null — the list a bullet belongs to
  for (const raw of t.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const b = line.match(BULLET);
    if (b && ctx) {
      const q = qtyDirective(b[1]);
      const name = itemName(b[1]);
      if (!name) continue;
      inList++;
      if (ctx === 'add') out.adds = true;
      else if (q != null) out.setQty.push({ name, qty: q });
      else out.removes.push(name);
      continue;
    }
    // A line introducing a list ("Please remove the following items from the order:").
    if (REMOVE_VERB.test(line) && /(?::\s*$|\bfollowing\b|\bbelow\b|\bthese\b)/i.test(line)) { ctx = 'remove'; inList = 0; continue; }
    if (ADD_VERB.test(line) && /(?::\s*$|\bfollowing\b|\bbelow\b)/i.test(line)) { ctx = 'add'; inList = 0; continue; }
    // A paragraph after the bullets ends the list; before the first bullet it is the intro wrapping
    // ("Please remove the following\nitems from the order:").
    if (!b && inList) ctx = null;
  }
  const flat = t.replace(/\s*\n\s*/g, ' ');
  // "remove all beer in bottles", "no bottled beer", "remove any wine in cans"
  const attrRe = /\b(?:remove|take out|drop|exclude|no|without|cannot have|can'?t have)\s+(?:all|any|every)?\s*(?:of\s+)?(?:the\s+)?(?:(beers?|wines?|spirits|liquor|seltzers?|ciders?)\s+(?:that\s+(?:are|come)\s+)?in\s+(bottles|cans|glass)|bottled\s+(beers?|wines?|seltzers?|ciders?)|(beers?|wines?)\s+bottles)\b/gi;
  let m;
  while ((m = attrRe.exec(flat))) {
    const cat = CAT[String(m[1] || m[3] || m[4] || 'beer').toLowerCase()] || 'beer';
    const pack = /can/i.test(m[2] || '') ? 'can' : 'bottle';
    if (!out.attrs.some(a => a.category === cat && a.packaging === pack)) out.attrs.push({ category: cat, packaging: pack });
  }
  // Inline single edits: "remove the Catena Malbec from the order", "I only need 1 case of Founders All Day IPA".
  const inRm = /\b(?:please\s+)?(?:remove|take out|drop|delete)\s+(?:the\s+)?([^.,;:!?\n]{3,60}?)\s+from\s+(?:the|my|our|this)\s+(?:order|quote|list|basket|proposal|cart)\b/gi;
  while ((m = inRm.exec(flat))) { if (!/\b(?:all|any|following|items?|these|those|below)\b/i.test(m[1]) && !out.removes.includes(m[1].trim())) out.removes.push(m[1].trim()); }
  const inQ = new RegExp('\\b(?:only|just)\\s+(?:need|want)\\s+' + NUM_RE + '\\s+' + UNIT_RE + '\\s+of\\s+(?:the\\s+)?([^.,;:!?\\n]{3,60}?)(?=[.,;:!?\\n]|$)', 'gi');
  while ((m = inQ.exec(flat))) out.setQty.push({ name: m[2].trim(), qty: num(m[1]) });
  if (/\b(?:add|include)\b[^.]{0,60}\b(?:to the (?:order|quote|list)|as well)\b/i.test(flat)) out.adds = true;
  out.wantsQuote = /\b(?:updated|revised|new|corrected)\s+(?:quote|proposal|pdf|invoice|estimate)\b|\bre-?send\b|\bsend\b[^.]{0,20}\b(?:updated|revised)\b/i.test(flat);
  out.count = out.removes.length + out.setQty.length + out.attrs.length;
  return out;
}

// ── matching a named line to a basket item ─────────────────────────────────────────────────────────
const STOP = new Set(('a an the of and or with per case cases pack packs pk can cans bottle bottles btl oz ml l x ct ' +
  'count only please each i need want order item items').split(' '));
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const keyWords = s => [...new Set(PM.words(s).filter(w => !STOP.has(w) && !/^\d+(?:pk|oz|ml)?$/.test(w)))];
const tokEq = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);
function score(req, item) {
  const rw = keyWords(req);
  if (!rw.length) return 0;
  const iw = PM.words(item.name || item.label || '');
  return rw.filter(w => iw.some(x => tokEq(w, x))).length / rw.length;
}
const isBottle = it => /\bbottles?\b|\bbtls?\b/i.test((it.name || '') + ' ' + (it.size || ''));
const isCan = it => /\bcans?\b/i.test((it.name || '') + ' ' + (it.size || ''));
const catOf = it => String(it.category || '').toLowerCase();
const clean = n => String(n || '').replace(/\s*\*\s*$/, '').trim();

// -> { index } | { removedAlready } | { ambiguous: [names] } | null
function find(items, removed, req) {
  const hintBottle = /\bbottles?\b/i.test(req), hintCan = /\bcans?\b/i.test(req);
  const sc = items.map((it, i) => ({ i, s: score(req, it) + ((hintBottle && isBottle(it)) || (hintCan && isCan(it)) ? 0.01 : 0) }))
    .filter(x => x.s >= 0.6).sort((a, b) => b.s - a.s);
  if (!sc.length) return null;
  const top = sc.filter(x => x.s === sc[0].s);
  if (top.length > 1) return { ambiguous: top.map(x => clean(items[x.i].name)) };
  return removed.has(top[0].i) ? { removedAlready: top[0].i } : { index: top[0].i };
}

function applyEdits(items, edits) {
  const src = (items || []).map(it => Object.assign({}, it));
  const removed = new Set(), changes = [], notFound = [], ambiguous = [];
  for (const q of edits.setQty || []) {
    const f = find(src, removed, q.name);
    if (!f) { notFound.push(q.name); continue; }
    if (f.ambiguous) { ambiguous.push({ name: q.name, options: f.ambiguous }); continue; }
    if (f.removedAlready != null) continue;
    const it = src[f.index], before = it.qty || it.quantity || 1;
    if (q.qty === 0) { removed.add(f.index); changes.push({ kind: 'removed', name: clean(it.name), from: before, why: 'asked' }); continue; }
    if (before !== q.qty) { it.qty = q.qty; it.quantity = q.qty; }
    changes.push({ kind: 'qty', name: clean(it.name), from: before, to: q.qty });
  }
  for (const r of edits.removes || []) {
    const f = find(src, removed, r);
    if (!f) { notFound.push(r); continue; }
    if (f.ambiguous) { ambiguous.push({ name: r, options: f.ambiguous }); continue; }
    if (f.removedAlready != null) continue;   // two requests for one line ("Octoberfest Bottles", "Spaten Oktoberfest")
    removed.add(f.index);
    changes.push({ kind: 'removed', name: clean(src[f.index].name), from: src[f.index].qty || src[f.index].quantity || 1, why: 'asked' });
  }
  for (const a of edits.attrs || []) {
    src.forEach((it, i) => {
      if (removed.has(i)) return;
      const c = catOf(it);
      if (c && c !== a.category) return;
      if (a.packaging === 'bottle' ? isBottle(it) : isCan(it)) {
        removed.add(i);
        changes.push({ kind: 'removed', name: clean(it.name), from: it.qty || it.quantity || 1, why: (a.packaging === 'bottle' ? 'bottled ' : 'canned ') + a.category });
      }
    });
  }
  return { items: src.filter((_, i) => !removed.has(i)), changes, notFound, ambiguous };
}

const money = n => '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const total = items => Math.round((items || []).reduce((s, it) => s + (it.qty || it.quantity || 1) * (parseFloat(it.price) || 0), 0) * 100) / 100;

function describe(result, beforeItems) {
  const lines = [];
  const rm = result.changes.filter(c => c.kind === 'removed'), q = result.changes.filter(c => c.kind === 'qty');
  if (rm.length) lines.push('Removed:\n' + rm.map(c => '• ' + c.name + ' (' + c.from + ')' + (c.why !== 'asked' ? ' — ' + c.why : '')).join('\n'));
  if (q.length) lines.push('Quantity changed:\n' + q.map(c => '• ' + c.name + ': ' + (c.from === c.to ? c.to + ' (already ' + c.to + ')' : c.from + ' → ' + c.to)).join('\n'));
  if (result.notFound.length) lines.push("Not in the quote, so nothing to change: " + result.notFound.join('; ') + '.');
  if (result.ambiguous.length) lines.push(result.ambiguous.map(a => '"' + a.name + '" matches more than one line (' + a.options.join(' / ') + ') — which one should I change?').join('\n'));
  const b = total(beforeItems), a = total(result.items);
  lines.push('Updated quote: ' + result.items.length + ' line(s), product total ' + money(a) + (a !== b ? ' (was ' + money(b) + ')' : '') + '.');
  return 'Done — here are the changes to your quote:\n\n' + lines.join('\n\n');
}

module.exports = { parseEdits, applyEdits, describe, total, money };
