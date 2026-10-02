// Stock the customer says they already have is NOT ordered (DC, Oct 2). Real case (Oct 1, DC's Goody quote):
// "**Wine** we have the below inventory from last time if you can please adjust the proposal accordingly" +
// 2 La Crema / 1 Prisoner / 2 Conundrum — Rachel's reply said "existing inventory, not ordered" yet every PDF
// charged $178.45 for those 5 bottles.
//
// parseOnHand(text) -> [{ name, qty }]  the listed lines under an "we have ... (inventory / from last time / on hand)" intro
// isOnHand(productName, onHand) -> the on-hand entry it matches, or null

const INTRO = /\b(?:we|i)\s+already\s+have\b|\b(?:we|i)\s+(?:already\s+|still\s+)?have\b[^\n]{0,80}?\b(?:inventory|left\s*over|leftover|from\s+(?:last|the\s+last|our\s+last|previous)|on\s+hand|in\s+stock|already)\b|\b(?:existing|current|leftover|left-over)\s+(?:inventory|stock)\b|\bon\s+hand\b/i;
const ITEM = /^\s*(?:[-•*·]|\d+[.)])\s+(.+?)\s*$/;              // a bullet / numbered line
const HEADER = /^\s*(?:\*\*[^*]+\*\*|[A-Z][A-Za-z /&]{2,30}:)/;   // "**Mixers & N/A**", "Spirits:"

function cleanName(s) {
  return String(s || '').replace(/^\s*(\d+)\s*(?:x|×)?\s*/i, '')
    .replace(/^(?:bottles?|cans?|cases?|packs?)\s+(?:of\s+)?/i, '')
    .replace(/\b(?:bottles?|cans?)\s+(?:of\s+)?/i, '').trim();
}

function parseOnHand(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!INTRO.test(lines[i]) || ITEM.test(lines[i])) continue;
    // the intro may wrap over 2-3 lines before the list starts
    let j = i + 1;
    while (j < lines.length && !ITEM.test(lines[j]) && !HEADER.test(lines[j]) && j <= i + 4) j++;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const m = l.match(ITEM);
      if (!m) break;                                  // the list ended (next section / prose)
      const q = m[1].match(/^\s*(\d+)\b/);
      const name = cleanName(m[1]);
      if (name) out.push({ name, qty: q ? +q[1] : null });
    }
    i = j - 1;
  }
  return out;
}

const STOP = new Set(['the', 'a', 'of', 'and', 'bottle', 'bottles', 'can', 'cans', 'case', 'cases', 'pack', 'ml', 'l', 'oz', 'wine', 'white', 'red']);
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w) && !/^\d+$/.test(w));

function isOnHand(productName, onHand) {
  const pw = new Set(words(productName));
  for (const o of onHand || []) {
    const ow = words(o.name);
    if (ow.length && ow.every(w => pw.has(w))) return o;
  }
  return null;
}

module.exports = { parseOnHand, isOnHand };
