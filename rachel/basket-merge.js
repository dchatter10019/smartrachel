// A custom_list build on an EDIT turn adds to the basket — it never replaces it. Real bug (Oct 2, DC's Goody thread):
// "can we swap the ketel one for titos? / remove the water case / ... / can we add back some wine? 4 red 4 white" —
// the LLM called custom_list with only red + white wine, and that build REPLACED the 14-line quote: Don Julio,
// Flatboat, Cointreau, the mango, lime juice and every mixer were gone; the quote was $205.52 of wine and junk.
//
// mergeEdit(oldItems, newItems, message) -> null (not an edit turn: the build stands) | { items, log }
//   - every new line replaces the old line it refers to (basketLineFor), else it is added
//   - every other old line is kept
//   - "swap/switch/replace X for/with Y": X's line goes, Y's new line takes X's quantity
const basketLineFor = require('./basket-line.js');

const EDIT = /\b(?:add(?:\s+back)?|include|throw\s+in|also\s+(?:need|want|add)|swap|switch|replace|substitute|instead|more|another|extra|top\s+up)\b/i;
const FRESH = /\b(?:start\s+over|from\s+scratch|scrap\s+(?:it|that|this|the\s+(?:list|quote|order))|new\s+(?:list|order|quote)|forget\s+(?:the|my)\s+(?:list|order|quote)|replace\s+(?:the|my)\s+(?:whole|entire)|only\s+(?:these|this|the\s+following))\b/i;
const SWAP = /\b(?:swap|switch|replace|substitute|change)\s+(?:out\s+)?(?:the\s+)?([^?.!,;\n]{2,50}?)\s+(?:for|with|to)\s+(?:a\s+|an\s+|the\s+|some\s+)?([^?.!,;\n]{2,50}?)\s*(?=[?.!,;\n(]|$)/gi;

const pw = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '').replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz|pk|pack)\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !/^(?:the|of|and|ml|btl|bottle|can|cans)$/.test(w));
function sameProduct(a, b) { const A = new Set(pw(a)), B = pw(b); return B.length > 0 && A.size === new Set(B).size && B.every(w => A.has(w)); }

function swapsIn(message) {
  const out = []; let m;
  SWAP.lastIndex = 0;
  while ((m = SWAP.exec(String(message || '')))) out.push({ from: m[1].trim(), to: m[2].trim() });
  return out;
}

function mergeEdit(oldItems, newItems, message) {
  const msg = String(message || '');
  if (!Array.isArray(oldItems) || oldItems.length < 2 || !Array.isArray(newItems) || !newItems.length) return null;
  if (!EDIT.test(msg) || FRESH.test(msg)) return null;
  const items = oldItems.map(li => Object.assign({}, li));
  const log = [];
  // Swaps first: X's line leaves; the new line for Y (in this build) takes X's quantity.
  const swapQty = new Map();
  for (const sw of swapsIn(msg)) {
    const xi = basketLineFor(items, sw.from);
    const yi = basketLineFor(newItems, sw.to);
    if (xi < 0) { log.push('swap ' + JSON.stringify(sw.from) + ' -> ' + JSON.stringify(sw.to) + ': no basket line for ' + JSON.stringify(sw.from) + ' — left as is'); continue; }
    if (yi < 0) { log.push('swap ' + JSON.stringify(sw.from) + ' -> ' + JSON.stringify(sw.to) + ': this build has no ' + JSON.stringify(sw.to) + ' — ' + items[xi].name + ' kept'); continue; }
    const x = items.splice(xi, 1)[0];
    swapQty.set(yi, x.qty);
    log.push('swap: ' + x.qty + 'x ' + x.name + ' -> ' + newItems[yi].name + ' at its qty ' + x.qty);
  }
  newItems.forEach((nl, k) => {
    const line = Object.assign({}, nl);
    if (swapQty.has(k)) line.qty = swapQty.get(k);
    // The same PRODUCT (same words, size aside) — never "shares 2 words": "Troublemaker Red Wine" is not "Prisoner Red Wine".
    const at = swapQty.has(k) ? -1 : items.findIndex(o => o.name === line.name || sameProduct(o.name, line.name));
    if (at >= 0) { log.push('updated: ' + items[at].qty + 'x ' + items[at].name + ' -> ' + line.qty + 'x ' + line.name); items[at] = line; }
    else { log.push('added: ' + line.qty + 'x ' + line.name); items.push(line); }
  });
  return { items, log };
}

module.exports = { mergeEdit, swapsIn };
