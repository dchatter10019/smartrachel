// Nov 25, DC on Slack (Compass Group, Jacksonville 32216): Slack-italic change bullets were re-added as products, "they already
// have White Claw + Yuengling, so remove these" removed every beer line, and "you read wrong from the pdf proposal" was not
// heard as a complaint. (precheck.sh runs qa/unit/*.test.js.)
const C = require('../../original-compare.js');
const OH = require('../../on-hand.js');
const F = require('../../feedback.js');
const ER = require('../../edit-reader.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

console.log('instruction bullets are not product lines');
eq('italic remove', C.notAProductLine('_Remove Josh Cellars Chardonnay from proposal_'), true);
eq('italic add', C.notAProductLine('_Add 25 bottles of “Banshee” Cabernet_'), true);
eq('prose paragraph', C.notAProductLine('_PROSECCO — They decided to pre-pour a welcome drink at the door. I will need 1000 pours of Prosecco_'), true);
eq('they already have', C.notAProductLine('_Beer / Seltzers —they confirmed they already have 7 cases of White Claw'), true);
eq('a product line stays', C.notAProductLine('50 x Josh Cellars Chardonnay 750mL'), false);
eq('a bold product line stays', C.notAProductLine('*Stella Artois 6x11oz Bottles*'), false);
const np = [{ name: 'Kim Crawford Marlborough Sauvignon Blanc 750mL', qty: 50 }, { name: 'Ruffino Prosecco 750mL', qty: 197 }, { name: 'Banshee Cabernet Sauvignon 750mL', qty: 25 }];
C.reconcileNamed(np, '50 x Kim Crawford Marlborough Sauvignon Blanc 750mL\n197 x Ruffino Prosecco 750mL\n25 x Banshee Cabernet Sauvignon 750mL\n• _Remove Josh Cellars Chardonnay from proposal_\n• _Add 25 bottles of “Banshee” Cabernet_');
eq('reconcile adds no bullet', np.length, 3);

console.log('stock the customer already has');
const msg = '• _Beer / Seltzers —they confirmed they already have 7 cases of White Claw + 15 cases of Yuengling, so remove these_';
eq('inline on-hand', OH.inlineOnHand(msg).map(o => o.name), ['White Claw', 'Yuengling']);
eq('Stella not removed', OH.removalAllowed(msg, 'Stella Artois 6 x 11 OZ Bottles').ok, false);
eq('Michelob not removed', OH.removalAllowed(msg, 'Michelob Ultra 24 x 12 OZ Cans').ok, false);
eq('a White Claw line is removed', OH.removalAllowed(msg, 'White Claw Variety 12 x 12 OZ Cans').ok, true);
eq('a named line is removed', OH.removalAllowed(msg + '\n• _Remove Josh Cellars Chardonnay_', 'Josh Cellars Chardonnay - 750 ML').ok, true);
eq('no on-hand statement = no limit', OH.removalAllowed('remove all the beer', 'Stella Artois 6 x 11 OZ Bottles').ok, true);
const basket = [{ name: 'Michelob Ultra 24 x 12 OZ Cans', qty: 11 }, { name: 'Stella Artois 6 x 11 OZ Bottles', qty: 42 }, { name: 'Ruffino Prosecco - 750 ML', qty: 50 }];
const v = ER.validate({ ops: [{ op: 'remove', line: 1 }, { op: 'remove', line: 2 }, { op: 'set_qty', line: 3, qty: 30 }] }, basket, msg + '\n• Prosecco 50 -> 30');
eq('edit reader keeps the beer', v.ops.map(o => o.op + ':' + o.index), ['set_qty:2']);

console.log('a complaint about the PDF');
eq('you read wrong', !!F.unhappyIn('you read wrong from the pdf proposal attached'), true);
eq('you got the quantities wrong', !!F.unhappyIn('you got the quantities wrong'), true);
eq('not a complaint', !!F.unhappyIn('send me the proposal please'), false);

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
