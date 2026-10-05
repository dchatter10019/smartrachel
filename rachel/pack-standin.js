// Pack stand-ins: a replacement in a different pack size keeps the number of units the customer asked for.
// "2 x Stella 24 x 11 oz" with only "Stella 12pk 11.2 oz" here = 4 twelve-packs, not 1 (Oct 5: the customer picked
// the 12-pack from Rachel's list and the basket got 1x; the LLM only ASKED whether to make it 4).
// Used by server.js applyBasketSubstitute (every pick / swap path). buildPackage has its own copy for built lists.

// "24 x 11 oz", "12 x 12 OZ Cans", "12pk 11.2 OZ", "6PKC 12 OZ", "24 pack" -> { count, size, unit } (size/unit may be null)
function parsePack(s) {
  const t = String(s || '').toLowerCase();
  let m = t.match(/(\d+)\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*(oz|ml)\b/);
  if (m) return { count: +m[1], size: +m[2], unit: m[3] };
  m = t.match(/(\d+)\s*-?\s*(?:pk|pack)[cbs]?\b/);
  if (!m) return null;
  const sz = t.match(/(\d+(?:\.\d+)?)\s*(oz|ml)\b/);
  return { count: +m[1], size: sz ? +sz[1] : null, unit: sz ? sz[2] : null };
}

// How many replacement packs cover `qty` of the original packs. null = not a pack swap this rule handles (no pack on
// either side, same count, a single can, or containers more than 10% apart — 11 oz vs 12 oz counts as the same,
// 12 oz vs 24 oz does not). A requested pack with no container size ("24 pack") takes any container.
function packStandInQty(originalText, qty, replacementText) {
  const o = parsePack(originalText), r = parsePack(replacementText);
  if (!o || !r || o.count <= 1 || r.count <= 1 || o.count === r.count) return null;
  if (o.size && r.size && (o.unit !== r.unit || Math.abs(o.size - r.size) / Math.max(o.size, r.size) > 0.1)) return null;
  const q = Math.max(1, Math.ceil(((qty || 1) * o.count) / r.count - 0.02));
  return { qty: q, from: o.count, to: r.count };
}

// The customer's own line that the replacement stands in for, when no original was named: a counted line with a pack
// size whose brand word (the replacement's first word of 3+ letters) appears in it and which is not the replacement
// itself. lines = the customer's recent message lines, newest first. -> { name, qty } or null.
function requestedPackLine(lines, replacementName) {
  const nrm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '');
  const brand = (nrm(replacementName).split(/[^a-z0-9]+/).find(w => w.length >= 3 && !/^\d/.test(w))) || '';
  if (!brand) return null;
  const rp = parsePack(replacementName);
  for (const raw of lines) {
    const q = String(raw || '').match(/^\s*[-•*]?\s*(\d{1,4})\s*(?:x|×)?\s+(.+)$/i);
    if (!q) continue;
    const name = q[2].trim(), p = parsePack(name);
    if (!p || !new RegExp('\\b' + brand + '\\b').test(nrm(name))) continue;
    if (rp && rp.count === p.count) continue;
    return { name, qty: parseInt(q[1], 10) };
  }
  return null;
}

module.exports = { parsePack, packStandInQty, requestedPackLine };
