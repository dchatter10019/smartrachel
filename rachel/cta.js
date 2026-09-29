// Next-best-action (Learning Phase 1, Part B). After a reply, exactly one follow-up is chosen IN CODE
// from the conversation state — the LLM never invents one. The table is data: rows per state, candidates
// in rank order; the first whose condition holds is offered. Phase 3 reorders ranks from acceptance
// rates (events.jsonl cta_id / cta_taken) without code changes. New follow-ups are added HERE, never to
// the prompt.
//
// chooseCta(state, turn) -> { id, text, accept } | null. Logs every choice and every skip with its reason.
//   state: the session flow state (reads state.ctaDeclined: ids the customer turned down this session)
//   turn:  { kind, question, category, statedQty, options, eventDateKnown, corporate, orderStarted,
//            substitute: { name, size, price }, basketItems, stateLabel }
// accepted(cta, message) -> bool: did the next message act on it (sets cta_taken on that turn's event).

const DATE_RE = /\b(today|tomorrow|tonight|this (?:week(?:end)?|friday|saturday|sunday)|next (?:week|month|mon|tue|wed|thu|fri|sat|sun)\w*|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\.?\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|in (?:\d+|a|two|three) (?:days?|weeks?))\b/i;
const isWine = c => /wine|champagne|prosecco|sparkling|ros[eé]/i.test(c || '');
const money = n => '$' + (Number(n) || 0).toFixed(2);

const TABLE = {
  search_single: [
    { id: 'search.offer_qty', when: t => /wine|spirit|liquor|champagne|vodka|tequila|whisk|gin|rum|bourbon/i.test(t.category || ''),
      // Never drinks-per-person: the customer's own number, else a flat default.
      text: t => 'Want ' + (t.statedQty > 0 ? t.statedQty : isWine(t.category) ? 6 : 3) + ' of those?',
      accept: /^\s*(?:yes|yep|yeah|sure|ok(?:ay)?)\b|^\s*\d{1,3}\s*(?:bottles?|x)?\s*[.!]?\s*$/i },
    { id: 'search.add_more', text: 'Want me to add it to your basket, or keep looking?', accept: /\badd\b|^\s*(?:yes|yep|yeah|sure)\b/i },
  ],
  search_multi: [
    { id: 'search.pick_hint', when: t => t.options > 1, text: 'Reply with a number to add one, or tell me the size you want.',
      accept: /^\s*#?\d{1,2}\b|\b\d+(?:\.\d+)?\s*(?:ml|l|oz)\b/i },
  ],
  basket_built: [
    { id: 'basket.ask_event_date', when: t => !t.eventDateKnown, text: 'When\'s the event? I\'ll line up the delivery window.', accept: DATE_RE },
    // References consumption: needs DC's approval of the wording before it goes live (spec).
    { id: 'basket.round_up', enabled: false, when: t => t.drinksPerGuest && t.drinksFloor && t.drinksPerGuest < t.drinksFloor * 0.7,
      text: t => 'That\'s about ' + t.drinksPerGuest + ' drinks per guest — want me to round it up?', accept: /^\s*(?:yes|round|sure)\b/i },
    { id: 'basket.offer_proposal', when: t => t.corporate, text: 'Want a PDF proposal for this?', accept: /proposal|pdf|^\s*(?:yes|sure)\b/i },
    { id: 'basket.offer_checkout', when: t => !t.corporate, text: 'Ready to place the order?', accept: /\bplace\b|\border\b|checkout|^\s*(?:yes|yep|sure)\b/i },
  ],
  basket_updated: [
    { id: 'basket.offer_checkout', when: t => !t.orderStarted, text: 'Anything else, or ready to place the order?', accept: /\bplace\b|\border\b|^\s*(?:yes|yep|sure)\b/i },
  ],
  item_unavailable: [
    { id: 'sub.offer_named', when: t => t.substitute && t.substitute.name && t.substitute.price > 0,
      text: t => t.substitute.name + (t.substitute.size ? ' ' + t.substitute.size : '') + ' is in stock at ' + money(t.substitute.price) + ' — swap it in?',
      accept: /\bswap\b|^\s*(?:yes|yep|yeah|sure|ok)\b/i },
    { id: 'sub.offer_search', text: 'Want me to look for an alternative?', accept: /^\s*(?:yes|yep|sure)\b|\blook\b/i },
  ],
  order_placed: [
    // Phase 2 territory: disabled until DC wants the acceptance signal (spec).
    { id: 'post.save_package', enabled: false, when: t => t.basketItems >= 2, text: 'Save this as a named package for next time?', accept: /\bsave\b|^\s*yes\b/i },
    { id: 'post.nothing', none: true },
  ],
  proposal_sent: [
    { id: 'proposal.offer_order', text: 'When you\'re ready, say the word and I\'ll place it.', accept: /\bplace\b|\border\b/i },
  ],
  informational: [
    { id: 'info.none', none: true },
  ],
};

function chooseCta(state, turn, log = console.log) {
  const kind = turn && turn.kind;
  const label = (turn && turn.stateLabel ? turn.stateLabel + ' ' : '') + (kind || '?');
  if (turn && turn.question) { log('[cta] ' + label + ' -> none (question turn)'); return null; }
  const rows = TABLE[kind];
  if (!rows) { log('[cta] ' + label + ' -> none (no row for this state)'); return null; }
  const declined = new Set((state && state.ctaDeclined) || []);
  const skipped = [];
  for (const c of rows) {
    if (c.enabled === false) { skipped.push(c.id + ': disabled'); continue; }
    if (declined.has(c.id)) { skipped.push(c.id + ': declined earlier this session'); continue; }
    if (c.when && !c.when(turn)) { skipped.push(c.id + ': condition'); continue; }
    if (c.none) { log('[cta] ' + label + ' -> none (' + c.id + ')' + (skipped.length ? ' skipped ' + JSON.stringify(skipped) : '')); return null; }
    const text = typeof c.text === 'function' ? c.text(turn) : c.text;
    log('[cta] ' + label + ' -> ' + c.id + (skipped.length ? ' (skipped ' + JSON.stringify(skipped) + ')' : ''));
    return { id: c.id, text, accept: c.accept };
  }
  log('[cta] ' + label + ' -> none (no candidate held: ' + JSON.stringify(skipped) + ')');
  return null;
}

function findCta(id) { for (const rows of Object.values(TABLE)) for (const c of rows) if (c.id === id) return c; return null; }
function accepted(ctaOrId, message) {
  const c = typeof ctaOrId === 'string' ? findCta(ctaOrId) : ctaOrId;
  return !!(c && c.accept && c.accept.test(String(message || '')));
}

module.exports = { chooseCta, accepted, findCta, TABLE, DATE_RE };
