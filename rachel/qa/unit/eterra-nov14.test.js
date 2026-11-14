// Nov 14 (DC forwarding Eterra Kitchen's "New Beverage Order – November 17"): "IPA – 48 bottles/cans" became 48 x Goose Island
// IPA 12-packs; "we need 48 bottles not 48 cases. Make the update and send over a new updated proposal" was ignored (same PDF);
// and two Pinot Noir lines (10 + 5) swapped to one product ended at 5. Quote-edit part here. (precheck runs qa/unit.)
const Q = require('../../quote-edits.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const items = [
  { name: 'Ruffino Prosecco - 750 ML', qty: 24, price: 14.96, category: 'wine' },
  { name: 'Goose Island IPA 12 x 12 OZ Bottles', qty: 48, price: 31.99, category: 'beer' },
  { name: 'Underwood Pinot Noir - 750 ML', qty: 15, price: 14.84, category: 'wine' },
];
const e = Q.parseEdits('Everything looks good except for the beer.. we. need 48 bottles not 48\ncases.  Make the update and send over a new updated proposal,');
ok('read as an edit (48 bottles, was 48, the beer) + a quote ask', e.count === 1 && e.units[0].count === 48 && e.units[0].was === 48 && /beer/.test(e.units[0].about) && e.wantsQuote);
const r = Q.applyEdits(items, e);
ok('48 bottles of a 12-pack line = 4 packs, nothing else touched', r.items[1].qty === 4 && r.items[0].qty === 24 && r.items[2].qty === 15);
ok('"48 cans, not packs" (no subject) -> the only pack line', Q.applyEdits(items, Q.parseEdits('it should be 48 cans, not packs')).items[1].qty === 4);
ok('"24 bottles of the IPA, not 4 cases"', Q.applyEdits(items, Q.parseEdits('24 bottles of the IPA, not 4 cases please')).items[1].qty === 2);
ok('no pack line -> not found, nothing changed', Q.applyEdits(items.filter(i => !/IPA/.test(i.name)), e).notFound.length === 1);
ok('"not 48 bottles" alone is not an edit', Q.parseEdits('we do not need 48 bottles of prosecco').units.length === 0);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
