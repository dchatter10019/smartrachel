// The basket line an item name refers to: WHOLE words, most of them. Real bug (Sep 30): matched on the first word
// as a substring, "La" (La Crema) hit "B-la-nc" — a swap for the never-added La Crema deleted 10x Chandon Reserve
// Blanc de Blancs and gave its stand-in Chandon's quantity. -> index or -1
// (server.js swaps/picks, proposal-options.js, rachel.js)
function basketLineFor(items, itemName) {
  const nrmW = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '').replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz)\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !/^(the|of|and|de|du|la|le|el|by)$/.test(w));
  // A line copied from Rachel's own basket ("1x Bread & Butter Pinot Grigio - 750 ML — $15.39 ea = $15.39"): the count
  // and the prices are not name words (Nov 10, DC on Claude Code: "1x ... -> can you switch with a Kendall Jackson" found
  // no basket line — 1x / 15 / 39 counted as 3 of the 7 words to match, and the swap was left to the LLM).
  const cleaned = String(itemName || '').replace(/^\s*[-•*]?\s*\d{1,3}\s*x\s+/i, '').replace(/\s*(?:[—–-]\s*)?\$\s*[\d,]+(?:\.\d+)?(?:\s*(?:ea|each)\b)?(?:\s*=\s*\$\s*[\d,]+(?:\.\d+)?)?/gi, ' ').replace(/\s+[—–-]\s*$/, '');
  const origW = nrmW(cleaned);
  if (!origW.length) return -1;
  const need = Math.min(origW.length, Math.max(2, Math.ceil(origW.length * 0.6)));
  return (items || []).findIndex(it => { const iw = new Set(nrmW(it.name || it.label)); return origW.filter(w => iw.has(w)).length >= need; });
}

module.exports = basketLineFor;
