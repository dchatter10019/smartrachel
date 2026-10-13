// Unit tests for proposal-guard.js — a proposal that disagrees with what the customer said (Oct 13, Sean's Liquid Labs quote).
const G = require('../../proposal-guard.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const NYC = '5f4d1e126a7a0109254a803d', BOS = '689fa0c7aaaaaaaaaaaaaaaa';
const items = [{ name: "Blanton's", qty: 5, price: 241.99, establishmentId: NYC }, { name: 'Weller 12', qty: 5, price: 247.49, establishmentId: NYC }];
const sean = { message: 'Good morning, Rachel.\n\nCan you please get me a quote for the items below? The delivery date is\n12/5 to address 1460 Broadway, New York, NY.\n\n - Blanton x 5',
  subject: 'Menu Request - Liquid Labs 12/5', threadFirst: 'Good morning, Rachel. Can you please get me a quote ...',
  stated: { address: '1460 Broadway, New York, NY 10036', zip: '10036' }, printedStore: BOS, statedStore: NYC, now: new Date('2026-10-13T12:00:00Z') };
const bad = { client_name: 'Gen II Fund', event_date: 'December 5, 2026', notes: 'Delivery: 100 Federal Street, Floor 6, Boston, MA 02110.', line_items: items };
const f = G.check(bad, sean);
eq("Sean's PDF: address + client wrong, both fixable", f.map(x => [x.field, x.expected, x.fixable]), [['address', '1460 Broadway, New York, NY 10036', true], ['client', 'Liquid Labs', true]]);
const good = { client_name: 'Liquid Labs', event_date: 'December 5, 2026', notes: 'Delivery: 1460 Broadway, New York, NY 10036.', line_items: items };
eq('the corrected PDF passes', G.check(good, Object.assign({}, sean, { printedStore: NYC })), []);
eq('a client the customer named in the thread is kept', G.check(Object.assign({}, good, { client_name: 'Acme' }), Object.assign({}, sean, { printedStore: NYC, threadFirst: 'quote for Acme please' })), []);
eq('no subject (Slack): client never checked', G.check(Object.assign({}, good, { client_name: 'Acme' }), Object.assign({}, sean, { subject: '', printedStore: NYC })), []);
eq('a date in the message that differs', G.check(good, Object.assign({}, sean, { printedStore: NYC, message: 'make it for 12/6 please', stated: null })).map(x => [x.field, x.expected]), [['date', 'December 6, 2026']]);
eq('lines from another store, no stated address: flagged, not fixable', G.check(good, Object.assign({}, sean, { printedStore: BOS, stated: null, message: 'send the proposal' })).map(x => [x.field, x.fixable]), [['store', false]]);
eq('no Delivery line (address hidden): no address/store check', G.check(Object.assign({}, good, { notes: '' }), Object.assign({}, sean, { printedStore: BOS })), []);
eq('printedAddress', G.printedAddress('Delivery: 100 Federal Street, Floor 6, Boston, MA 02110. Call ahead.'), '100 Federal Street, Floor 6, Boston, MA 02110');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
