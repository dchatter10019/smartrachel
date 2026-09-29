// Unit tests for address-extract.js — the delivery address inside a longer first message / email.
// (precheck.sh runs qa/unit/*.test.js.)
const { findAddress } = require('../../address-extract.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const sean = 'Hi,\r\n\r\nI need an alcohol menu quote that includes the below items.\r\n\r\nI am 21 years old. The delivery address is 100 Federal Street, Floor 6\r\nBoston, MA 02110\r\n\r\nItem Request:\r\n\r\n2 x Budlight (30 cans per case)\r\n2 x Michelop ULTRA (30 cans per case)';
eq("Sean's email (Sep 29): unit line + line break", findAddress(sean), '100 Federal Street, Floor 6, Boston, MA 02110');
eq('one line', findAddress('deliver to 425 W 53rd St, New York, NY 10019 please'), '425 W 53rd St, New York, NY 10019');
eq('suite', findAddress('Send it to 1800 Palm Beach Lakes Blvd, Suite 200, West Palm Beach, FL 33409.'), '1800 Palm Beach Lakes Blvd, Suite 200, West Palm Beach, FL 33409');
eq('multi-line block', findAddress('Address:\n11 Madison Ave\nNew York, NY 10010\nThanks'), '11 Madison Ave, New York, NY 10010');
eq('an age sentence before it is not part of it', findAddress('I am 21 years old. My address is 11 Madison Ave, New York, NY 10010'), '11 Madison Ave, New York, NY 10010');
eq('St. abbreviation', findAddress('deliver to 5 Main St., Boston, MA 02110'), '5 Main St., Boston, MA 02110');
eq('no address', findAddress('need 2 cases of Bud Light for 30 people'), null);
eq('a quantity list is not an address', findAddress('2 x Budlight (30 cans per case)\n2 x Carlsberg (12 cans per case)'), null);

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
