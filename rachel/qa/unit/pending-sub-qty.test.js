// pending-sub-qty.js (Nov 20): a swap held while Rachel asks "how many?" — next message only, a bare number, the same basket.
const PSQ = require('../../pending-sub-qty.js');
const basketLineFor = require('../../basket-line.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const t0 = Date.parse('2026-11-20T10:00:00Z');
const items = [{ name: 'Patrón Silver Tequila - 750 ML', qty: 4 }];
const p = PSQ.make('Bacardi Superior White Rum 750ML', 'Buffalo Trace Kentucky Straight Bourbon 750ml', 40.69, '750 ML', items, t0);
ok('bare "5" is a quantity', PSQ.bareQty('5') === 5 && PSQ.bareQty(' 12 ') === 12);
ok('"actually what tequilas do you have?", "5 bottles", "0", "2.5" are not', ['actually what tequilas do you have?', '5 bottles', '0', '2.5', ''].every(m => PSQ.bareQty(m) === 0));
ok('same basket, original still gone: ok', PSQ.check(p, items, basketLineFor, t0 + 60000).ok);
ok('basket changed since the question: refused', !PSQ.check(p, [{ name: 'Patrón Silver Tequila - 750 ML', qty: 6 }], basketLineFor, t0 + 60000).ok);
ok('the original came back: refused', !PSQ.check(p, items.concat({ name: 'Bacardi Superior White Rum 750ML', qty: 1 }), basketLineFor, t0).ok);
ok('over 30 minutes old: refused', !PSQ.check(p, items, basketLineFor, t0 + 31 * 60000).ok);
const rows = [{ name: 'Buffalo Trace Kentucky Straight Bourbon - 1.75 L' }, { name: 'Buffalo Trace Kentucky Straight Bourbon - 750 ML', price: 40.69 }];
ok('replacement found in fresh catalog rows (size ignored)', !!PSQ.findProduct(rows, 'Buffalo Trace Kentucky Straight Bourbon 750ml'));
ok('replacement missing from the catalog rows: null', PSQ.findProduct([{ name: 'Woodford Reserve Bourbon - 750 ML' }], 'Buffalo Trace Kentucky Straight Bourbon 750ml') === null);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
