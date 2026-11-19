// Nov 19, DC on Slack (Compass Group, Jacksonville 32216): a Slack brief with bold labels ("• *Customer:* Compass Group",
// "• *Headcount:* 1000 ppl.") and nested ◦ / ▪︎ bullets. [list-reconcile] added the 7 field lines as products ("Customer:*
// Compass Group isn't available at this store"), and a placeholder stock count read before the store was flagged swapped
// the named Josh Chardonnay / Kim Crawford away. (precheck.sh runs qa/unit/*.test.js.)
const os = require('os'), fs = require('fs'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-'));
process.env.RACHEL_DATA_DIR = dir;
const C = require('../../original-compare.js');
const S = require('../../stock.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const msg = '• *Customer:* Compass Group \n• *Event Date:* December 17th\n• *Headcount:* 1000 ppl.\n• *Length of Event:* 2 hours\n• *Drinks Per Person:*  2 drinks per person\n• *Budget:* $7-9 per person\n• *Menu:*\n    ◦ Wine:\n        ▪︎ Josh Chardonnay\n        ▪︎ Josh Cabernet\n        ▪︎ Kim Crawford Sauvignon Blanc\n        ▪︎ Ruffino Prosecco\n    ◦ Beer:\n        ▪︎ Michelob Ultra\n        ▪︎ Stella Artois\n        ▪︎ Bold City Brown Ale\n        ▪︎ Veterans United Fish Camp Pilsner';
const products = ['Josh Chardonnay', 'Josh Cabernet', 'Kim Crawford Sauvignon Blanc', 'Ruffino Prosecco', 'Michelob Ultra', 'Stella Artois', 'Bold City Brown Ale', 'Veterans United Fish Camp Pilsner'];
eq('field lines and headings are not request lines; Slack ◦ / ▪︎ bullets are', C.parseRequest(msg).map(r => r.text), products);
const np = products.map(name => ({ name }));
C.reconcileNamed(np, msg);
eq('nothing re-added to the LLM list', np.length, 8);
eq('drink label keeps its value; known field skipped; unknown label kept',
  C.parseRequest("- Wine: Josh Chardonnay\n- Client: Acme\n- **Guests:** 40\n- Tito's: 3 bottles\n- Beer:").map(r => r.text), ['Josh Chardonnay', "Tito's: 3 bottles"]);
fs.writeFileSync(path.join(dir, 'stock-placeholder-stores.json'), JSON.stringify({ storeA: 10 }));
eq('a placeholder count is unknown even on a row read before the store was flagged', S.inv({ inventory: 10, establishmentId: 'storeA' }), null);
eq('0 at a placeholder store is still out of stock', S.inv({ inventory: 0, establishmentId: 'storeA' }), 0);
eq('another store keeps its count', S.inv({ inventory: 10, establishmentId: 'storeB' }), 10);
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
