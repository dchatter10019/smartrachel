// Unit tests for basket-hygiene.js — a pending not-carried line is cleared only by a basket line that stands in for IT.
// (precheck.sh runs qa/unit/*.test.js.)
const BH = require('../../basket-hygiene.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
// Oct 5, DC, Slack (SF): "Sonoma Classic Simple Syrup 24.5oz" (not carried) was cleared by the mango syrup line of
// another request item, so the later Sonoma pick went in at 1x instead of 3x.
const req = '4 x The Prisoner Red Blend 750mL\n6 x Simply Squeeze Mango Real Puree Infused Syrup 16.9oz\n3 x Sonoma Classic Simple Syrup 24.5oz';
const st = { originalRequest: req, pendingSubstitutes: ['Sonoma Classic Simple Syrup 24.5oz'],
  lastLineItems: JSON.stringify([{ label: 'Simply Squeeze Mango Real Puree Infused Syrup 16.9oz', name: "Simply Squeeze Mango Re'al Puree Infused Syrup 16.9 OZ", qty: 6, price: 9.12 }]) };
eq('another request item\'s line (same kind) does not clear it', BH.check(st, {}).pendingCleared, []);
st.lastLineItems = JSON.stringify([{ label: 'Sonoma Classic Simple Syrup 24.5 OZ', name: 'Sonoma Classic Simple Syrup 24.5 OZ', qty: 3 }]);
eq('its own pick clears it', BH.check(st, {}).pendingCleared, [{ pending: 'Sonoma Classic Simple Syrup 24.5oz', by: 'Sonoma Classic Simple Syrup 24.5 OZ' }]);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
