// email-order.js extract on a Bevvi-staff payment-link email (Oct 2, Sean's Foodie For All order, details anonymized):
// the customer's email ("Payment link should be sent to:"), the on-site contact + phone ("Main POC is ..."), and the
// delivery-instructions paragraph were all missed — Rachel asked for name, email, phone, date and time.
const E = require('../../email-order.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const msg = 'Hi Rachel,\n\nCan you please generate a payment link for this order?\n\nPayment link should be sent to: *pat@example-client.com\n<pat@example-client.com> *\n\n'
  + 'Also, here are the delivery instructions for the order:\n\n*Main POC is Jordan (555) 201-3344 <(555)%20201-3344>. Please let us know\nwhat time we should expect the delivery, and they should say they\'re\ndelivering from Example Co to avoid any COI issues.*\n\n'
  + '*Address: 10 West 30th Street , 8th Floor\n<https://www.google.com/maps/search/10+West+30th?entry=gmail&source=g>New\nYork , NY 10001\n<https://www.google.com/maps/search/10+West+30th?entry=gmail&source=g>*\n'
  + '*Freight: Loading dock on the left side.*\n\nThanks!';
const x = E.extract(msg, { name: 'Sean Staff', email: 'sean@getbevvi.com' }, new Date('2026-10-02T12:00:00Z'));
eq('customer email = the payment-link recipient', [x.email, x.link_to], ['pat@example-client.com', ['pat@example-client.com']]);
eq('on-site contact name + phone ("Main POC is Jordan (555) ...")', [x.name, x.phone], ['Jordan', '(555) 201-3344']);
eq('the delivery-instructions paragraph is kept, Gmail links cut', [/Main POC is Jordan/.test(x.instructions), /8th Floor/.test(x.instructions), /Loading dock/.test(x.instructions), /google\.com|%20|\*/.test(x.instructions)], [true, true, true, false]);
eq('a first name only asks for the last name, not everything', E.missing({ name: 'Jordan', email: 'pat@example-client.com', phone: '(555) 201-3344', delivery_ok: true }), ["Jordan's last name"]);
eq('"contact us" is not a contact name', E.pocIn(['please contact us if needed']), null);

// Oct 3 (same thread): the customer's details as a pasted form, each value on the line AFTER its label, and the on-site
// contact's phone wrapped onto the next line. Before: none read; "Jordan" (the POC) became the customer and every
// "place the order" asked for Jordan's last name.
const form = '*Customer Name: *\nPat Example-Lee\n\n*Customer Email:*\npat@example-client.com\n\n*Customer Phone Number: *\n(555) 201-3344\n\n'
  + '*Delivery date and time:*\nMonday, October 5th, between 5 to 6 PM\n\n*Delivery address:*\n10 W 30th St New York, NY 10001\n\n'
  + '*Please see the delivery instructions below:Main POC is Jordan **(555)\n201-3344 <5552013344>**. Please let us know what time.*';
const f = E.extract(form, { name: 'Sean Staff', email: 'sean@getbevvi.com' }, new Date('2026-10-03T12:00:00Z'));
eq('form fields on the next line: name, email, phone', [f.name, f.email, f.phone], ['Pat Example-Lee', 'pat@example-client.com', '(555) 201-3344']);
eq('the typed customer wins over the on-site contact', E.missing({ name: f.name, email: f.email, phone: f.phone, delivery_ok: true }), []);
const two = E.extract('*Customer Name: *\nPat Example-Lee\n\n*Customer Email:*\npat@example-client.com', { name: 'DC', email: 'dc@getbevvi.com' }, new Date());
eq('a short form reply (name + email only)', [two.name, two.email], ['Pat Example-Lee', 'pat@example-client.com']);
const corr = E.extract("You have the name from before. Its's Pat Example-Lee (thatst the first and\nlast name of the customer, Jordan is not not customer)", { name: 'DC', email: 'dc@getbevvi.com' }, new Date());
eq('a name correction ("It\'s <First Last> ... customer")', corr.name, 'Pat Example-Lee');
eq('"its fine, place the order" is not a name', E.extract('its fine, place the order', { email: 'dc@getbevvi.com' }, new Date()).name, '');
eq('a label followed by another label is not a value', E.extract('*Customer Name:*\n*Customer Email:* pat@example-client.com', { email: 'dc@getbevvi.com' }, new Date()).name, '');
eq('"Jordan is not not customer" -> Jordan; "This is not the customer list" -> nothing', [E.notCustomer('the customer, Jordan is not not customer)'), E.notCustomer('This is not the customer list')], [['Jordan'], []]);
const glued = E.extract('Yes place the order and send the payment link to pat@example-client.comand\ncopy Sean and me.', { email: 'dc@getbevvi.com' }, new Date());
eq('"...comand" (missing space) is the .com address, once (Oct 3)', [glued.email, glued.link_to], ['pat@example-client.com', ['pat@example-client.com']]);
eq('a real domain ending is untouched', [E.fixAddr('x@brand.com'), E.fixAddr('x@island.co'), E.fixAddr('x@commander.org')], ['x@brand.com', 'x@island.co', 'x@commander.org']);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
