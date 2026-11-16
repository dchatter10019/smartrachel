// Nov 16 (DC on Slack): "make the delivery to 0" at the order summary was not read; "Frank Acosta, 6466103382, <email>,
// tomorrow 3 pm EST" after "Ordering as ..." changed only the time.
const assert = require('assert');
const T = require('../../tax-command.js');
const C = require('../../customer-contacts.js');
for (const m of ['make the delivery to 0', 'make the delivery to be 0', 'make delivery 0', 'set delivery to zero', 'delivery fee 0', 'free delivery'])
  assert.strictEqual((T.fees(m) || {}).delivery_fee, 0, m);
assert.strictEqual((T.fees('make delivery 15 dollars') || {}).delivery_fee, 15);
for (const m of ['delivery to 10019', 'deliver to 1460 Broadway', 'delivery to 1460 Broadway', 'make the delivery at 3', 'change the delivery time to 4', 'delivery by 5'])
  assert.strictEqual(T.fees(m), null, m);
const c = C.contactChangeIn('Frank Acosta, 6466103382, <mailto:dipanjan@getbevvi.com|dipanjan@getbevvi.com>, tomorrow 3 pm EST');
assert.deepStrictEqual(c, { email: 'dipanjan@getbevvi.com', phone: '6466103382', name: 'Frank Acosta', rest: 'tomorrow 3 pm EST' });
for (const m of ['tomorrow 3 pm EST', 'Nov 18 at 2pm ET', 'Next Tuesday 3 PM', 'same']) assert.strictEqual(C.contactChangeIn(m), null, m);
assert.strictEqual(C.contactChangeIn('use Jane Doe, tomorrow at 4 pm ET').name, 'Jane Doe');
console.log('confirm-fee-contact-nov16: ok');
