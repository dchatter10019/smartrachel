// Unit tests for email-body.js stripSignature — the sender's signature is not part of the request.
// (precheck.sh runs qa/unit/*.test.js.)
const { stripSignature } = require('../../email-body.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const SIG = '\n\n\n\n\nDipanjan Chatterjee\nCEO | Bevvi\n\n\ngetbevvi.com | @getbevvi';
const DC = 'Dipanjan Chatterjee';
// Real replies in DC's Goody thread (Oct 1).
eq('"Goody" + signature (became the PDF client name)', stripSignature('Goody' + SIG, DC).text, 'Goody');
eq('"Ketel one" + signature (read as a 4-part pick)', stripSignature('Ketel one' + SIG, DC).text, 'Ketel one');
eq('"8th Oct" + signature', stripSignature('8th Oct' + SIG, DC).text, '8th Oct');
eq('two-line request kept whole', stripSignature('What waters do you have that match the request?\n\nYou do have athletic\n\n\nDipanjan Chatterjee\nCEO | Bevvi\n\n\ngetbevvi.com | @getbevvi', DC).text,
  'What waters do you have that match the request?\n\nYou do have athletic');
eq('CRLF body', stripSignature('Yes\r\n\r\n\r\n\r\n\r\nDipanjan Chatterjee\r\nCEO | Bevvi\r\n\r\n\r\ngetbevvi.com | @getbevvi', DC).text, 'Yes');
const first = 'Can you help me with this request\n\n• 2 × 1.75L vodka\n\nKatie Weeks assuming / planning that we\'ll get garnish + ice day-of via Instacart!' + SIG;
eq('first email: list + another person named mid-text kept', stripSignature(first, DC).text, 'Can you help me with this request\n\n• 2 × 1.75L vodka\n\nKatie Weeks assuming / planning that we\'ll get garnish + ice day-of via Instacart!');
// No From name: the trailing contact block.
eq('no sender name: contact block after a gap', stripSignature('Goody' + SIG, '').text, 'Goody\n\n\n\n\nDipanjan Chatterjee\nCEO | Bevvi');
eq('no sender name, "-- " marker', stripSignature('Make it 3 cases\n\n-- \nSean Lee\nGen II Fund', '').text, 'Make it 3 cases');
eq('Sent from my iPhone', stripSignature('yes please\n\n\nSent from my iPhone', '').text, 'yes please');
// Never cut real content.
eq('no signature: unchanged', stripSignature('2 x Bud Light\n1 Oyster Bay', DC).text, '2 x Bud Light\n1 Oyster Bay');
eq('the name alone is never cut to nothing', stripSignature('Dipanjan Chatterjee', DC).text, 'Dipanjan Chatterjee');
eq('a trailing item list is not a signature', stripSignature('Order:\n\n\n2 x Bud Light cases\nwww.bevvi.com link', '').text, 'Order:\n\n\n2 x Bud Light cases\nwww.bevvi.com link');
eq('the client named after the sender name is not cut', stripSignature('client should be Dipanjan Chatterjee', DC).text, 'client should be Dipanjan Chatterjee');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
