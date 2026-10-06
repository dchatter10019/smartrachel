// A message that states how many bottles / cases to buy is an ORDER, not an event (DC, Oct 5: "44 bottles of prosecco and
// the budget is $1000" was asked "Is this for an event? If so, how many guests and how many hours?" — prompt.md's
// PRIORITY 0-PRE fired on the budget). The quantity is already known, so guests/hours are never needed.
// Used by rachel.js to tell the LLM to build it straight away; every channel's chat goes through there.

const UNIT = '(?:bottles?|btls?|cases?|cans?|packs?|(?:6|12|24|six|twelve)[- ]?packs?|kegs?|magnums?|boxes?)';
// "44 bottles of prosecco", "3 cases Stella", "2 x Veuve", "12 btls of Tito's"
const QTY_RE = new RegExp('\\b(\\d{1,4})\\s*(?:' + UNIT + '\\s+(?:of\\s+)?|x\\s+|×\\s*)[A-Za-z]', 'i');
// Anything that makes it an event (or gives its size) — then the event flow's questions are right.
const EVENT_RE = /\b(guests?|people|persons|attendees|pax|ppl|hours?|hrs?|event|party|parties|wedding|gathering|celebration|reception|happy hour|offsite|off-site|banquet|gala|drinks per (?:person|guest))\b|\bfor\s+\d+\b/i;

function statedQuantity(msg) {
  const s = String(msg || '');
  if (EVENT_RE.test(s)) return null;
  const m = s.match(QTY_RE);
  return m ? { qty: Number(m[1]), text: m[0] } : null;
}

module.exports = { statedQuantity };
