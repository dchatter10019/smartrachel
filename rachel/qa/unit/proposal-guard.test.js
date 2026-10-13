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
// Oct 13 (Sean): the sender billed as the client while the subject names one — his signature is in the thread's first email
eq("sender's own name billed: corrected to the subject's client", G.check(Object.assign({}, good, { client_name: 'Sean Fitzgibbons' }),
  Object.assign({}, sean, { printedStore: NYC, senderName: 'Sean Fitzgibbons', threadFirst: 'quote please -- Sean Fitzgibbons Managing Partner' })).map(x => [x.field, x.expected]), [['client', 'Liquid Labs']]);
// Oct 13 (Sean): the LLM's reply totals vs the PDF's
const GP = require('../../generate-proposal.js');
const tot = GP.proposalTotals({ tax_rate: 0.088875, tip_amount: 50, delivery_fee: 0 }, [{ qty: 1, price: 7617.33 }]);
eq('fees: tax 8.8875% / tip $50 flat / delivery $0', [tot.tax, tot.tip, tot.delivery, tot.service, tot.grandTotal, tot.taxLabel, tot.tipLabel], [676.99, 50, 0, 761.73, 9106.05, 'Estimated tax (8.8875%)', 'Tip (flat)']);
eq('fees: defaults unchanged', (t => [t.tax, t.service, t.tip, t.delivery, t.taxLabel])(GP.proposalTotals({}, [{ qty: 1, price: 100 }])), [10, 10, 5, 25, 'Estimated tax (10%)']);
const reply = "Product total: $7,617.33\nTax (8.8875%): $676.74\nDelivery: $0.00\nService (10%): $761.73\nTip: $50.00\nEstimated grand total: $9,105.80\n\nDelivery: 1460 Broadway, New York, NY 10036";
const ft = G.fixTotals(reply, tot);
eq('reply totals rewritten to the PDF (tax, grand total), others and the address line untouched', [ft.changed.map(c => c.line), ft.text.split('\n')[1], ft.text.split('\n')[5], ft.text.split('\n')[7]],
  [['Tax (8.8875%)', 'Estimated grand total'], 'Estimated tax (8.8875%): $676.99', 'Estimated grand total: $9,106.05', 'Delivery: 1460 Broadway, New York, NY 10036']);
eq('matching totals: nothing changed', G.fixTotals(ft.text, tot).changed, []);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
