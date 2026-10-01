// The basket line an item name refers to: WHOLE words, most of them. Real bug (Sep 30): matched on the first word
// as a substring, "La" (La Crema) hit "B-la-nc" — a swap for the never-added La Crema deleted 10x Chandon Reserve
// Blanc de Blancs and gave its stand-in Chandon's quantity. -> index or -1
// (server.js swaps/picks, proposal-options.js, rachel.js)
function basketLineFor(items, itemName) {
  const nrmW = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '').replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz)\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !/^(the|of|and|de|du|la|le|el|by)$/.test(w));
  const origW = nrmW(itemName);
  if (!origW.length) return -1;
  const need = Math.min(origW.length, Math.max(2, Math.ceil(origW.length * 0.6)));
  return (items || []).findIndex(it => { const iw = new Set(nrmW(it.name || it.label)); return origW.filter(w => iw.has(w)).length >= need; });
}

module.exports = basketLineFor;
