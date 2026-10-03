// Unit tests for cta.js (Learning Phase 1, Part B): every table row reachable from a hand-built state,
// declined CTAs not repeated, question turns get none, disabled rows skipped, accept patterns.
// (precheck.sh runs every qa/unit/*.test.js during lint.)
const { chooseCta, accepted, TABLE, stripTrailer, splitCloser, hasRealQuestion, scrubGenericQuestions, trimGenericAlternative } = require('../../cta.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const q = () => {};
const pick = (turn, state = {}) => { const c = chooseCta(state, turn, q); return c ? c.id : null; };
const text = (turn, state = {}) => { const c = chooseCta(state, turn, q); return c ? c.text : null; };

console.log('every enabled row is reachable');
{
  const reached = new Set();
  const cases = [
    [{ kind: 'search_single', category: 'spirits' }, 'search.offer_qty'],
    [{ kind: 'search_single', category: 'beer' }, 'search.add_more'],
    [{ kind: 'search_multi', options: 4 }, 'search.pick_hint'],
    [{ kind: 'basket_built', eventDateKnown: true, corporate: true }, 'basket.offer_proposal'],
    [{ kind: 'basket_built', eventDateKnown: true, corporate: false }, 'basket.offer_checkout'],
    [{ kind: 'basket_updated', orderStarted: false }, 'basket.offer_checkout'],
    [{ kind: 'item_unavailable', substitute: { name: 'Ketel One', size: '750 mL', price: 29.99 } }, 'sub.offer_named'],
    [{ kind: 'item_unavailable' }, 'sub.offer_search'],
    [{ kind: 'proposal_sent' }, 'proposal.offer_order'],
    [{ kind: 'basket_idle' }, 'basket.offer_order_or_proposal'],
  ];
  for (const [t, want] of cases) { const got = pick(t); reached.add(got); eq(t.kind + ' -> ' + want, got, want); }
  const enabled = Object.values(TABLE).flat().filter(c => c.enabled !== false && !c.none).map(c => c.id);
  eq('all enabled ids covered', enabled.filter(id => !reached.has(id)), []);
}

console.log('none cases');
{
  eq('question turn -> none', pick({ kind: 'basket_built', question: true }), null);
  eq('no event-date ask anywhere (DC: proposal only)', Object.values(TABLE).flat().some(c => /date/.test(c.id)), false);
  eq('order_placed -> none (save_package disabled)', pick({ kind: 'order_placed', basketItems: 3 }), null);
  eq('informational -> none', pick({ kind: 'informational' }), null);
  eq('basket_updated after order started -> none', pick({ kind: 'basket_updated', orderStarted: true }), null);
  eq('unknown state -> none', pick({ kind: 'weird' }), null);
  eq('round_up disabled even when it would hold', pick({ kind: 'basket_built', eventDateKnown: true, drinksPerGuest: 1, drinksFloor: 4, corporate: false }), 'basket.offer_checkout');
}

console.log('declined is not repeated');
{
  eq('checkout declined -> none for basket_updated', pick({ kind: 'basket_updated' }, { ctaDeclined: ['basket.offer_checkout'] }), null);
  eq('proposal declined -> none for corporate', pick({ kind: 'basket_built', corporate: true }, { ctaDeclined: ['basket.offer_proposal'] }), null);
}

console.log('texts');
{
  eq('spirits: no made-up number', text({ kind: 'search_single', category: 'spirits' }), 'How many would you like?');
  eq('wine: no made-up number', text({ kind: 'search_single', category: 'wine' }), 'How many would you like?');
  eq('stated qty: still asks (a bare yes takes the stated number)', text({ kind: 'search_single', category: 'wine', statedQty: 2 }), 'How many would you like?');
  eq('named substitute', text({ kind: 'item_unavailable', substitute: { name: 'Ketel One', size: '750 mL', price: 29.99 } }), 'Ketel One 750 mL is in stock at $29.99 — swap it in?');
}

console.log('accept patterns');
{
  eq('"yes" takes offer_qty', accepted('search.offer_qty', 'yes'), true);
  eq('"4" takes offer_qty', accepted('search.offer_qty', '4'), true);
  eq('"what about vodka" does not', accepted('search.offer_qty', 'what about vodka'), false);
  eq('"not yet" does not take checkout', accepted('basket.offer_checkout', 'not yet'), false);
  eq('"place the order" takes checkout', accepted('basket.offer_checkout', 'place the order'), true);
  eq('"3" takes the pick hint', accepted('search.pick_hint', '3'), true);
}

console.log('trailer and closers');
{
  const T = 'Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
  eq('deterministic trailer stripped', stripTrailer('Got it — 2x Tito\'s added to your order. ' + T), "Got it — 2x Tito's added to your order.");
  eq('short trailer stripped', stripTrailer('Basket:\n5x A\n\nWould you like to place the order, generate a PDF proposal, or make any changes?'), 'Basket:\n5x A');
  eq('a real question is not a trailer', stripTrailer('Which size works for you?'), 'Which size works for you?');
  const g = splitCloser("We have *Tito's Handmade Vodka* — 750 mL — $24.19.\n\nWant me to add it to your order?");
  eq('generic closer removed', [g.generic, g.question, g.body], [true, false, "We have *Tito's Handmade Vodka* — 750 mL — $24.19."]);
  const r = splitCloser('Tito\'s comes in:\n1. 750 mL — $24.19\n2. 1 L — $31.89\n\nWhich size works for you?');
  eq('real question kept', [r.generic, r.question], [false, true]);
  const both = splitCloser('Which size works for you? Want me to add it?');
  eq('generic after a real question -> still a question turn', [both.generic, both.question, both.body], [true, true, 'Which size works for you?']);
  eq('mixers ask is a real question', splitCloser('Here is your basket.\n\nWould you also like to add mixers, water, soda, ice, or cups?').question, true);
  eq('"Would you like the 1.75 L?" is generic', splitCloser('Tito\'s 1.75 L — $43.99.\n\nWould you like the 1.75 L?').generic, true);
  eq('"...the 750 mL or the 1 L?" is a real choice', splitCloser('Would you like the 750 mL or the 1 L?').question, true);
    eq('order confirmation is a real question', splitCloser('Total $120.00. Shall I go ahead and place it?').generic, false);
    const sub = splitCloser("Grey Goose 3.5 L is not available.\n\n1. *Grey Goose Vodka 1.75 L* — $54.40 ea\n\nWould you like to substitute with one of these sizes? If you'd like 2x of the 1.75 L as the closest alternative, just say the word!");
  eq('substitute offer + "just say the word" -> both removed (Sep 29 QA)', [sub.generic, sub.question, sub.body.endsWith('$54.40 ea')], [true, false, true]);
  const mixed = splitCloser('Which size works for you? If you want, just say the word!');
  eq('real question + nudge -> nudge removed, still a question turn', [mixed.generic, mixed.question], [true, true]);
  eq('substitute size spaced', text({ kind: 'item_unavailable', substitute: { name: 'Grey Goose Vodka', size: '1.75L', price: 54.4 } }), 'Grey Goose Vodka 1.75 L is in stock at $54.40 — swap it in?');
    eq('"For the X, would you like me to search for alternatives…?" is generic (Sep 29 QA)', splitCloser('Grey Goose 3.5 L isn\'t available.\n\nFor the *Grey Goose Vodka 3.5 L*, would you like me to search for alternatives — either a different Grey Goose size or a similar premium vodka?').generic, true);
    eq('"place an order, or anything else I can help with?" is generic (Sep 29 QA)', splitCloser('Tito\'s 1.75 L — $43.99\n\nWould you like to place an order, or is there anything else I can help with?').generic, true);
  eq('"Which size, or anything else I can help with?" stays real', splitCloser('Which size would you like, or is there anything else I can help with?').question, true);
    eq('no question', splitCloser('Done — Tito\'s added.').question, false);
  eq('substitute ask is generic', splitCloser('Grey Goose 1 L is not available.\n\nWould you like me to find a substitute?').generic, true);
}

console.log('questions anywhere in the reply');
{
  const mid = "*Grey Goose Vodka 3.5 L* isn't available. The largest size is 1.75 L at $54.40. Would you like to substitute 2x Grey Goose 1.75 L (or another size) instead?\n\n1. *Grey Goose Vodka 1.75 L* — $54.40 ea";
  eq('a mid-reply substitute offer is not a real question', hasRealQuestion(mid), false);
  eq('...and is scrubbed when the CTA is added', /substitute/.test(scrubGenericQuestions(mid)), false);
  eq('the facts around it stay', scrubGenericQuestions(mid).includes('The largest size is 1.75 L at $54.40.'), true);
  eq('a mid-reply real question counts', hasRealQuestion('*WHISKEY*\nWhich one would you like?\n\n*TEQUILA*\n1. Don Julio — 750 mL — $49.99'), true);
}

console.log('fallbackIfEmpty: a trailer-only reply never goes out empty (Sep 29 Slack no_text)');
{
  const cta = require('../../cta.js');
  const trailerOnly = stripTrailer('Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?');
  eq('trailer-only strips to empty', trailerOnly, '');
  const fb = cta.fallbackIfEmpty(trailerOnly, {}, { kind: 'informational' }, 3, q);
  eq('with a basket: ack + order/proposal offer', fb && fb.text, 'Got it. Would you like me to place the order, or send you a PDF proposal?');
  eq('with a basket: CTA recorded', fb && fb.cta && fb.cta.id, 'basket.offer_order_or_proposal');
  const fb0 = cta.fallbackIfEmpty('  ', {}, { kind: 'informational' }, 0, q);
  eq('empty basket', fb0 && fb0.text, 'Got it. What else can I get you?');
  eq('non-empty reply untouched', cta.fallbackIfEmpty('No problem!', {}, { kind: 'informational' }, 3, q), null);
}

console.log('denumberBasketLines (Sep 29: package spirits rendered as a numbered list)');
{
  const cta = require('../../cta.js');
  const pkg = 'SPIRITS — 5 bottles\n1. Vodka: 1x Belvedere Organic Vodka ⭐ — 1.75 L — $59.39\n2. Rum: 1x Barrell Craft Spirits Cask Strength Rum — 750 mL — $98.99\n*Spirits total: $158.38*';
  eq('quantity lines lose the number', cta.denumberBasketLines(pkg), 'SPIRITS — 5 bottles\nVodka: 1x Belvedere Organic Vodka ⭐ — 1.75 L — $59.39\nRum: 1x Barrell Craft Spirits Cask Strength Rum — 750 mL — $98.99\n*Spirits total: $158.38*');
  eq('"1. 3x Tito\'s" too', cta.denumberBasketLines('1. 3x Tito\'s — $24.19'), '3x Tito\'s — $24.19');
  const opts = '1. *Whispering Angel Rosé* — 750 mL — $24.19\n2. *The Beach Rosé* — 750 mL — $20.89';
  eq('a real option list keeps its numbers', cta.denumberBasketLines(opts), opts);
  eq('"24x12 Oz" pack size is not a quantity', cta.denumberBasketLines('1. Stella Artois 24x12 Oz — $62.99'), '1. Stella Artois 24x12 Oz — $62.99');
}
console.log('basket_idle: a basket and no question is never a dead end (Sep 29 "No problem!")');
{
  const cta = require('../../cta.js');
  eq('offers order or proposal', (chooseCta({}, { kind: 'basket_idle' }, q) || {}).id, 'basket.offer_order_or_proposal');
  eq('not twice in a row', chooseCta({}, { kind: 'basket_idle', prevCta: 'basket.offer_order_or_proposal' }, q), null);
  eq('not during an order', chooseCta({}, { kind: 'basket_idle', orderStarted: true }, q), null);
  eq('"send the proposal" accepted', accepted('basket.offer_order_or_proposal', 'send the proposal'), true);
}

console.log('a generic alternative is cut off a real question (Sep 29 smoke flake, cta-search-single)');
{
  const tito = "Yes! We have it:\n\n*Tito's Handmade Vodka* — 1.75 L — $43.99\n\nHow many bottles would you like, or is there anything else I can help with?";
  const r = trimGenericAlternative(tito);
  eq('the tail goes, the question stays', r.text.split('\n').pop(), 'How many bottles would you like?');
  eq('what was cut is reported', r.cut, ['or is there anything else I can help with?']);
  eq('still a question turn after', splitCloser(r.text).question, true);
  eq('bold question keeps its markup', trimGenericAlternative('*Which size works, or anything else?*').text, '*Which size works?*');
  eq('a real choice is not cut', trimGenericAlternative('Which do you want, the 750 mL or the 1.75 L?').cut, []);
  eq('a mixers list is not cut', trimGenericAlternative('How many bottles, and would you like ice or cups?').cut, []);
  eq('a generic-only question is left to splitCloser', trimGenericAlternative('Would you like to place an order, or is there anything else I can help with?').cut, []);
}

console.log(failed ? '\ncta: ' + failed + ' FAILED' : '\ncta: all passed');
process.exit(failed ? 1 : 0);
