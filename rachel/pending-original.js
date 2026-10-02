// The pending not-carried item a product stands in for, by WHAT IT IS: the same drink type (Ketel One -> "Vodka
// 1.75L"), or, for a mixer/non-alcoholic (no drink type), a shared distinctive word ("Master Of Mixes Lemon Juice" ->
// "Lemon Juice 1L"). Exactly one, else null. Real bugs (Oct 1, DC's Goody quote): Ketel One went in at 1 bottle (the
// list said 2), and "FIJI water" was taken as the vodka's replacement ("its requested qty 2 goes to FIJI water")
// because the fallback was pendingSubstitutes[0].
function pendingOriginalByType(pending, productName) {
  const DT = require('./drink-type.js');
  const tP = DT.typeOf({ name: productName });
  const GEN = /^(?:the|and|with|bottle|bottles|liter|litre|pack|case|single|pressed|classic|natural|premium|original|mixes?|master|of|oz|ml)$/;
  const ws = x => String(x || '').toLowerCase().replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz)\b/g, ' ').split(/[^a-z]+/).filter(w => w.length >= 4 && !GEN.test(w));
  const pw = new Set(ws(productName));
  const hits = (pending || []).filter(pn => {
    const t = DT.typeOf({ name: pn });
    if (tP || t) return !!tP && t === tP;
    return ws(pn).some(w => pw.has(w));
  });
  return hits.length === 1 ? hits[0] : null;
}

module.exports = pendingOriginalByType;
