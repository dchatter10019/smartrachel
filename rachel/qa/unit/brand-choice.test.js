// Nov 25, DC on Slack (Bushburg 10005 / ezCater - Google 94043): brand-choice list lines, "3 1L btls of" counts, and the
// proposal's Hard Seltzer / RTD section. (precheck.sh runs qa/unit/*.test.js.)
const B = require('../../brand-choice.js');
const C = require('../../original-compare.js');
const G = require('../../generate-proposal.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const msg = '• 3 1L btls of Bourbon (Woodford / Makers Mark) \n• 2 1L bottles of Vodka (Ketel One / Grey Goose)\n• 2 btls of St Germain\n• 2 1L btls of Tequila (Lalo, Don Fulano, G4)\n• 2 1L btls of Cointreau';
console.log('choice lines');
eq('bourbon choice', B.choicesIn('• 3 1L btls of Bourbon (Woodford / Makers Mark)').brands, ['Woodford', 'Makers Mark']);
eq('tequila choice', B.choicesIn('2 1L btls of Tequila (Lalo, Don Fulano, G4)').brands, ['Lalo', 'Don Fulano', 'G4']);
eq('a note is not a choice', B.choicesIn('Prosecco (assume a smaller pour, 4oz?)'), null);
eq('no parentheses', B.choicesIn('2 btls of St Germain'), null);
const np = [{ name: 'Woodford Reserve Bourbon 1L', qty: 3 }, { name: 'Makers Mark Bourbon 1L', qty: 3 }, { name: 'Ketel One Vodka 1L', qty: 2 }, { name: 'Grey Goose Vodka 1L', qty: 2 },
  { name: 'St Germain', qty: 2 }, { name: 'Lalo Tequila 1L', qty: 2 }, { name: 'Don Fulano Tequila 1L', qty: 2 }, { name: 'G4 Tequila 1L', qty: 2 }, { name: 'Cointreau 1L', qty: 2 }];
B.collapse(np, [msg]);
eq('one line per choice', np.map(x => x.qty + ' ' + x.name), ['3 Woodford Reserve Bourbon 1L', '2 Ketel One Vodka 1L', '2 St Germain', '2 Lalo Tequila 1L', '2 Cointreau 1L']);
eq('fallbacks kept', np[3].choices, ['Don Fulano Tequila 1L', 'G4 Tequila 1L']);
const raw = [{ name: 'btls of Bourbon Woodford / Makers Mark', qty: 1, volume_ml: 1000 }];
B.collapse(raw, [msg]);
eq('raw choice text', [raw[0].qty, raw[0].name, raw[0].volume_ml], [3, 'Woodford Bourbon 1L', undefined]);
console.log('counts');
const r = C.parseRequest('• 3 1L btls of Bourbon (Woodford / Makers Mark)')[0];
eq('3 1L btls = 3 counted', [r.qty, r.counted], [3, true]);
console.log('proposal sections');
const g = G.groupByCategory([{ name: 'Stella Artois Premium Lager 24 x 11 OZ Bottles', category: 'Beer' }, { name: 'White Claw Hard Seltzer Variety Pack 24 x 12 OZ Cans', category: 'Beer' }, { name: 'High Noon Sun Sips Vodka Hard Seltzer Variety Pack 12 x 12 OZ Cans', category: 'Liquor' }, { name: 'Grey Goose Vodka 1L', category: 'Liquor' }]);
eq('sections', Object.keys(g), ['Spirits', 'Beer', 'Hard Seltzer / RTD']);
eq('RTD lines', g['Hard Seltzer / RTD'].length, 2);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
