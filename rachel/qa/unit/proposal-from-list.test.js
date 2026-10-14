// Unit tests for the connector's rachel_proposal_from_list (Oct 14): original-compare.js namedFromListLine reads each
// typed list entry; store-agent core-first.js otherLabel keeps "The Beach by Whispering Angel" from standing in for
// Whispering Angel. (precheck.sh runs qa/unit/*.test.js.)
const { namedFromListLine } = require('../../original-compare.js');
const { otherLabel, extraWords } = require('../../../store-agent/core-first.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const nq = l => { const n = namedFromListLine(l); return n && [n.name, n.qty]; };
eq('"3 x Tito\'s 750ml"', nq("3 x Tito's Handmade Vodka 750ml"), ["Tito's Handmade Vodka 750ml", 3]);
eq('"4 Casamigos Blanco" counts 4', nq('4 Casamigos Blanco'), ['Casamigos Blanco', 4]);
eq('"Whispering Angel x 6"', nq('Whispering Angel x 6'), ['Whispering Angel', 6]);
eq('no count = 1', nq('Veuve Clicquot Yellow Label'), ['Veuve Clicquot Yellow Label', 1]);
eq('"2 cases of Stella Artois" = 2 cases (beer rule)', nq('2 cases of Stella Artois'), ['Stella Artois case', 2]);
eq('"a case of Whispering Angel" = 12 bottles', nq('a case of Whispering Angel'), ['Whispering Angel', 12]);
eq('"750ml Grey Goose" is a size, not 750 bottles', nq('750ml Grey Goose')[1], 1);
eq('"6 bottles of The Prisoner"', nq('6 bottles of The Prisoner'), ['The Prisoner', 6]);
eq('"The Beach by Whispering Angel" is another label', otherLabel('Whispering Angel', 'The Beach by Whispering Angel Rosé - 750 ML'), true);
eq('Château d\'Esclans Whispering Angel is the wine', otherLabel('Whispering Angel', "Château d'Esclans Whispering Angel Côtes de Provence Rosé - 750 ML"), false);
eq('a brand with "by" in its own name', otherLabel('Hemingway by Papa', 'Hemingway by Papa Rum'), false);
eq('Patrón Silver still before Roca Patrón', extraWords('Patron Silver', 'Patrón Silver Tequila') < extraWords('Patron Silver', 'Roca Patrón Silver Tequila'), true);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('proposal-from-list: all passed');
