// removed-lines.js (Fix B, Nov 20 nightly, pick-plus-question / F-0016): a line removed in code keeps its qty for 30 minutes,
// so a later pick naming it as the original replaces it at that qty; nothing recorded = no quantity (the caller asks).
const RL = require('../../removed-lines.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const t0 = Date.parse('2026-11-20T08:00:00Z');
{ const st = {};
  RL.record(st, [{ name: 'Bacardi Superior White Rum 750ML', qty: 5 }], t0);
  const r = RL.lookup(st, 'Bacardi Superior White Rum 750ML', t0 + 60000);
  ok('B1: removed 5x Bacardi -> the pick naming it gets qty 5', r && r.qty === 5);
  ok('B1: "the Bacardi" (short name) finds it too', (RL.lookup(st, 'Bacardi Superior White Rum', t0 + 60000) || {}).qty === 5);
  ok('B1: after 30 minutes it is forgotten', RL.lookup(st, 'Bacardi Superior White Rum 750ML', t0 + 31 * 60000) === null);
  ok('B1: another product is not it', RL.lookup(st, 'Patrón Silver Tequila - 750 ML', t0 + 60000) === null);
}
{ const st = {};
  ok('B2: nothing recorded -> no quantity (the caller asks the customer, never 1)', RL.lookup(st, 'Bacardi Superior White Rum 750ML', t0) === null);
}
{ const st = {};
  RL.record(st, [{ kind: 'removed', name: 'Cloudy Bay Sauvignon Blanc - 750 ML', from: 12 }], t0);
  ok('quote-edits change rows (from = qty) are recorded', (RL.lookup(st, 'Cloudy Bay Sauvignon Blanc', t0) || {}).qty === 12);
  RL.record(st, [{ name: 'Cloudy Bay Sauvignon Blanc - 750 ML', qty: 3 }], t0 + 1000);
  ok('the same line removed again keeps the newest qty, once', st.recentRemoved.length === 1 && RL.lookup(st, 'Cloudy Bay', t0 + 2000).qty === 3);
}
ok('replacement_quantity: 5 and "5" are used', RL.validQty(5) === 5 && RL.validQty('5') === 5);
ok('replacement_quantity: 0, -1, 2.5, "five", "5 bottles", null are ignored', [0, -1, 2.5, 'five', '5 bottles', null, '', true].every(x => RL.validQty(x) === 0));
ok('replacement_quantity 5 counts when the customer said it: "5", "make it 5 bottles", "5x"', ['5', 'make it 5 bottles', '5x please', 'I want 5.'].every(m => RL.qtyInMessage(5, m)));
ok('replacement_quantity 5 ignored when not in the message: "15", "2.5", "$5.99", "five", "yes please"', ['15', 'make it 15', '2.5', '$5.99', 'five', 'yes please', ''].every(m => !RL.qtyInMessage(5, m)));
ok('replacement_quantity 12 counts in "a dozen? no, 12"', RL.qtyInMessage(12, 'a dozen? no, 12') && !RL.qtyInMessage(12, '120'));
if (failed) { console.log(failed + ' failed'); process.exit(1); }
