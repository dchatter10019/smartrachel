// Unit tests for pending-original.js — which not-carried item a picked product replaces (by kind).
// (precheck.sh runs qa/unit/*.test.js.)
const po = require('../../pending-original.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
// DC's Goody quote (Oct 1): pending = the three lines the store didn't carry.
const pend = ['Vodka 1.75L', 'Lemon Juice 1L', 'Simple Syrup 2L'];
eq('Ketel One replaces the vodka line', po(pend, 'Ketel One - 1.75 L'), 'Vodka 1.75L');
eq('FIJI water replaces nothing (it took the vodka qty)', po(pend, 'FIJI Natural Artesian Bottled Water 16.9 OZ Btl'), null);
eq('Master of Mixes lemon juice replaces the lemon juice line', po(pend, 'Master Of Mixes Single Pressed Lemon Juice 375 ML'), 'Lemon Juice 1L');
eq('Sonoma simple syrup replaces the syrup line', po(pend, 'Sonoma Classic Simple Syrup 24.5 OZ'), 'Simple Syrup 2L');
eq('a gin replaces no vodka', po(pend, 'Bombay Sapphire Gin 750 ML'), null);
eq('two vodkas pending: ambiguous', po(['Vodka 1.75L', "Tito's Vodka 750ml"], 'Ketel One - 1.75 L'), null);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
