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
    // No event-date ask here: DC (Sep 29) — the event date is relevant ONLY when a proposal is created,
    // and the proposal flow asks it. The spec's basket.ask_event_date row is dropped, not disabled.
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
      text: t => t.substitute.name + (t.substitute.size ? ' ' + String(t.substitute.size).replace(/(\d)\s*(ml|l|oz)\b/i, (m, d, u) => d + ' ' + (u.toLowerCase() === 'ml' ? 'mL' : u.toUpperCase() === 'L' ? 'L' : u)) : '') + ' is in stock at ' + money(t.substitute.price) + ' — swap it in?',
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
  // A reply with no question while a basket exists. Real dead end (DC, Sep 29, Slack): "no" to "add mixers?"
  // after a $4,981 event package got "No problem!" and nothing else. DC: offer the order AND the PDF proposal.
  // Not offered twice in a row (prevCta) so an informational back-and-forth doesn't nag every turn.
  basket_idle: [
    { id: 'basket.offer_order_or_proposal', when: t => !t.orderStarted && t.prevCta !== 'basket.offer_order_or_proposal',
      text: 'Would you like me to place the order, or send you a PDF proposal?',
      accept: /\bplace\b|\border\b|checkout|proposal|\bpdf\b|\bquote\b|^\s*(?:yes|yep|yeah|sure|ok(?:ay)?)\b/i },
  ],
  informational: [
    { id: 'info.none', none: true },
  ],
};

