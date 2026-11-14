// A fresh forward in a thread Rachel already answered = a NEW conversation (DC, Nov 14). Nov 14 03:09: DC re-forwarded
// Esthefany's original HI USA order; it continued yesterday's half-done email order (time-zone question, date Nov 14).
const EL = require('../../email-link.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const fwd = (own, from) => own + '\r\n\r\n---------- Forwarded message ---------\r\nFrom: ' + from + '\r\nDate: Fri, Nov 13, 2026 at 3:10 PM\r\nSubject: Order Request\r\n\r\nWe would like to place an order for the following items: ...';
const client = 'Esthefany Fernandez <esthefany@eterrakitchen.com>';
ok('re-forwarded client order + "create a proposal" = new', EL.freshForward({ subject: 'Fwd: Order Request – HI USA NYC Hostel', body: fwd('can you show be a proposal for wines around $15? Create a proposal. I am over 21', client) }).fresh);
ok('"send me proposal ... under $15" = new', EL.freshForward({ subject: 'Fwd: New Beverage Order – November 17', body: fwd('I am over 21.. can you send me proposal? Please ensure that the wine bottles do not exceed $15.', client) }).fresh);
ok('forward of Rachel\'s own reply = same conversation', !EL.freshForward({ subject: 'Fwd: Fwd: New Beverage Order', body: fwd('Price of wine cannot exceed $15', 'Rachel AI <rachelai@getbevvi.com>') }).fresh);
ok('a forwarded edit ("please update the quote") = same conversation', !EL.freshForward({ subject: 'Fwd: Gen II order', body: fwd('Natalia sent edits below, please update the quote', 'Natalia Diaz <n@genii.com>') }).fresh);
ok('"for the same proposal" = same conversation', !EL.freshForward({ subject: 'Fwd: drinks', body: fwd('see below for the same proposal', client) }).fresh);
ok('a reply (Re:) = same conversation', !EL.freshForward({ subject: 'Re: Fwd: Order Request', body: 'yes do that' }).fresh);
ok('"Fwd:" with no forwarded message = same conversation', !EL.freshForward({ subject: 'Fwd: Order Request', body: 'make it 4 cases' }).fresh);
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
