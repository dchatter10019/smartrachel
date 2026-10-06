// Unit tests for tax-command.js — tax set to $0 / restored, and the address left off the proposal (DC, Oct 5).
// (precheck.sh runs qa/unit/*.test.js.)
const T = require('../../tax-command.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
eq('"the tax shouldbe 0" (DC, typo)', T.read('the tax shouldbe 0'), 'zero');
eq('"Estimated tax (10%): $79.16 is 0" (DC)', T.read('Estimated tax (10%): $79.16 is 0'), 'zero');
eq('no tax', T.read('no tax please'), 'zero');
eq('tax exempt', T.read('this order is tax exempt'), 'zero');
eq('set tax to 0', T.read('set tax to 0'), 'zero');
eq('add the tax back', T.read('add the tax back'), 'restore');
eq('a question is not a command', T.read('is there tax?'), null);
eq('a 10% statement is not zero', T.read('the tax is 10%'), null);
eq('a rate is not zero', T.read('tax rate is 0.0625'), null);
eq('take out the deivery address from the propsal (DC, typos)', T.proposalAddress('take out the deivery address from the propsal'), 'hide');
eq("don't show the address on the pdf", T.proposalAddress("don't show the address on the pdf"), 'hide');
eq('take the delivery address off the proposal (verb split)', T.proposalAddress('Please take the delivery address off the proposal.'), 'hide');
eq('put the address back on the proposal', T.proposalAddress('put the address back on the proposal'), 'show');
eq('an address change is not about the proposal', T.proposalAddress('change the address'), null);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
