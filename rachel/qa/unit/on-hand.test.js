// Unit tests for on-hand.js — stock the customer already has is left out of the order (DC, Oct 2).
// (precheck.sh runs qa/unit/*.test.js.)
const { parseOnHand, isOnHand } = require('../../on-hand.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
// DC's Goody email (Oct 1), verbatim structure.
const goody = 'Can you help me with this request\r\n\r\n\r\n**Spirits**\r\n\r\n• 2 × 1.75L vodka\r\n\r\n• 3 × 1.75L tequila (blanco)\r\n\r\n\r\n**Wine** we have the below inventory from last time if you can please\r\nadjust the proposal accordingly.\r\n\r\n\r\n\r\n   - 2 bottles La Crema pinot noir\r\n   - 1 bottle the prisoner\r\n   - 2 bottles conundrum white\r\n\r\n\r\n**Beer/seltzer:** we have the below inventory from last time. we should be\r\ngood on this unless you have recommend any additions to top up stock?\r\n\r\n\r\n\r\n   - 22 high noon cans\r\n   - 31 surfside\r\n\r\n\r\n**Mixers & N/A (if you carry them)**\r\n\r\n• 4 × 4-packs Bundaberg ginger beer (or 1 × 12-pack Fever-Tree)\r\n\r\n• 1 × 12-pack Athletic N/A beer';
const oh = parseOnHand(goody);
eq('Goody: wine + beer inventory, nothing else', oh.map(o => o.name), ['La Crema pinot noir', 'the prisoner', 'conundrum white', 'high noon cans', 'surfside']);
eq('Goody: quantities', oh.map(o => o.qty), [2, 1, 2, 22, 31]);
eq('La Crema product is on hand', !!isOnHand('La Crema Pinot Noir Willamette - 750 ML', oh), true);
eq('The Prisoner Cabernet is on hand', !!isOnHand('The Prisoner Cabernet Sauvignon - 750 ML', oh), true);
eq('Conundrum White is on hand', !!isOnHand('Conundrum White - 750 ML', oh), true);
eq('High Noon is on hand', !!isOnHand('High Noon Vodka Seltzer Variety 8 pack', oh), true);
eq('vodka is ordered', isOnHand('Ketel One - 1.75 L', oh), null);
eq('Athletic is ordered', isOnHand('Athletic N/A Upside Dawn Golden 12x12 OZ Can', oh), null);
eq('a plain order list has nothing on hand', parseOnHand('Please send:\n- 2 La Crema\n- 1 Prisoner'), []);
eq('"we already have" inline intro', parseOnHand('we already have these:\n- 6 Modelo\n\nPlease add 2 cases Corona').map(o => o.name), ['Modelo']);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
