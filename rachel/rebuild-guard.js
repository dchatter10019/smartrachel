// A QUESTION never rebuilds the basket (DC, Nov 18: "yes build it"). In the Foodie For All 140-guest chat the model answered a
// question about the package by calling menu_build again: the new build REPLACED the cart and the reply described a different
// package from the one in the cart / on the next PDF. Rule (code, every /chat channel — Slack, WhatsApp, email, rachel_chat):
// with a basket already there, a menu_build / custom_list the MODEL starts on a turn whose message only asks something (no
// change, add, remove, swap, new event numbers, "build / redo ...") is refused; the model answers about the basket it has.
// Builds decided in code (scripted calls: [event-dpp], list builds) are never refused.
//
// questionOnly(message, {guests, hours, budget}) -> '' (a change or a request: the build may run) | the reason it is a question only

const CHANGE = new RegExp('\\b(?:' + [
  'add(?:ing)?', '(?:can|could|would|will)\\s+(?:you|we)\\s+(?:please\\s+)?include', 'please\\s+include', 'throw\\s+in', 'remove', 'take\\s+(?:out|off|away)', 'drop', 'delete', 'cut', 'without', 'no\\s+more',
  'swap', 'switch', 'replace', 'substitute', 'instead', 'change', 'make\\s+(?:it|that|this|them|the|those|these|sure)', 'turn',
  'rebuild', 'redo', 're-?do', 'rework', 'start\\s+over', 'update', 'revise', 'adjust', 'modify', 'edit', 'fix', 'correct',
  'increase', 'decrease', 'raise', 'lower', 'reduce', 'bump', 'double', 'halve', 'more', 'less', 'fewer', 'extra', 'another', 'other',
  'cheaper', 'pricier', 'upgrade', 'downgrade', 'use', 'go\\s+with', 'pick', 'choose', 'prefer', 'rather', 'only', 'just',
  'build', 'create', 'put\\s+together', 'plan', 'prepare', 'need', 'want', 'would\\s+like', "i'?d\\s+like", 'looking\\s+for',
  'order', 'buy', 'send', 'quote', 'proposal', 'pdf', 'set', 'keep', 'skip', 'leave\\s+out',
].join('|') + ')\\b', 'i');
// NEW event facts are a change too ("what about 200 guests?", "$3,000?", "for 4 hours?") — the event's own numbers are not
// ("is that enough for 140 guests?" with 140 guests is a question).
const NUMS = /\b(\d+)\s*(guests?|people|persons?|pax|attendees|hours?|hrs?|h)\b|\$\s*([\d,]+(?:\.\d+)?)|\b([\d,]+)\s*(?:dollars|bucks)\b|\b\d+(?:\.\d+)?\s*%/gi;
function newNumber(m, known) {
  const k = known || {}; let x;
  NUMS.lastIndex = 0;
  while ((x = NUMS.exec(m))) {
    if (x[1]) { const n = +x[1], hrs = /^h/i.test(x[2]); if (hrs ? n !== +k.hours : n !== +k.guests) return x[0]; continue; }
    const usd = parseFloat(String(x[3] || x[4] || '').replace(/,/g, ''));
    if (isFinite(usd) && usd > 0) { if (usd !== +k.budget) return x[0]; continue; }
    return x[0];   // a percent
  }
  return '';
}
const ASK = /\?|^\s*(?:why|what|which|how|is|are|was|were|does|do|did|can\s+you\s+(?:tell|explain)|could\s+you\s+(?:tell|explain)|tell\s+me|explain|walk\s+me|remind\s+me|where|when|who)\b/i;

function questionOnly(message, known) {
  const m = String(message || '').trim();
  if (!m || m.length > 400) return '';           // a long message (an email brief, a list) is not a quick question
  if (/^\s*\{/.test(m)) return '';               // an internal sentinel (_system ...)
  if (!ASK.test(m)) return '';
  if (CHANGE.test(m)) return '';
  if (newNumber(m, known)) return '';
  return 'a question with no change asked';
}

module.exports = { questionOnly };