function chooseCta(state, turn, log = console.log) {
  const kind = turn && turn.kind;
  const label = kind || '?';   // spec log shape: [cta] <state> -> <id> | none (<reason>)
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

// ── Closers (DC, Sep 29: option A) ─────────────────────────────────────────────────────────────────
// The reply's own last question decides whether a CTA may follow. A GENERIC nudge the LLM wrote
// ("Want me to add it?", "Anything else?") is removed and the table's CTA goes in its place; a REAL
// question Rachel needs answered ("Which size works for you?") stays and no CTA is added (one question
// per turn). Anything not recognised as generic is treated as real: the worst case is a turn without
// a table CTA, never two questions or a lost question. Confirmations ("Shall I go ahead and place it?")
// are never generic: the order flow's own questions (and closers are only touched in the ready state).
const GENERIC_CLOSER = /^\W*(?:(?:for|as for|on) (?:the )?[^,?]{1,80},\s*)?(?:would you like (?:the|this|that|it|one)\b(?![^?]*\bor\b)|would you like (?:me )?to (?:add|include|put|grab|see the estimated|place the order)|want me to (?:add|include|put|grab|throw)|do you want (?:me )?to add|should i add|shall i add|want to add (?:it|this|that|them|one|some|any)|would you like (?:any|one|some) of (?:these|those|them)|would you like me to (?:find|look for|search for|suggest) (?:a |an |some )?(?:substitutes?|alternatives?|replacements?)|would you like to (?:substitute|swap|switch)|if you(?:'?d| would)? (?:like|want)\b[^?]*?\b(?:just )?(?:say the word|let me know)|just say the word|anything else|is there anything else|what else can i|can i help with anything else|let me know if (?:you'?d like|you want|there'?s anything))/i;
// A nudge phrase anywhere in a sentence that asks for nothing Rachel needs: generic too. Sep 29 QA: "Would
// you like to place an order, or is there anything else I can help with?" slipped past the opening list.
const NUDGE_ANY = /\b(?:anything else (?:i can|you(?:'?d)? (?:need|like|want))|(?:place|put in) (?:an|the|your) order|add (?:it|this|that|them|one|some) to your (?:order|basket|cart)|ready to (?:order|check ?out|place))\b/i;
const REAL_Q = /\b(?:which|how many|what size|what kind|what type|when|where|who)\b/i;
const isGenericSentence = x => { const y = String(x || '').replace(/^[*_\s]+/, ''); return GENERIC_CLOSER.test(y) || (NUDGE_ANY.test(y) && !REAL_Q.test(y)); };
// The pre-CTA four-action trailer, in any of its forms: a question naming 2+ of these actions.
const TRAILER_WORDS = [/estimated full price/i, /place the order/i, /(?:pdf )?proposal/i, /make any changes/i];

function stripTrailer(text) {
  return String(text || '').replace(/[^.!?\n]*\?[*_]*/g, q => (TRAILER_WORDS.filter(w => w.test(q)).length >= 2 ? '' : q))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
// -> { body, closer, generic, question }. Looks at EVERY sentence of the last paragraph: a real question
// anywhere in it makes this a question turn (kept, no CTA); trailing generic sentences (nudges, offers,
// "just say the word") are removed so the table's CTA replaces them. Sep 29 QA: "Would you like to
// substitute with one of these sizes? If you'd like 2x …, just say the word!" ended in "!", was not seen
// as a question, and got "swap it in?" appended — two questions.
function splitCloser(text) {
  const t = String(text || '').trimEnd();
  const paras = t.split(/\n\s*\n/);
  const last = paras[paras.length - 1] || '';
  const sents = last.split(/(?<=[.!?][*_)]*)\s+(?=[A-Z*_(])/);
  const isQ = x => /\?\s*[*_)]*\s*$/.test(x);
  const isGeneric = isGenericSentence;
  const trailingGeneric = [];
  while (sents.length && isGeneric(sents[sents.length - 1])) trailingGeneric.unshift(sents.pop());
  const realQ = sents.some(isQ) && !sents.filter(isQ).every(isGeneric);
  if (!trailingGeneric.length) {
    const q = sents.some(isQ);
    return { body: t, closer: q ? sents.filter(isQ).pop() : '', generic: false, question: q && realQ };
  }
  const rest = sents.join(' ').trim();
  const body = paras.slice(0, -1).concat(rest ? [rest] : []).join('\n\n').trimEnd();
  const q2 = /\?\s*[*_)]*\s*$/.test(body.split(/\n\s*\n/).pop() || '') || realQ;
  return { body, closer: trailingGeneric.join(' '), generic: true, question: q2 };
}

// Question sentences anywhere in the reply (not only the closer). Sep 29 QA: the LLM asked "Would you
// like to substitute 2x Grey Goose 1.75 L (or another size) instead?" ABOVE its options list; the table's
// "swap it in?" then made two questions. A real question anywhere = a question turn; when a CTA is added,
// generic question sentences anywhere are removed.
const Q_SENT = /(?:[^.!?\n]|(?<=\d)\.(?=\d))*\?[*_)]*/g;   // a '.' between digits (1.75 L, $54.40) doesn't end a sentence
function hasRealQuestion(text) { return (String(text || '').match(Q_SENT) || []).some(q => !isGenericSentence(q.trim())); }
function scrubGenericQuestions(text) {
  return String(text || '').replace(Q_SENT, q => (isGenericSentence(q.trim()) ? '' : q))
    .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function findCta(id) { for (const rows of Object.values(TABLE)) for (const c of rows) if (c.id === id) return c; return null; }
function accepted(ctaOrId, message) {
  const c = typeof ctaOrId === 'string' ? findCta(ctaOrId) : ctaOrId;
  return !!(c && c.accept && c.accept.test(String(message || '')));
}

// A reply that was ONLY the generic trailer strips to nothing. Real bug (DC, Sep 29, Slack): "no" to "add
// mixers?" got "Would you like to see the estimated full price, place the order...?" from the LLM, the
// trailer was stripped, the empty reply was refused by Slack (no_text) and the customer saw silence
// twice. Never send an empty reply: a short acknowledgement plus the basket follow-up from the table.
function fallbackIfEmpty(text, state, turn, basketItems, log = console.log) {
  if (String(text || '').trim()) return null;
  const c = basketItems > 0 ? chooseCta(state, Object.assign({}, turn, { kind: 'basket_idle', question: false }), log) : null;
  const t = 'Got it.' + (c ? ' ' + c.text : ' What else can I get you?');
  log('[cta] reply was empty after stripping the generic trailer — sent ' + JSON.stringify(t) + ' instead');
  return { text: t, cta: c };
}

// A basket line is never a numbered option. Real trap (DC, Sep 29, Slack): the LLM rendered the package's
// spirits as "1. Vodka: 1x Belvedere ... 5. Tequila: 1x Cazcanes"; the next message was classified after a
// "numbered_list", so a reply like "2" could have been taken as picking the rum. Lines carrying a
// quantity ("1x", "2 x") lose their "N." prefix; real option lists (no quantity) keep it.
function denumberBasketLines(text) {
  return String(text || '').replace(/^(\s*)\d{1,2}[.)]\s+(?=(?:[^\n]*?[\s:*_])?\d{1,3}\s*x\s)/gm, '$1');
}

module.exports = { denumberBasketLines, chooseCta, accepted, findCta, stripTrailer, splitCloser, hasRealQuestion, scrubGenericQuestions, fallbackIfEmpty, TABLE, DATE_RE };
