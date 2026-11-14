// Nov 14 (DC, "Bevvi - Nov 14th Delivery"): same-day date kept this year, next-line form fields, name labels.
const C = require('../../chrono-today.js');
const EO = require('../../email-order.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const now = new Date(2026, 10, 14, 13, 50);   // Nov 14, 2026 1:50 PM local
ok('"Saturday 11/14" on Nov 14 = 2026, not 2027', C.parse('Saturday 11/14 (1-3pm ET)', now)[0].start.date().getFullYear() === 2026);
ok('"11/13" on Nov 14 = next year (forward date kept)', C.parse('11/13 at 1pm', now)[0].start.date().getFullYear() === 2027);
ok('a stated year is kept', C.parse('11/14/2027 1pm', now)[0].start.date().getFullYear() === 2027);
const fwd = 'I want to place the order.\n\n---------- Forwarded message ---------\nFrom: Sean Fitzgibbons <sean@getbevvi.com>\nSubject: x\n\nKiran,\n\n*Delivery Window:*\n\nSaturday 11/14 (1-3pm ET)\n\n*Delivery Instructions:*\n\nDeliver to the 3rd floor\n\n*On-Site Contact:*\n\nDiana Maranzano | 212-288-3500\n\nThanks!\nSean';
const x = EO.extract(fwd, { name: 'Dipanjan Chatterjee', email: 'dipanjan@getbevvi.com' }, now);
ok('on-site contact on the next line, in a colleague\'s forward: name', x.name === 'Diana Maranzano');
ok('... and phone', x.phone === '(212) 288-3500');
ok('delivery instructions block on the next line, stops at the next label', x.instructions === 'Deliver to the 3rd floor');
ok('today written as a date is the delivery date', x.date === 'Saturday 11/14');
ok('"First and last Name:" is the name', EO.extract('First and last Name: Diana Maranzano', { email: 'dipanjan@getbevvi.com' }, now).name === 'Diana Maranzano');
ok('"First name and last Name:" is the name', EO.extract('First name and last Name: Diana Maranzano', { email: 'dipanjan@getbevvi.com' }, now).name === 'Diana Maranzano');
ok('"earlier today" is still not a date', EO.timing(['the proposal curated earlier today?'], now).date === '');
ok('"Create the order now": now is not a delivery time', !EO.timing(['Create the order now'], now).time && !EO.timing(['Create the order now'], now).when);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
