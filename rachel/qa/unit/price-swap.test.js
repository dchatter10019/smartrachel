// A per-bottle price limit against a basket = swaps, never options (DC, Nov 14). Nov 13 Eterra Kitchen quote basket.
const PS = require('../../price-swap.js');
const BP = require('../../bottle-price.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const basket = [
  { label: 'Prosecco', name: 'Ruffino Prosecco - 750 ML', qty: 24, price: 14.96, size: '750ML', category: 'wine', product_id: 'a' },
  { label: 'Pinot Grigio', name: 'Mezzacorona Pinot Grigio - 750 ML', qty: 10, price: 13.19, size: '750ML', category: 'wine', product_id: 'b' },
  { label: 'Sauvignon Blanc', name: 'Cloudy Bay Sauvignon Blanc - 750 ML', qty: 4, price: 37.39, size: '750ML', category: 'wine', product_id: 'c' },
  { label: 'Pinot Noir', name: 'Joseph Phelps Freestone Vineyards Sonoma Coast Pinot Noir - 750 ML', qty: 15, price: 71.49, size: '750ML', category: 'wine', product_id: 'd' },
  { label: 'IPA', name: 'Goose Island IPA 12 x 12 OZ Bottles', qty: 48, price: 31.99, size: '12 x 12 OZ', category: 'beer', product_id: 'e' },
];
const bp = BP.read('Price of wine cannot exceed $15');
ok('limit read: wine up to $15', bp && bp.category === 'wine' && bp.max === 15);
const over = PS.overLimit(basket, bp);
ok('over the limit: Cloudy Bay + Joseph Phelps only (never the beer)', JSON.stringify(over) === '[2,3]');
ok('search words = what was asked', PS.queryFor(basket[3]) === 'Pinot Noir' && PS.queryFor(basket[2]) === 'Sauvignon Blanc');
ok('no label: the grape', PS.queryFor({ name: 'Kim Crawford Marlborough Sauvignon Blanc 750 mL' }) === 'sauvignon blanc');
const rows = [
  { name: 'Underwood Pinot Noir - 750 ML', price: 14.84, size: '750 ML', product_id: 'u' },
  { name: 'Root: 1 Pinot Noir - 750 ML', price: 13.19, size: '750 ML', product_id: 'r' },
  { name: 'Barefoot Pinot Noir - 1.5 L', price: 12.99, size: '1.5 L', product_id: 'x' },
  { name: 'Some Pinot Noir Rose - 750 ML', price: 14.99, size: '750 ML', product_id: 'y' },
  { name: 'Layer Cake Pinot Noir - 750 ML', price: 16.49, size: '750 ML', product_id: 'l' },
];
const p = PS.pick(rows, basket[3], bp);
ok('pick: dearest same-type, same-size bottle within $15 (Underwood $14.84)', p && p.product_id === 'u');
const around = BP.read('the average price of the wine bottles is $15');
ok('"average $15" keeps a floor', around.max === 15 && around.min > 0);
ok('around: nothing under the floor', PS.pick([{ name: 'Cheap Pinot Noir 750 ML', price: 5.99, size: '750 ML' }], basket[3], around) === null);
const nl = PS.swapLine(basket[3], p);
ok('swap keeps qty + label', nl.qty === 15 && nl.label === 'Pinot Noir' && nl.price === 14.84 && nl.name === p.name);
const d = PS.describe([{ from: basket[3], to: nl, qty: 15 }], [basket[2]], bp);
ok('describe says swapped and kept', /Swapped:\n• Joseph Phelps .*\(\$71\.49\) → 15x Underwood Pinot Noir/.test(d) && /Kept:\n• Cloudy Bay/.test(d));
ok('only the price ask', PS.onlyPriceAsk('Price of wine cannot exceed $15', bp));
ok('price ask + no options + proposal = still only the price ask', PS.onlyPriceAsk('Do not show any options ever in a proposal. Just show me a proposal with items priced less than $15 a bottle for wines', BP.read('Just show me a proposal with items priced less than $15 a bottle for wines')));
ok('price ask + add beer = more in the message', !PS.onlyPriceAsk('Wine should not exceed $15. Also add 2 cases of Stella', bp));
ok('"find alternative wines around $20" = options, not a swap', PS.asksForOptions('find alternative wines around $20 a bottle, same quantities'));
ok('"what do you have under $15?" = options', PS.asksForOptions('what pinot noir do you have under $15?'));
ok('"do not show any options" + limit = a swap', !PS.asksForOptions('Do not show any options ever in a proposal. Just show me a proposal with items priced less than $15 a bottle for wines'));
ok('"price of wine cannot exceed $15" = a swap', !PS.asksForOptions('Price of wine cannot exceed $15'));
ok('"The bottles should not exceed $15 for wine" = a swap', !PS.asksForOptions('The bottles should not exceed $15 for wine'));
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
