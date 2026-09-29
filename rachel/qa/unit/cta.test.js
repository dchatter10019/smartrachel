// Unit tests for cta.js (Learning Phase 1, Part B): every table row reachable from a hand-built state,
// declined CTAs not repeated, question turns get none, disabled rows skipped, accept patterns.
// (precheck.sh runs every qa/unit/*.test.js during lint.)
const { chooseCta, accepted, TABLE } = require('../../cta.js');
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
    [{ kind: 'basket_built', eventDateKnown: false }, 'basket.ask_event_date'],
    [{ kind: 'basket_built', eventDateKnown: true, corporate: true }, 'basket.offer_proposal'],
    [{ kind: 'basket_built', eventDateKnown: true, corporate: false }, 'basket.offer_checkout'],
    [{ kind: 'basket_updated', orderStarted: false }, 'basket.offer_checkout'],
    [{ kind: 'item_unavailable', substitute: { name: 'Ketel One', size: '750 mL', price: 29.99 } }, 'sub.offer_named'],
    [{ kind: 'item_unavailable' }, 'sub.offer_search'],
    [{ kind: 'proposal_sent' }, 'proposal.offer_order'],
  ];
  for (const [t, want] of cases) { const got = pick(t); reached.add(got); eq(t.kind + ' -> ' + want, got, want); }
  const enabled = Object.values(TABLE).flat().filter(c => c.enabled !== false && !c.none).map(c => c.id);
  eq('all enabled ids covered', enabled.filter(id => !reached.has(id)), []);
}

console.log('none cases');
{
  eq('question turn -> none', pick({ kind: 'basket_built', question: true }), null);
  eq('order_placed -> none (save_package disabled)', pick({ kind: 'order_placed', basketItems: 3 }), null);
  eq('informational -> none', pick({ kind: 'informational' }), null);
  eq('basket_updated after order started -> none', pick({ kind: 'basket_updated', orderStarted: true }), null);
  eq('unknown state -> none', pick({ kind: 'weird' }), null);
  eq('round_up disabled even when it would hold', pick({ kind: 'basket_built', eventDateKnown: true, drinksPerGuest: 1, drinksFloor: 4, corporate: false }), 'basket.offer_checkout');
}

console.log('declined is not repeated');
{
  eq('checkout declined -> none for basket_updated', pick({ kind: 'basket_updated' }, { ctaDeclined: ['basket.offer_checkout'] }), null);
  eq('date declined -> next rank', pick({ kind: 'basket_built', eventDateKnown: false }, { ctaDeclined: ['basket.ask_event_date'] }), 'basket.offer_checkout');
}

console.log('texts');
{
  eq('spirits default 3', text({ kind: 'search_single', category: 'spirits' }), 'Want 3 of those?');
  eq('wine default 6', text({ kind: 'search_single', category: 'wine' }), 'Want 6 of those?');
  eq('stated qty wins', text({ kind: 'search_single', category: 'wine', statedQty: 2 }), 'Want 2 of those?');
  eq('named substitute', text({ kind: 'item_unavailable', substitute: { name: 'Ketel One', size: '750 mL', price: 29.99 } }), 'Ketel One 750 mL is in stock at $29.99 — swap it in?');
}

console.log('accept patterns');
{
  eq('"yes" takes offer_qty', accepted('search.offer_qty', 'yes'), true);
  eq('"4" takes offer_qty', accepted('search.offer_qty', '4'), true);
  eq('"what about vodka" does not', accepted('search.offer_qty', 'what about vodka'), false);
  eq('"next Friday" takes the date ask', accepted('basket.ask_event_date', 'next Friday'), true);
  eq('"Oct 12" takes the date ask', accepted('basket.ask_event_date', 'it is on Oct 12'), true);
  eq('"not sure yet" does not', accepted('basket.ask_event_date', 'not sure yet'), false);
  eq('"not yet" does not take checkout', accepted('basket.offer_checkout', 'not yet'), false);
  eq('"place the order" takes checkout', accepted('basket.offer_checkout', 'place the order'), true);
  eq('"3" takes the pick hint', accepted('search.pick_hint', '3'), true);
}

console.log(failed ? '\ncta: ' + failed + ' FAILED' : '\ncta: all passed');
process.exit(failed ? 1 : 0);
