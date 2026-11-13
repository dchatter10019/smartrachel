// A count the customer gave for a GENERIC request line ("(1) Sancerre, 750 ML bottles, need 15 bottles; (2) Bordeaux red,
// ... need 12 bottles", "Prosecco – 24 bottles", "15 bottles of Sancerre") -> the product picked for it later.
// Real (Nov 13, DC on Claude Code): the Sancerre and Bordeaux picked from Rachel's lists went in at 1 each (no original
// line, and the request was one sentence, not "N x Product" lines); the proposal PDF showed 1x of each.
// Used when a pick has no basket line to replace (server.js applyBasketSubstitute, [confirm-substitute]).

const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '');
// Words that never identify the wine/product itself.
const FILLER = new Set(('need needs want we i please bottles bottle btls btl cans can units of the a an and for with ml l oz ' +
  'red white rose sparkling wine wines dry region french italian about around approx approximately each ' +
  'qty quantity x total').split(/\s+/));
// Colour words go too ("Bordeaux red" = Bordeaux), but a segment of ONLY colour words ("red") is too generic to match.

function segments(text) {
  return String(text || '')
    .split(/\n+|;|\(\d{1,2}\)|(?:^|\s)\d{1,2}[.)]\s+|(?<=[a-z)]\.)\s+(?=[A-Z])/)
    .map(s => s.trim()).filter(Boolean);
}

function countIn(seg) {
  const s = fold(seg);
  let m = s.match(/\bneed(?:s|ed)?\s+(\d{1,4})\b/) || s.match(/\b(\d{1,4})\s*(?:bottles?|btls?|cans?|units?)\b/)
    || s.match(/^\s*[-•*]?\s*(\d{1,4})\s*(?:x|×)\s+\S/) || s.match(/[–—-]\s*(\d{1,4})\s*(?:x|bottles?|btls?)?\s*$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n > 0 && n < 5000 ? n : 0;
}

function keyWords(seg) {
  return fold(seg)
    .replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz|liters?|litres?)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !FILLER.has(w));
}

// -> { qty, line } when exactly ONE counted segment of the text names this product (all its key words in the name)
function genericLineFor(text, productName) {
  const name = fold(productName);
  const hits = [];
  for (const seg of segments(text)) {
    const qty = countIn(seg);
    if (!qty) continue;
    const kw = keyWords(seg);
    if (!kw.length || kw.length > 4) continue;   // a long sentence is not one request line
    if (kw.every(w => new RegExp('\\b' + w + '\\b').test(name))) hits.push({ qty, line: seg.slice(0, 80) });
  }
  return hits.length === 1 ? hits[0] : null;
}

module.exports = { genericLineFor, segments, countIn, keyWords };
