// A message about an order Rachel already PLACED (state.placedOrder, cart empty): what is it asking?
// Real (Oct 4, Foodie For All): BJ wrote "I just made the payment. Could you please update the recipient name to Mara
// Miller, and that the delivery people say they are delivering from Foodie For All for COI purposes?" — the word
// "update" sent it to the reopen question, which re-sent the payment link and asked whether to reopen or start a new
// order. A payment report never gets the link again, and a delivery-detail change is not an item change.

// "I just made the payment", "paid", "payment is done/complete/submitted", "we've paid the invoice"
const PAID = /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+|already\s+)?(?:made|completed|submitted|sent|processed)\s+(?:the\s+|a\s+|my\s+|our\s+)?payment\b|\b(?:i|we|bj|it|order|invoice|link)(?:'ve| have| has| is| was)?\s+(?:just\s+|already\s+|now\s+|been\s+)*paid\b|\bpayment\s+(?:is\s+|has\s+been\s+|was\s+)?(?:done|made|complete|completed|submitted|through|received|processed)\b|^\s*paid\b/i;
// A question or negation about paying is not a report: "has it been paid?", "I haven't paid yet", "not paid".
const NOT_PAID = /\b(?:not|n't|never)\s+(?:yet\s+)?(?:been\s+)?(?:paid|made\s+(?:the\s+)?payment)\b|\bhas\s+(?:it|the\s+order)\s+been\s+paid\s*\?|\bunpaid\b/i;

// Delivery details, not items: who receives it, contact phone/email, driver instructions, COI, delivery note/time/address.
const DETAILS = /\b(?:recipient|receiver|receiving|on-?site contact|point of contact|poc|contact (?:name|person|info|number|phone)|name on the order|customer name|phone(?: number)?|delivery (?:instructions?|notes?|time|window|address|people|person|driver|team)|driver|courier|delivering from|deliver(?:ing)? on behalf|coi|certificate of insurance|loading dock|front desk|reception|buzz|gate code|leave it|drop[- ]?off|deliver (?:it )?to)\b/i;
// Item / basket wording: an item change still needs the reopen question. A verb alone ("add delivery instructions") is an
// item change only when no delivery detail is named; a drink / container word always is. ("Can you" is not "cans".)
const ITEM_NOUN = /\b(?:bottles?|cases?|packs?|cans|\d+\s*cans?|wine|beer|vodka|tequila|whiske?y|bourbon|gin|rum|prosecco|champagne|seltzers?|liquor|basket|cart|items?)\b/i;
const ITEM_VERB = /\b(?:add|remove|drop|take out|swap|replace|instead of|more|less|fewer|increase|decrease|extra|re-?order)\b/i;

// A request to change the order: an item verb, or change/update/edit/modify/cancel wording. A question about it
// ("when will my order arrive?") is not.
const CHANGE = /\b(?:add|remove|drop|take out|swap|replace|instead|make (?:it|that|them) \d+|more|less|fewer|increase|decrease|extra|change|update|edit|modify|cancel|switch)\b/i;
function changeRequest(text) { return CHANGE.test(String(text || '')); }

function paidClaim(text) { const t = String(text || ''); return PAID.test(t) && !NOT_PAID.test(t); }
function detailsChange(text) { return DETAILS.test(String(text || '')); }
function itemChange(text) {
  // "COI", "delivering from Foodie For All" etc. never count; an item word inside a details sentence ("the delivery people")
  // is checked on the text with the details phrases removed.
  const t = String(text || ''), rest = t.replace(new RegExp(DETAILS.source, 'gi'), ' ');
  return ITEM_NOUN.test(rest) || (ITEM_VERB.test(rest) && !DETAILS.test(t));
}

// -> 'paid' (payment report, maybe with detail changes) | 'details' (detail change, no items) | null (leave to the caller)
function classify(text) {
  if (paidClaim(text)) return itemChange(text) ? 'paid_items' : 'paid';
  if (detailsChange(text) && !itemChange(text)) return 'details';
  return null;
}

// The customer's request sentences (without the payment report / greeting / sign-off), for the support note and the reply.
function requestSentences(text) {
  return String(text || '').replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim())
    .filter(s => s && !PAID.test(s) && !/^(?:hi|hello|hey|thanks?|thank you|best|regards|cheers)\b[\w ,!.]*$/i.test(s) && (DETAILS.test(s) || ITEM_NOUN.test(s) || ITEM_VERB.test(s) || /\b(?:update|change|could you|can you|please)\b/i.test(s)));
}

module.exports = { changeRequest, paidClaim, detailsChange, itemChange, classify, requestSentences };
