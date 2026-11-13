// A proposal request that ALSO changes the basket, or that accepts changes Rachel just offered, must not take the in-code
// proposal path (which prints the basket as it is). Real (Nov 13, DC):
//  - connector: "Change Corona Light to 1 case and Blue Moon to 1 case. Replace the champagne, Cabernet and Chardonnay
//    with options around $30 per bottle, 2 bottles of each, then regenerate the KPMG proposal." -> the same PDF, twice.
//  - email: Rachel asked "Shall I go with Kendall-Jackson for the Sauvignon Blanc and Underwood for the Pinot Noir?";
//    "Yes sounds good with the choices and create a proposal" -> the old PDF (Cloudy Bay $37, Joseph Phelps $71).
// Those turns go to the model, which makes the changes and then calls generate_proposal on the live basket.

const FIELD_OR_FEE = /\b(?:instructions?|notes?|driver|door|buzzer|contact|phone|email|time|window|client|company|customer|event date|date|name|title|tax|tip|service(?: charge| fee)?|delivery (?:fee|charge)|address|options?|alternatives?|choices)\b/i;
const PROPOSAL_WORDS = /\b(?:re-?generate|create|make|send|build|prepare|draft|give|share|email|do|update|redo|new)\b[^.?!\n]{0,24}?\b(?:proposal|pdf|quote)\b/i;

// Clauses of the message that change the basket ("change Corona Light to 1 case", "replace the champagne with ...",
// "remove the Busch", "add 2 bottles of ...", "make the Blue Moon 3"). Field / fee / options edits are not basket edits.
function editsIn(msg) {
  const out = [];
  const clauses = String(msg || '').replace(/[“”"]/g, '').split(/\n+|(?<=[.!?;])\s+|,\s*(?:then|and then)\s+|\s+then\s+/i);
  for (const c0 of clauses) {
    const c = c0.trim();
    if (!c || PROPOSAL_WORDS.test(c) && !/\b(?:change|replace|swap|remove|add|instead)\b/i.test(c.replace(PROPOSAL_WORDS, ''))) continue;
    const m = c.match(/\b(?:change|replace|swap|switch|substitute|remove|take out|drop|delete|add|increase|decrease|reduce|bump|make (?:it|them|the\b)|update (?:the )?(?!proposal|pdf|quote)\w+|instead of)\b/i);
    if (!m) continue;
    const rest = c.slice(m.index);
    // "change the client to KPMG", "add a 8% service charge", "take out the options" — handled elsewhere in code
    const target = rest.replace(/^\S+(?:\s+(?:out|it|them))?\s+/i, '').slice(0, 40);
    if (FIELD_OR_FEE.test(target) && !/\b(?:wine|beer|champagne|prosecco|bottle|case|cab|chard|pinot|vodka|tequila|whiskey|rum|gin|\d+\s*x)\b/i.test(target)) continue;
    out.push(c.slice(0, 80));
  }
  return out;
}

// "yes" / "sounds good" / "go ahead" / "do that" to a reply that offered basket changes ("Shall I go with X for the Y?",
// "Shall I swap ...", "(replaces Cloudy Bay)", "Want me to replace ...?").
const YES = /^\W*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|sounds good|looks good|perfect|great|go ahead|please do|do (?:it|that|those|these)|let'?s do (?:it|that)|approved?|confirmed?)\b/i;
const OFFER = /\b(?:shall|should|can|may) I\b[^?]{0,160}\b(?:go with|swap|switch|replace|use|change|update|regenerate)\b[^?]*\?|\b(?:want|would you like) me to\b[^?]{0,120}\b(?:swap|switch|replace|use|change|go with)\b[^?]*\?|\(replaces? [^)]+\)/i;
function acceptsOffer(msg, lastReply) {
  return YES.test(String(msg || '')) && OFFER.test(String(lastReply || ''));
}

module.exports = { editsIn, acceptsOffer };
