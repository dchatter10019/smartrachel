// Order wording that is NOT a checkout (Oct 27, connector, DC): "Here is what I want to order:" + a 5-line list
// started checkout on an OLD saved basket ($1,175 of wines that weren't his; the CTA layer also took it as a "yes" to
// "ready to place the order?"), and "...rebuild it with only: A x2, B x1... Do not place the order yet" restarted it.
// A negated order phrase is no order; a message carrying its own item list is a build of THAT list (the reply then
// offers the order), never a checkout of whatever basket is saved.

function orderNegated(message) {
  return /\b(?:don'?t|do\s+not|not\s+yet|no\s+need\s+to|before\s+(?:you|we|i))\b[^.\n]{0,25}\b(?:place|order|buy|purchase|check ?out|submit)/i.test(String(message || ''));
}

// Item lines: bullet lines / "2 x Product" lines, or inline "Product x2" / "2 x product" quantities.
function ownListCount(message) {
  const m = String(message || '');
  return Math.max(
    m.split(/\n/).filter(l => /^\s*(?:[-•*·]\s*\S|\d+\s*(?:x|×)\s+\S)/i.test(l)).length,
    (m.match(/(?:\bx\s?\d+\b|\b\d+\s?x\s+[a-z])/gi) || []).length);
}

// Order words here are not "place the order" for the saved basket.
function notACheckout(message) {
  return orderNegated(message) || ownListCount(message) >= 2;
}

// A message that is ONLY a product list (+ a short intro / "do not order yet" sentence) -> named_products read in code
// (original-compare.js namedFromListLine, the reader rachel_proposal_from_list uses), else null and the LLM handles it.
// DC (Oct 28): "make this behaviour deterministic" — the list is built by code, not by the model choosing a tool call.
// Anything that needs judgment stays with the LLM: a question, an event (guests / hours / budget), a proposal, stock on
// hand, a swap / removal / alternative, or a line that isn't a product line.
const ITEM_LINE = /^\s*(?:[-•*·]\s*\S|\d{1,4}\s*(?:x|×)\s+\S|\d{1,4}\s+cases?\s+(?:of\s+)?\S)|\S.*\s[x×]\s?\d{1,4}\s*$/i;
const NEEDS_JUDGMENT = /\?|\b(?:guests?|people|persons?|attendees|hours?|budget|event|party|wedding|reception|proposal|pdf|quote|estimate|we have|on hand|already (?:have|got)|in stock at|swap|switch|instead|replace|substitute|remove|without|except|cheaper|recommend|suggest|similar|alternatives?|options?|pair(?:ing)? with|cocktails?)\b/i;

function listItems(message) {
  const m = String(message || '').replace(/-&gt;|->/g, ' -> ');
  if (/->/.test(m) || NEEDS_JUDGMENT.test(m)) return null;
  const OC = require('./original-compare.js');
  const lines = m.split(/\n/).map(l => l.trim()).filter(Boolean);
  let itemLines = lines.filter(l => ITEM_LINE.test(l));
  let other = lines.filter(l => !ITEM_LINE.test(l));
  if (itemLines.length < 2) {
    // Inline: "... with only: Tito's 750ml x3, Stella Artois 12 pack x1. Do not place the order yet."
    const im = m.match(/:\s*([^:\n]*?[x×]\s?\d[^:\n]*?)(?:\.(?=\s+[A-Z])|\.?\s*$|\n)/);
    if (!im) return null;
    const parts = im[1].split(/\s*,\s*|\s+and\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 2 || !parts.every(x => ITEM_LINE.test(x))) return null;
    itemLines = parts;
    other = [m.replace(im[1], ' ')];
  }
  // The rest is an intro / instruction, not more products: short, no digits that could be a quantity.
  if (other.join(' ').length > 400 || other.some(l => /\b\d+\s*(?:x|bottles?|cases?|cans?|packs?)\b/i.test(l))) return null;
  const named = [];
  for (const l of itemLines) {
    const np = OC.namedFromListLine(l);
    if (!np || !np.name || np.name.length < 3) return null;
    // Unsure lines stay with the LLM: "a case" (beer 24 vs wine 12) and a product the reader filed as a mixer only because
    // it didn't know the brand ("2 cases of Stella" -> mixer "Stella case").
    if (/\bcases?\b/i.test(l)) return null;
    if (np.category === 'mixer' && !require('./mixers.js').MIXERS.some(x => x.re.test(np.name)) && !/\b(?:ice|water|juice|soda|syrup|bitters|limes?|lemons?|oranges?|tonic|mixers?|garnish|olives?|cherries|cups?|napkins?|puree|purée|grenadine|agave|sour)\b/i.test(np.name)) return null;
    delete np.case_bottles;
    named.push(np);
  }
  return named.length >= 2 ? named : null;
}

module.exports = { orderNegated, ownListCount, notACheckout, listItems };
