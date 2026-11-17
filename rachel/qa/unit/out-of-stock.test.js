// Unit tests for catalog-api.js inStockOnly — a 0-stock row is out of stock at every store and never shown (DC, Nov 17).
const { inStockOnly } = require('../../catalog-api.js');
let failed = 0;
function eq(label, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '  got ' + JSON.stringify(got))); }
const rows = [{ name: 'Oyster Bay Sauvignon Blanc - 750 ML', inventory: 0 }, { name: 'Carlsberg 6 x 11', inventory: null },
  { name: 'Josh Cellars SB', inventory: 24 }, { name: 'No stock field' }, { name: 'String zero', inventory: '0' }, { name: 'Empty', inventory: '' }];
eq('0 and "0" dropped; null / missing / empty kept', inStockOnly(rows, { q: 't', zip: '02110' }).map(r => r.name), ['Carlsberg 6 x 11', 'Josh Cellars SB', 'No stock field', 'Empty']);
eq('no rows', inStockOnly([], {}), []);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
