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

module.exports = { orderNegated, ownListCount, notACheckout };
