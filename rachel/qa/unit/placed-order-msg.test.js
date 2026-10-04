// Unit tests for placed-order-msg.js — messages about an order Rachel already placed.
// (precheck.sh runs qa/unit/*.test.js.)
const P = require('../../placed-order-msg.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const bj = 'Hi,\n\nI just made the payment. Could you please update the recipient name to Mara\nMiller, and that the delivery people say they are delivering from Foodie\nFor All for COI purposes?';
eq('BJ (Oct 4): paid + recipient/driver note', P.classify(bj), 'paid');
eq('BJ: the request sentence kept', P.requestSentences(bj), ['Could you please update the recipient name to Mara Miller, and that the delivery people say they are delivering from Foodie For All for COI purposes?']);
eq('"paid!"', P.classify('Paid, thanks!'), 'paid');
eq('"payment is complete"', P.classify('Payment is complete.'), 'paid');
eq('"we have paid"', P.classify('We have paid the invoice'), 'paid');
eq('not paid yet is not a report', P.paidClaim("I haven't paid yet, can you add 2 more cases of Corona?"), false);
eq('question about payment is not a report', P.paidClaim('Has it been paid?'), false);
eq('detail change only', P.classify('Can you change the on-site contact to Mara, 862-252-5077?'), 'details');
eq('delivery instructions', P.classify('Please add delivery instructions: use the loading dock on 31st'), 'details');
eq('item change -> reopen question', P.classify('Can you add 2 more bottles of Grey Goose?'), null);
eq('paid + item change', P.classify('I paid, but can we add another case of Corona?'), 'paid_items');
eq('thanks only', P.classify('Looping in BJ to process payment!'), null);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
