// Unit tests for the Nov 10 connector conversation (DC on Claude Code, Foodie For All, 132 W 32nd St 10001).
// (precheck.sh runs qa/unit/*.test.js.)
const basketLineFor = require('../../basket-line.js');
const { rankByMatch } = require('../../search-match.js');
const { groupByCategory } = require('../../generate-proposal.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

// A line copied from Rachel's own basket finds its basket line ("1x ... — $15.39" -> the swap was left to the LLM).
const basket = [{ name: 'Stella Artois 24 x 12 OZ Bottles' }, { name: 'Bread & Butter Pinot Grigio - 750 ML' }, { name: 'Alamos Selección Malbec - 750 ML' }];
eq('pasted "1x Name — $price" line', basketLineFor(basket, '1x Bread & Butter Pinot Grigio - 750 ML — $15.39'), 1);
eq('pasted "... ea = $x" line', basketLineFor(basket, '1x Bread & Butter Pinot Grigio - 750 ML — $15.39 ea = $15.39'), 1);
eq('pasted Malbec line', basketLineFor(basket, '1x Alamos Selección Malbec - 750 ML — $21.99'), 2);
eq('a name not in the basket still misses', basketLineFor(basket, 'La Crema Pinot Noir'), -1);
eq('a pack count is not stripped from inside a name', basketLineFor(basket, 'Stella Artois 24 x 12 OZ'), 0);

// "Bacardi Silver" = the store's "Bacardi Superior White Rum".
const r = rankByMatch('Bacardi Silver Rum 750 ML', [{ name: 'Bacardí Gold Rum - 750 ML' }, { name: 'Bacardi Superior White Rum 750ML' }]);
eq('Bacardi Silver -> Superior White', [r.found, r.products.map(p => p.name)], [true, ['Bacardi Superior White Rum 750ML']]);
const r2 = rankByMatch('Patron Silver', [{ name: 'Patrón Silver Tequila - 750 ML' }, { name: 'Patrón Reposado Tequila - 750 ML' }]);
eq('Patron Silver still prefers the Silver row', r2.products[0].name, 'Patrón Silver Tequila - 750 ML');

// The catalog's "Liquor" category is the Spirits section (Brugal 1888 has no spirit word in its name).
const g = groupByCategory([{ name: 'Brugal 1888 - 750ML', category: 'Liquor', price: 62.69 }, { name: 'Kendall-Jackson Chardonnay', category: 'Wine', price: 16.38 }, { name: 'Mystery Item', category: 'Gadgets', price: 1 }]);
eq('Brugal under Spirits', (g.Spirits || []).map(i => i.name), ['Brugal 1888 - 750ML']);
eq('an unknown category is still Other', (g.Other || []).map(i => i.name), ['Mystery Item']);

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('connector-nov10: all passed');
