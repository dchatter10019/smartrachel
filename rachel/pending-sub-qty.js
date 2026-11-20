// A swap held while Rachel asks "how many?" (applyBasketSubstitute: the original line is gone and no quantity is known).
// state.pendingSubQty = { original, replacement, price, size, at, basket } is valid for the NEXT customer message only
// (30 minutes at most): a bare whole number >= 1 completes it in code, anything else drops it. Before completing, the
// basket must be the one Rachel asked about (same lines and quantities, the original still absent). Nov 20 staging: a bare
// "5" was bound by the [qty] step to the only basket line, the Patrón, instead of the Buffalo Trace Rachel asked about.
const MAX_MS = 30 * 60 * 1000;

const nz = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// the basket's lines + quantities, order-free
function basketKey(items) {
  return (items || []).map(it => nz(it.name || it.label) + ':' + (parseInt(it.qty || it.quantity, 10) || 1)).sort().join('|');
}

// "5" / " 12 " -> the number; anything else (words, "5 bottles", 0, 2.5) -> 0
function bareQty(message) {
  const m = String(message == null ? '' : message).match(/^\s*(\d{1,4})\s*$/);
  const n = m ? parseInt(m[1], 10) : 0;
  return n >= 1 ? n : 0;
}

function make(original, replacement, price, size, items, now) {
  return { original: String(original || ''), replacement: String(replacement || ''), price: Number(price) || 0, size: String(size || ''), at: now || Date.now(), basket: basketKey(items) };
}

// The pending swap may be completed on this basket? -> { ok } | { ok: false, why }
function check(p, items, basketLineFor, now) {
  if (!p || !p.original || !p.replacement) return { ok: false, why: 'no pending swap' };
  if ((now || Date.now()) - (p.at || 0) > MAX_MS) return { ok: false, why: 'the question is over 30 minutes old' };
  if (basketKey(items) !== p.basket) return { ok: false, why: 'the basket changed since the question' };
  if (basketLineFor(items || [], p.original) >= 0) return { ok: false, why: 'the original line is back in the basket' };
  return { ok: true };
}

// The replacement among fresh catalog rows (out-of-stock rows never come back from catalog-api.js): the same name, the
// size ignored on both sides. -> row | null
function findProduct(rows, replacement) {
  const strip = s => nz(String(s || '').replace(/\s*[-—]?\s*\d+(?:\.\d+)?\s*(?:ml|l|oz|liters?|litres?)\b.*$/i, ''));
  const want = strip(replacement);
  if (!want) return null;
  return (rows || []).find(r => strip(r.name) === want) || (rows || []).find(r => { const n = strip(r.name); return n && (n.indexOf(want) === 0 || want.indexOf(n) === 0); }) || null;
}

module.exports = { basketKey, bareQty, make, check, findProduct, MAX_MS };
