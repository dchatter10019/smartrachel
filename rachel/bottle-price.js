// A per-bottle price the customer states for wine (or spirits): "Keep the price of the bottle around $15 a bottle",
// "the average price of the wine bottles is $15", "The bottles should not exceed $15 for wine", "less than $15 a bottle".
// Read in code and kept for the conversation (state.bottlePrice); rachel.js applies it to every custom_list / menu_build
// (wine_max_price / spirit_max_price -> buildPackage caps) and product_query search. Real (Nov 13, DC, two Eterra Kitchen
// email quotes): the price was in the first email both times; the builds picked Cloudy Bay $37, Joseph Phelps $71,
// Kim Crawford $17 — four more emails before a proposal under $15.
//
// read(text) -> { category: 'wine'|'spirits', max, min, said } | null

const NUM = '\\$\\s?(\\d{1,4}(?:\\.\\d{1,2})?)';
const PER = '(?:\\s*(?:a|per|each|\\/)\\s*(?:bottle|btl|bottles))?';
// "should not be more than", "shouldn't cost over", "not go above", "no higher than" too (Nov 14, DC: "The wines should not
// be more than $15" was not read — the proposal had Cloudy Bay $37 and Belle Glos $51).
const CAP = new RegExp('\\b(?:(?:(?:do|does|did|should|must|can|could|will|would)\\s*)?(?:not|n\'t|never)\\s+(?:be\\s+|cost\\s+|go\\s+|run\\s+|get\\s+)?(?:more|higher|pricier|over|above|beyond)(?:\\s+than)?|no (?:higher|pricier) than|(?:(?:do|does|did|should|must|can|will)? ?(?:not|n\'t|never) (?:to )?exceed|cannot exceed|can\'?t exceed|shouldn\'?t exceed|should not exceed|no more than|not more than|under|below|less than|max(?:imum)?(?: of)?|up to|at most|within|cap(?:ped)? at))\\s*' + NUM + PER, 'i');
const AROUND = new RegExp('\\baverage\\b[^$.!?]{0,40}?' + NUM + PER + '|\\bprice\\b[^$.!?]{0,30}?\\b(?:is|of|should be|at|=)\\s*' + NUM + PER + '|\\b(?:around|about|approx(?:imately)?|roughly|average(?: price)?(?: of| is| should be| around)?|avg(?: of)?|~|close to|near)\\s*' + NUM + PER, 'i');
const BOTTLE_CTX = /\b(?:prices?|priced|bottles?|btls?|wines?|prosecco|champagne|sparkling|pinot|cab(?:ernet)?|chard(?:onnay)?|sauv(?:ignon)?|merlot|rose|ros[eé]|spirits?|liquor|vodka|tequila|whiske?y|bourbon|rum|gin)\b/i;
const SPIRIT = /\b(?:spirits?|liquor|vodka|tequila|whiske?y|bourbon|rum|gin|scotch|mezcal)\b/i;
const NOT_BOTTLE = /\b(?:per (?:person|guest|head|pp)|a (?:person|guest|head)|total|budget|overall|in total|grand total|per case|a case|per pack)\b/i;

function sentences(t) {
  // single newlines are email line wraps ("the average price\nof the wine bottles is $15"); blank lines separate
  return String(t || '').replace(/\r/g, '').replace(/([^\n])\n(?=[^\n])/g, '$1 ').split(/\n+|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function read(text) {
  let found = null;
  for (const s of sentences(text)) {
    if (!BOTTLE_CTX.test(s) || NOT_BOTTLE.test(s)) continue;
    let m = s.match(CAP), kind = 'cap';
    if (!m) { m = s.match(AROUND); kind = 'around'; }
    if (!m) continue;
    const v = parseFloat(m.slice(1).find(x => x != null));
    if (!(v >= 5 && v <= 2000)) continue;
    let isSpirit = SPIRIT.test(s);
    if (!isSpirit) { try { isSpirit = !!require('./spirit-type.js').spiritType(s); } catch (e) {} }
    const category = isSpirit && !/\b(?:wines?|prosecco|champagne|pinot|cab|chard|sauv)\b/i.test(s) ? 'spirits' : 'wine';
    // "around / average $15": at or under the figure (DC: "I told you the average price ... $15" when $17 was picked,
    // then "should not exceed $15") with a floor so it is not the cheapest bottle on the shelf.
    found = kind === 'cap' ? { category, max: v, min: 0, said: s.slice(0, 100) } : { category, max: v, min: Math.round(v * 0.6 * 100) / 100, said: s.slice(0, 100) };
  }
  return found;   // the LAST statement wins (a later "not exceed $15" replaces "around $30")
}

module.exports = { read };
