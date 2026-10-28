// Unit tests for delivery-instructions.js — the driver's note only (DC, Oct 28: claude.ai sent "Company: Google. Call Diana
// Orozco at 415-629-2488 when you arrive. Replaces unpaid orders BEVVI-AI-INFO-..."). (precheck runs these.)
const D = require('../../delivery-instructions.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const C = t => { const r = D.clean(t); return { text: r.text, company: r.company }; };

eq('DC Oct 28: company + replaced orders out', C('Company: Google. Call Diana Orozco at 415-629-2488 when you arrive. Replaces unpaid orders BEVVI-AI-INFO-20261028-031625 and BEVVI-AI-INFO-20261028-032100.'),
  { text: 'Call Diana Orozco at 415-629-2488 when you arrive.', company: 'Google' });
eq('replacement + swap note out', C('Delivery contact: Diana Orozco, 415-629-2488. Replaces order BEVVI-AI-INFO-20261028-031625 (unpaid) — ice swapped to Arctic Glacier 9 LB.'),
  { text: 'Delivery contact: Diana Orozco, 415-629-2488.', company: '' });
eq('a real driver note is kept', C('Main POC is Mara (862) 555-0100. Loading dock on 5th Ave, COI required. Ring buzzer 4B.'),
  { text: 'Main POC is Mara (862) 555-0100. Loading dock on 5th Ave, COI required. Ring buzzer 4B.', company: '' });
eq('doorman note kept', C('Leave with the doorman; call if no answer'), { text: 'Leave with the doorman; call if no answer', company: '' });
eq('empty', C(''), { text: '', company: '' });

// No name in front of the street on the order address (DC, Oct 28: "Google, 1395 Charleston Rd").
const S = a => require('../../address-extract.js').stripLeadingName(a);
eq('company before the street dropped', S('Google, 1395 Charleston Rd, Mountain View, CA 94043'), { address: '1395 Charleston Rd, Mountain View, CA 94043', dropped: 'Google' });
eq('c/o line dropped', S('c/o Acme Corp, 11 Madison Ave, New York, NY 10010').address, '11 Madison Ave, New York, NY 10010');
eq('suite after the street kept', S('11 Madison Ave, Floor 5, New York, NY 10010').address, '11 Madison Ave, Floor 5, New York, NY 10010');
eq('PO box left alone', S('PO Box 12, Smalltown, VT 05001').address, 'PO Box 12, Smalltown, VT 05001');

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('delivery-instructions: all passed');
