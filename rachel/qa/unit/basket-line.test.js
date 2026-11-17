// Unit tests for basket-line.js — which basket line an item name refers to.
// Nov 17 (DC on Slack, Gen2Fund): "Budweiser 30 x 12 OZ Cans" matched the Michelob Ultra 30 x 12 OZ Cans line (listed first).
const basketLineFor = require('../../basket-line.js');
let failed = 0;
function eq(label, got, want) {
  const ok = got === want; if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '  got ' + got + ', want ' + want));
}
const items = [{ name: 'Michelob Ultra 30 x 12 OZ Cans' }, { name: 'Budweiser 30 x 12 OZ Cans' }, { name: 'Bud Light 36 x 12 OZ Cans' },
  { name: 'La Crema Pinot Noir - 750 ML' }, { name: 'Chandon Reserve Blanc de Blancs' }];
eq('Budweiser 30-pack is the Budweiser line, not the Michelob listed first', basketLineFor(items, 'Budweiser 30 x 12 OZ Cans'), 1);
eq('a pasted basket line', basketLineFor(items, '1x Budweiser 30 x 12 OZ Cans — $29.99 ea = $29.99'), 1);
eq('Michelob still found', basketLineFor(items, 'Michelob Ultra 30 x 12 OZ Cans'), 0);
eq('pack words alone never match', basketLineFor(items, '30 x 12 OZ Cans'), -1);
eq('a brand no line has', basketLineFor(items, 'Coors Light 30 x 12 OZ Cans'), -1);
eq('"La" is not a match for Blanc', basketLineFor([{ name: 'Chandon Reserve Blanc de Blancs' }], 'La Crema Pinot Noir'), -1);
eq('La Crema found', basketLineFor(items, 'La Crema Pinot Noir'), 3);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
