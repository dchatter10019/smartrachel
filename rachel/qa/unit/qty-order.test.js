// Unit tests for qty-order.js — a stated bottle/case count is an order, never an "is this for an event?" question.
// (precheck.sh runs qa/unit/*.test.js.)
const { statedQuantity } = require('../../qty-order.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const q = m => { const r = statedQuantity(m); return r ? r.qty : null; };
eq("DC (Oct 5): 44 bottles of prosecco + budget", q('44 bottles of prosecco and the budget is $1000'), 44);
eq('no $ sign', q('44 bottles of prosecco and the budget is 1000'), 44);
eq('cases', q('I need 3 cases of Stella, budget $500'), 3);
eq('N x product', q('2 x Veuve Clicquot'), 2);
eq('a budget alone is not a quantity', q('my budget is $1000 for wine'), null);
eq('a price is not a quantity', q('wine around $25 a bottle'), null);
eq('guests make it an event', q('44 bottles of prosecco for 50 guests'), null);
eq('"for 30" makes it an event', q('5 cases of beer for 30'), null);
eq('hours make it an event', q('10 bottles of wine, 3 hours'), null);
eq('party word', q('20 bottles of rose for a party'), null);
eq('a year is not a quantity', q('order for Oct 6 2026'), null);
process.exit(failed ? 1 : 0);
