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
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
