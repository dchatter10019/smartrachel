// Unit tests for the Oct 11 catalog re-import (accented / hyphenated names): catalog-api.js hyphenJoins,
// store-agent core-first.js extraWords, product-match.js words (a trailing period is not part of a word).
// (precheck.sh runs qa/unit/*.test.js.)
const { hyphenJoins } = require('../../catalog-api.js');
const { extraWords } = require('../../../store-agent/core-first.js');
const PM = require('../../product-match.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
eq('"Coca Cola 2 L" -> Coca-Cola', hyphenJoins('Coca Cola 2 L'), ['Coca-Cola 2 L']);
eq('"St Germain" first', hyphenJoins('St Germain Elderflower Liqueur 750 ml')[0], 'St-Germain Elderflower Liqueur 750 ml');
eq('type words never joined', hyphenJoins('Red Wine'), []);
eq('one word: nothing', hyphenJoins("Tito's"), []);
eq('Patrón Silver Tequila is the core bottle', extraWords('Patron Silver 750ml', 'Patrón Silver Tequila - 750 ML'), 0);
eq('Roca Patrón Silver is another line', extraWords('Patron Silver 750ml', 'Roca Patrón Silver Tequila - 750 ML'), 1);
eq('"Beer Co." -> co is filler, not a brand word', PM.brandWords('Fort Point Beer Co. KSA Kolsch Non-Alcoholic 12 oz'), ['fort', 'point', 'ksa', 'kolsch', 'na']);
eq('Kölsch pick lacks nothing', PM.fit('Fort Point Beer Co. KSA Kolsch Non-Alcoholic 12 oz', { name: 'Fort Point KSA Kölsch Non-Alcoholic 6 x 12 OZ Cans', sizeStr: '6 x 12 OZ' }).missing, []);
eq('a decimal size keeps its point', PM.words('Stella 11.2 OZ'), ['stella', '11.2', 'oz']);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('catalog-reimport: all passed');
