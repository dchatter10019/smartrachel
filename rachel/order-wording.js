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
const ITEM_LINE = /^\s*(?:[-•*·]\s*\S|\d{1,4}\s*(?:x|×)\s+\S)|\S.*\s[x×]\s?\d{1,4}\s*$/i;
// A line copied from Rachel's own search results / list: "Bacardi Gold Rum 750 mL — $19.79" (Nov 11).
const PRICED_LINE = /^\s*[A-Za-z].*\s[—–]\s*\$\s*\d[\d,]*(?:\.\d{2})?\b/;
const SWAP_WORDS = /\b(?:swap|switch|instead|replace|substitute)\b/i;
const NEEDS_JUDGMENT = /\?|\b(?:guests?|people|persons?|attendees|hours?|budget|event|party|wedding|reception|proposal|pdf|quote|estimate|we have|on hand|already (?:have|got)|in stock at|remove|without|except|cheaper|recommend|suggest|similar|alternatives?|options?|pair(?:ing)? with|cocktails?)\b/i;

// opts.emptyBasket: nothing in the cart yet, so "swap this menu with the following items" / picks copied from the
// search results can only mean "these" (Nov 11, DC on Claude Code, a new chat: "Can you swap this menu with the following
// items * Bacardi Rum * Angel's Envy Bourbon ..." got "How many guests? How long? Budget?" twice, then "how many of each?
// Is this for an event?" for the products picked from the search). With a cart, a swap and a pick stay with the LLM.
// The result's .uncounted = how many lines gave no count (built at 1 each; the reply says so).
function listItems(message, opts) {
  const o = opts || {};
  const m = String(message || '').replace(/-&gt;|->/g, ' -> ');
  if (/->/.test(m) || NEEDS_JUDGMENT.test(m) || (!o.emptyBasket && SWAP_WORDS.test(m))) return null;
  const OC = require('./original-compare.js');
  // "Robert Mondavi Cab Sav is good to go" = that product; "Ruffino Prosecco or Champagne" = the first one named.
  const tidy = l => l.replace(/\s+(?:is|are|'s)\s+(?:good|fine|ok(?:ay)?|great|perfect)(?:\s+to\s+go)?\s*[.!]*\s*$/i, '')
    .replace(/^(\s*(?:[-•*·]\s*)?[^—–$]*?\S)\s+or\s+[^—–$]+$/i, '$1');
  const lines = m.split(/\n/).map(l => l.trim()).filter(Boolean);
  const isItem = l => ITEM_LINE.test(l) || (o.emptyBasket && PRICED_LINE.test(l));
  let itemLines = lines.filter(isItem);
  let other = lines.filter(l => !isItem(l));
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
  let uncounted = 0;
  for (const l0 of itemLines) {
    const l = tidy(l0);
    const np = OC.namedFromListLine(l);
    if (!np || !np.name || np.name.length < 3) return null;
    // Unsure lines stay with the LLM: "a case" (beer 24 vs wine 12) and a product the reader filed as a mixer only because
    // it didn't know the brand ("2 cases of Stella" -> mixer "Stella case").
    if (/\bcases?\b/i.test(OC.cleanPastedLine(l))) return null;
    if (np.category === 'mixer' && !require('./mixers.js').MIXERS.some(x => x.re.test(np.name)) && !/\b(?:ice|water|juice|soda|syrup|bitters|limes?|lemons?|oranges?|tonic|mixers?|garnish|olives?|cherries|cups?|napkins?|puree|purée|grenadine|agave|sour)\b/i.test(np.name)) return null;
    // no count of its own: no leading "2 x" / "2 btls", no trailing "x2" / "5 btls" / "1 case"
    if (!/^\s*(?:[-•*·]\s*)?\d{1,4}\s*(?:x|×|btls?|bottles?|cans?|cases?)?\s+\S|[x×]\s?\d{1,4}\s*$|\s\d{1,4}\s*(?:btls?|bottles?|cans?)\.?\s*$/i.test(OC.cleanPastedLine(l))) uncounted++;
    delete np.case_bottles;
    named.push(np);
  }
  if (named.length < 2) return null;
  named.uncounted = uncounted;
  return named;
}

module.exports = { orderNegated, ownListCount, notACheckout, listItems };
