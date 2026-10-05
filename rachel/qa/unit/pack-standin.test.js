// Unit tests for pack-standin.js — a replacement in another pack size keeps the units asked for.
// (precheck.sh runs qa/unit/*.test.js.)
const { parsePack, packStandInQty, requestedPackLine } = require('../../pack-standin.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const ask = 'Stella Artois Premium Lager Beer 24 x 11 oz Bottles';
eq('parse "24 x 11 oz"', parsePack(ask), { count: 24, size: 11, unit: 'oz' });
eq('parse "12pk 11.2 OZ"', parsePack('Stella Artois 12pk 11.2 OZ Btl 5.0% ABV'), { count: 12, size: 11.2, unit: 'oz' });
eq('parse "6PKC 12 OZ"', parsePack('Modelo Especial 6PKC 12 OZ'), { count: 6, size: 12, unit: 'oz' });
eq('a bottle is not a pack', parsePack('Tito\'s Handmade Vodka 750 ML'), null);
eq('Oct 5: 2 x 24-pack -> 4 x 12pk 11.2 oz', packStandInQty(ask, 2, 'Stella Artois 12pk 11.2 OZ Btl 5.0% ABV 11.2OZ'), { qty: 4, from: 24, to: 12 });
eq('2 x 24-pack -> 4 x 12 x 12 oz cans (near size)', packStandInQty(ask, 2, 'Stella Artois Premium Lager Beer 12 x 12 OZ Cans'), { qty: 4, from: 24, to: 12 });
eq('1 x 24-pack -> 4 six-packs', packStandInQty(ask, 1, 'Stella Artois 6 x 11 oz Bottles'), { qty: 4, from: 24, to: 6 });
eq('3 x 12-pack -> 2 x 24-pack (covers 36)', packStandInQty('Stella 12 x 12 oz Cans', 3, 'Stella 24 x 12 oz Cans'), { qty: 2, from: 12, to: 24 });
eq('18-pack for a 24-pack: rounds up', packStandInQty('Bud Light 24 x 12 oz', 1, 'Bud Light 18 x 12 oz'), { qty: 2, from: 24, to: 18 });
eq('"24 pack" with no size takes any container', packStandInQty('2 Stella 24 pack', 2, 'Stella 12 x 12 oz Cans'), { qty: 4, from: 24, to: 12 });
eq('same pack count: not this rule', packStandInQty(ask, 2, 'Stella Artois 24 x 12 oz Cans'), null);
eq('12 oz vs 24 oz tallboys: too far apart', packStandInQty('Modelo 12 x 12 oz', 2, 'Modelo 6 x 24 oz'), null);
eq('a single can is not a pack', packStandInQty(ask, 2, 'Stella Artois 1 x 25 oz Can'), null);
eq('bottle to bottle: not this rule', packStandInQty('Patron Silver 750 ML', 2, 'Patron Silver 375 ML'), null);
eq('finds the customer\'s line', requestedPackLine(['2 x ' + ask], 'Stella Artois 12pk 11.2 OZ Btl 5.0% ABV'), { name: ask, qty: 2 });
eq('another brand\'s line is not it', requestedPackLine(['2 x Bud Light 24 x 12 oz'], 'Stella Artois 12pk 11.2 OZ Btl'), null);
eq('a line with no pack is not it', requestedPackLine(['2 x Stella Artois'], 'Stella Artois 12pk 11.2 OZ Btl'), null);
eq('the same pack size is not a stand-in', requestedPackLine(['2 x Stella 12 pack'], 'Stella Artois 12pk 11.2 OZ Btl'), null);
eq('newest line first', requestedPackLine(['3 x Stella 24 pack', '1 x Stella 6 pack'], 'Stella Artois 12pk 11.2 OZ'), { name: 'Stella 24 pack', qty: 3 });
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
