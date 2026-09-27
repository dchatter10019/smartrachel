// Unit tests for store-agent/order-lines.js — an order never carries the same product twice.
// Run: node qa/unit/order-lines.test.js (precheck.sh runs every qa/unit/*.test.js).
const { mergeOrderLines } = require('../../../store-agent/order-lines.js');
let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
};
const lines = r => r.items.map(i => (i.qty || i.quantity) + 'x ' + i.name);

console.log('same product_id twice');
{
  const r = mergeOrderLines([
    { name: "Tito's Handmade Vodka - 750 ML", qty: 3, price: 21.99, product_id: 'A1', upc: 'U1', establishmentId: 'E' },
    { name: 'Whispering Angel Rose - 750 ML', qty: 2, price: 24.19, product_id: 'B1', upc: 'U2', establishmentId: 'E' },
    { name: "Tito's Handmade Vodka - 750 ML", qty: 2, price: 21.99, product_id: 'A1', upc: 'U1', establishmentId: 'E' },
  ]);
  eq('one Tito\'s line, quantities summed, order kept', lines(r), ["5x Tito's Handmade Vodka - 750 ML", '2x Whispering Angel Rose - 750 ML']);
  eq('merge reported', r.merged.map(m => m.reason), ['same product_id']);
}

console.log('two catalog listings of the same bottle');
{
  const r = mergeOrderLines([
    { name: 'Grey Goose Vodka 750 ML (80 Proof)', qty: 2, price: 35.20, product_id: 'G1', upc: 'X1' },
    { name: 'Grey Goose - 750 ML', qty: 1, price: 41.24, product_id: 'G2', upc: 'X2' },
  ]);
  eq('merged onto the first listing', lines(r), ['3x Grey Goose Vodka 750 ML (80 Proof)']);
  eq('price difference noted', /different catalog listings.*\$35\.20 vs \$41\.24/.test(r.merged[0].reason), true);
}

console.log('never merged');
{
  const r = mergeOrderLines([
    { name: 'Belvedere Vodka - 750 ML', qty: 1, price: 36, product_id: 'V1' },
    { name: 'Belvedere Vodka - 1 L', qty: 1, price: 46.19, product_id: 'V2' },
    { name: 'Stella Artois 24x12 Oz Bottle', qty: 2, price: 62.99, product_id: 'S1' },
    { name: 'Stella Artois 12x12 Oz Bottle', qty: 1, price: 33, product_id: 'S2' },
    { name: 'Kim Crawford Sauvignon Blanc - 750 ML', qty: 1, price: 16.42, product_id: 'K1' },
    { name: 'Kim Crawford Illuminate Sauv Blanc - 750 ML', qty: 1, price: 18.69, product_id: 'K2' },
  ]);
  eq('different sizes / packs / products stay separate', r.items.length, 6);
  eq('nothing merged', r.merged.length, 0);
}

console.log(failed ? '\norder-lines: ' + failed + ' FAILED' : '\norder-lines: all passed');
process.exit(failed ? 1 : 0);
