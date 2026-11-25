// "remove X and replace it with Y" — the Y the customer named for a basket line the edit reader took out (server.js EDIT
// READER). Nov 21 (DC, Slack, Bellevue): "remove the 19 Crimes Snoop Cali Red and replace it with La Crema Sonoma Coast.
// Additionally, can you lower the quantity to 3 bottles for Wine per selection for all Wines?" — the 19 Crimes was removed,
// La Crema only offered, and the next "Add 3 bottles of La Crema" went in at 1x. Pure functions; server.js searches + applies.

const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '');
const GENERIC = /^(the|a|an|some|wine|wines|bottle|bottles|btl|btls|of|ml|oz|instead|please|one|it)$/;
const wordsOf = s => fold(s).split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !GENERIC.test(w) && !/^\d+(?:ml|l|oz)?$/.test(w));

// The product text after "replace it/that/X with ..." (also "swap it (out) for", "switch it to"), when the replaced thing is
// a pronoun or names the removed line. '' = none.
function replacementIn(message, line) {
  const m = String(message || '').replace(/[*_`]/g, '');
  const re = /\b(?:replac(?:e|ing)|swap(?:ping)?(?:\s+out)?|switch(?:ing)?(?:\s+out)?|substitut(?:e|ing))\s+(it|that|this|them|(?:the\s+)?[^.,;!?\n]{1,60}?)\s+(?:with|for|to|by)\s+(?:a\s+|an\s+|the\s+|some\s+)?([^.,;!?\n]+?)(?=\s*(?:[.,;!?\n]|\band\b|\balso\b|\badditionally\b|\bplease\b|\binstead\b|$))/gi;
  const lineW = wordsOf(line && (line.name || line.label));
  for (const x of m.matchAll(re)) {
    const tgt = x[1].trim(), want = x[2].trim();
    const pron = /^(it|that|this|them)$/i.test(tgt);
    if (!pron && !wordsOf(tgt).some(w => lineW.includes(w))) continue;
    if (wordsOf(want).length) return want;
  }
  return '';
}

// Catalog rows that carry every distinctive word of the wanted name (one per product name).
function fitting(rows, want) {
  const ww = wordsOf(want), seen = new Set(), out = [];
  if (!ww.length) return out;
  for (const p of rows || []) {
    const n = fold(p && p.name), nw = new Set(n.split(/[^a-z0-9]+/));
    if (!n || seen.has(n)) continue;
    if (ww.every(w => nw.has(w))) { seen.add(n); out.push(p); }
  }
  return out;
}

// The count for the replacement: the one count this message set on EVERY other line of the removed line's kind (the
// edit reader's set_qty ops), else the removed line's own count.
function qtyFor(ops, removed, items) {
  const cat = String(removed && removed.category || '').toLowerCase();
  const sets = (ops || []).filter(o => o && o.op === 'set_qty' && o.item);
  const same = (items || []).filter(it => String(it.category || '').toLowerCase() === cat);
  const qs = [...new Set(sets.filter(o => String(o.item.category || '').toLowerCase() === cat).map(o => o.qty))];
  if (cat && same.length && qs.length === 1 && sets.filter(o => String(o.item.category || '').toLowerCase() === cat).length >= same.length) return qs[0];
  return parseInt(removed && (removed.qty || removed.quantity), 10) || 1;
}

// "Add 25 bottles of “Banshee” Cabernet" -> [{ qty: 25, want: 'Banshee Cabernet' }] — bottles / no unit only (a case / pack count
// is left to the pick paths, which know pack sizes). Nov 25 (DC, Slack): the edit reader read the add, nothing was shown, and the
// model asked "Shall I add 25 bottles?" on one run and added it twice on another.
function addsIn(message) {
  const m = String(message || '').replace(/[*_`]/g, ' ').replace(/[“”"‘’']/g, '');
  const out = [];
  for (const x of m.matchAll(/\badd\s+(\d{1,4})\s*(?:x\s+)?(?:(?:more\s+)?(?:bottles?|btls?|bts?)\s+)?(?:of\s+)?(?:the\s+)?([a-z][^.,;!?\n]{1,60}?)\s*(?=[.,;!?\n]|\band\b|\balso\b|\bplease\b|$)/gi)) {
    if (/^(?:cases?|packs?|cans?)\b/i.test(x[2])) continue;
    const want = x[2].replace(/\s+(?:to|on|in(?:to)?)\s+(?:the\s+)?(?:proposal|order|basket|cart|list)\b.*$/i, '').trim();
    if (wordsOf(want).length) out.push({ qty: +x[1], want });
  }
  return out;
}

module.exports = { replacementIn, fitting, qtyFor, addsIn };
