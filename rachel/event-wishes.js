// Relative wishes in an event request, read from the customer's own words — the same rules as the Voiceflow agent's
// ParseRequest v1.4/1.5 (ops/voiceflow/ParseRequest.js; DC, Oct 21: Rachel and Voiceflow behave the same on every channel).
//   wineLeanIn  "more white than red", "mostly white", "white-heavy"   -> 'white' | 'red' | ''
//   mixBiasIn   "more beer than wine" -> 'beer>wine', "heavy on the spirits", "add more liquor" -> 'spirits', '' with a % split
// buildPackage (functions.js) turns them into bottle counts; the LLM never decides them.
function norm(text) { return ' ' + String(text || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ') + ' '; }

function wineLeanIn(text) {
  const t = norm(text);
  if (/(more|mostly|mainly|heavier on|heavy on|lean(ing)? (toward|towards)?|prefer(ably)?|rather|majority)\s+(of\s+)?(the\s+)?white|white[- ]heavy|(more|mostly|mainly)\s+white|\bwhite (wine )?(over|than) red|\bless red\b/.test(t)) return 'white';
  if (/(more|mostly|mainly|heavier on|heavy on|prefer(ably)?|majority)\s+(of\s+)?(the\s+)?red|red[- ]heavy|\bred (wine )?(over|than) white|\bless white\b/.test(t)) return 'red';
  return '';
}

const CATW = '(beers?|wines?|spirits?|liquors?|booze|hard alcohol)';
function catOf(w) { w = String(w || ''); if (/^beer/.test(w)) return 'beer'; if (/^wine/.test(w)) return 'wine'; return 'spirits'; }
function mixBiasIn(text) {
  const t = norm(text);
  if (/\d+\s*%|percent/.test(t)) return '';   // a stated split wins (serving-mix.js reads it)
  const pm = t.match(new RegExp('(?:more|heavier on|heavy on|mostly|mainly|bigger|larger share of|emphasi[sz]e|focus on)\\s+' + CATW + '\\s+(?:than|over|vs\\.?|versus|compared to)\\s+' + CATW))
    || t.match(new RegExp('\\b' + CATW + '\\s+(?:over|more than)\\s+' + CATW));
  if (pm && catOf(pm[1]) !== catOf(pm[2])) return catOf(pm[1]) + '>' + catOf(pm[2]);
  const sm = t.match(new RegExp('(?:add(?:ing)? more|more|extra|heavy on|heavier on|mostly|mainly|focus on|emphasi[sz]e|lean(?:ing)? (?:toward|towards|on))\\s+(?:the\\s+)?' + CATW))
    || t.match(new RegExp('\\b' + CATW + '[- ]heavy'));
  return sm ? catOf(sm[1]) : '';
}

module.exports = { wineLeanIn, mixBiasIn };
