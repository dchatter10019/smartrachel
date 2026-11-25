// Nov 25 (DC): "Your consumption rate was approx 1.5 drinks" = 1.5 drinks per person for the WHOLE event, never per hour.
const R = require('../../drink-rate.js');
const D = require('../../drinks-check.js');
let failed = 0;
function eq(label, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want))); }
eq('consumption rate', (R.rateIn('• _Your consumption rate was approx 1.5 drinks. That is approved._') || {}).dpp, 1.5);
eq('N drink consumption rate', (R.rateIn('factoring in the 1.5 drink consumption rate') || {}).dpp, 1.5);
eq('per person', (R.rateIn('2 drinks per person') || {}).dpp, 2);
eq('per hour is not this rate', R.rateIn('1.5 drinks per person per hour'), null);
eq('no rate', R.rateIn('100 guests, 3 hours'), null);
const ck = D.check([{ name: 'Stella Artois 24 x 12 OZ Bottles', qty: 10, category: 'beer' }], { guests: 100, hours: 2, dpp: 1.5 });
eq('target = guests x rate', ck.target, 150);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
