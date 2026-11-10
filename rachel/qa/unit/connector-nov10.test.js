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

// The basket line a pick replaces, from Rachel's own question (swap-target.js).
const { swapTarget } = require('../../swap-target.js');
const wines = [{ name: 'The Prisoner Wine Company Unshackled Red Blend - 750 ML', qty: 2 }, { name: 'Bread & Butter Pinot Grigio - 750 ML', qty: 1 }, { name: 'Louis Jadot Pouilly-Fuissé - 750 ML', qty: 1 }];
const st = (q, pick) => { const t = swapTarget(q, wines, pick); return t && [t.index, t.oneOf]; };
eq('"swap in for The Prisoner?"', st('Yes! Three options:\n\n1. Robert Mondavi ...\n\nWhich one would you like to swap in for The Prisoner?', 'Robert Mondavi Winery Napa Valley Cabernet Sauvignon - 750 ML'), [0, false]);
eq('"Shall I swap that in for the Bread & Butter Pinot Grigio?"', st('Found it! Kendall-Jackson ... — $16.38. Shall I swap that in for the Bread & Butter Pinot Grigio?', 'Kendall-Jackson'), [1, false]);
eq('"(replacing one of the Prisoner bottles)?" = one of', st('Which one would you like as your second red (replacing one of the Prisoner bottles)?', 'La Crema Monterey Pinot Noir - 750 ML'), [0, true]);
eq('a plain "which one would you like to add?" is no swap', st('I found a few options:\n1. A\n2. B\n\nWhich one would you like to add?', 'A'), null);
eq('the swap line is earlier, the closing question has none', st('Swap for the Prisoner done.\n\nWould you like to place the order?', 'X'), null);

// Wine heading colours for appellation names (Pouilly-Fuissé was "1 other").
const { wineHeading } = require('../../package-facts.js');
eq('Pouilly-Fuissé is a white, Saint-Julien a red', wineHeading([{ category: 'wine', qty: 1, name: 'The Prisoner Wine Company Unshackled Red Blend - 750 ML' }, { category: 'wine', qty: 1, name: 'Château Gloria Saint-Julien - 750 ML' }, { category: 'Wine', qty: 1, name: 'Louis Jadot Pouilly-Fuissé - 750 ML' }]), 'WINE — 3 bottles (2 red, 1 white)');

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('connector-nov10: all passed');
