// Unit tests for address-extract.js — the delivery address inside a longer first message / email.
// (precheck.sh runs qa/unit/*.test.js.)
const { findAddress, formatGeocoded } = require('../../address-extract.js');
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
const wrapped = 'Hi,\r\n\r\nPlease send a quote for the items below. . Deliver to 100\r\nFederal Street, Boston, MA 02110.\r\n\r\n2 x Bud Light (30 cans per case)\r\n1 Oyster Bay Sauvignon Blanc\r\n\r\nThanks!';
eq('Gmail hard wrap after the street number (Oct 1)', findAddress(wrapped), '100 Federal Street, Boston, MA 02110');
eq('hard wrap before the street suffix', findAddress('Deliver to 100 Federal\nStreet, Boston, MA 02110'), '100 Federal Street, Boston, MA 02110');
eq('"#6" at a line end is a unit, not a street number', findAddress('address is 100 Federal St #6\nBoston, MA 02110'), '100 Federal St #6, Boston, MA 02110');
eq('no address', findAddress('need 2 cases of Bud Light for 30 people'), null);
eq('a quantity list is not an address', findAddress('2 x Budlight (30 cans per case)\n2 x Carlsberg (12 cans per case)'), null);

// formatGeocoded: the address echoed after Google geocodes it (components are real Google replies, Sep 29).
const C = (...a) => a.map(([t, v]) => ({ types: [t], short_name: v, long_name: v }));
const federal = C(['subpremise', '6'], ['premise', '100 Federal Street'], ['street_number', '100'], ['route', 'Federal St'], ['neighborhood', 'Downtown'], ['locality', 'Boston'], ['administrative_area_level_1', 'MA'], ['country', 'US'], ['postal_code', '02110']);
eq("Sean (Sep 29): building name dropped, customer's floor kept", formatGeocoded(federal, '100 Federal Street, Floor 6, Boston, MA 02110'), '100 Federal St, Floor 6, Boston, MA 02110');
eq('no unit typed: Google subpremise', formatGeocoded(federal, '100 Federal Street, Boston'), '100 Federal St, #6, Boston, MA 02110');
eq('"6th floor" kept', formatGeocoded(federal, '100 Federal St 6th floor Boston MA'), '100 Federal St, 6th floor, Boston, MA 02110');
const w53 = C(['street_number', '425'], ['route', 'W 53rd St'], ['political', 'Manhattan'], ['locality', 'New York'], ['administrative_area_level_1', 'NY'], ['country', 'US'], ['postal_code', '10019']);
eq('sloppy typing cleaned, no unit', formatGeocoded(w53, '425 west 53rd st, NY, NY 10019'), '425 W 53rd St, New York, NY 10019');
eq('the zip is never a unit', formatGeocoded(w53, '425 W 53rd St, New York, NY 10019'), '425 W 53rd St, New York, NY 10019');
const bway = C(['subpremise', '200'], ['street_number', '11'], ['route', 'Broadway'], ['locality', 'New York'], ['administrative_area_level_1', 'NY'], ['postal_code', '10004']);
eq('Suite kept as typed', formatGeocoded(bway, '11 Broadway Suite 200, New York, NY 10004'), '11 Broadway, Suite 200, New York, NY 10004');
eq('no street number -> null (caller falls back)', formatGeocoded(C(['route', 'Broadway'], ['postal_code', '10004']), 'Broadway'), null);

// No commas (Oct 5, DC): went to the LLM, which never changed the address.
eq('no commas', findAddress('375 Revere St Revere MA 02151'), '375 Revere St, Revere, MA 02151');
eq('no commas, inside a sentence', findAddress('i had changed it to 375 Revere St Revere MA 02151'), '375 Revere St, Revere, MA 02151');
eq('a quantity line is not an address', findAddress('44 bottles of prosecco and the budget is 1000'), null);

// Address + request in one message (Oct 9, connector): the whole sentence was saved as the address, the order ignored.
const { splitAddress } = require('../../address-extract.js');
const sj = (t) => JSON.stringify(splitAddress(t));
eq('address then order', sj("1 Rockefeller Plaza, New York, NY 10019. Add 3 Tito's 750ml and a case of Stella."), JSON.stringify({ address: '1 Rockefeller Plaza, New York, NY 10019', rest: "Add 3 Tito's 750ml and a case of Stella." }));
eq('order "to" address: the quantity is not the street', sj('Send 2 cases of Stella to 425 W 53rd St, New York, NY 10019'), JSON.stringify({ address: '425 W 53rd St, New York, NY 10019', rest: 'Send 2 cases of Stella' }));
eq('"deliver to ... please" leaves nothing', sj('deliver to 425 W 53rd St, New York, NY 10019 please'), JSON.stringify({ address: '425 W 53rd St, New York, NY 10019', rest: null }));
eq('a unit stays in the address', sj('100 Federal Street, Floor 6, Boston, MA 02110'), JSON.stringify({ address: '100 Federal Street, Floor 6, Boston, MA 02110', rest: null }));
eq('no address', splitAddress('need 2 cases of Bud Light'), null);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
