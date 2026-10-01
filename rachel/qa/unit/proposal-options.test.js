// Unit tests for proposal-options.js — alternatives listed in the proposal PDF (Oct 1, Sean / Foodie For All).
// (precheck.sh runs qa/unit/*.test.js.)
const PO = require('../../proposal-options.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const lineFor = require('../../basket-line.js');

const sean1 = 'Can you please send a pdf proposal and include the various prosecco, sauv\nblanc, and rose options separately?';
eq('Sean: the proposal request asks for the options', PO.wantsOptions(sean1), true);
eq('a plain proposal request does not', PO.wantsOptions('send me the proposal'), false);
eq('"without the options"', PO.wantsOptions('send the proposal without the options'), false);
eq('dropsOptions', PO.dropsOptions('please remove the options from the pdf'), true);
eq('"two options" -> 2', PO.countAsked('Can you give two options for the prosecco, sauv blanc, and rose?'), 2);
eq('"3 alternatives" -> 3', PO.countAsked('show me 3 alternatives'), 3);
eq('no count', PO.countAsked('what else do you have?'), null);

// Real search result + reply (Oct 1, session email-1a0f844924f68c6d-sean).
const P = (name, price, size, id) => ({ name, price, size, product_id: id });
const queries = [{ label: 'Prosecco', term: 'Prosecco' }, { label: 'Sauvignon Blanc', term: 'Sauvignon Blanc' }, { label: 'Provence Rose', term: 'Provence Rose' }];
const result = { success: true, results: [
  { found: true, products: [P('La Marca Prosecco - 1.5 L', 35.19, '1.5L', 'lm'), P('Mionetto Prosecco Brut - 1.5 L', 32.99, '1.5L', 'mi'), P('Santa Margherita Prosecco - 750 ML', 25.78, '750ML', 'sm')] },
  { found: true, products: [P('Cloudy Bay Sauvignon Blanc White Wine - 750 ML', 37.39, '750ML', 'cb'), P("Stags' Leap Sauvignon Blanc - 750 ML", 35.19, '750ML', 'sl'), P('Groth Sauvignon Blanc - 750 ML', 30.79, '750ML', 'gr')] },
  { found: true, products: [P("Whispering Angel Chateau D'esclans Rose - 1.5 L", 60.48, '1.5L', 'wa'), P('Chateau Minuty Rose et Or - 750 ML', 43.99, '750ML', 'cm'), P('Rumor Organic Provence Rose - 750 ML', 28.04, '750ML', 'ru')] },
] };
const groups = PO.groupsFromResult(queries, result);
eq('groups by query label', groups.map(g => g.label + ':' + g.products.length), ['Prosecco:3', 'Sauvignon Blanc:3', 'Provence Rose:3']);
const reply = "Here are two options for each:\n\nPROSECCO\n1. Kim Crawford Prosecco - 750 ML — $17.59 (currently in your order)\n2. Santa Margherita Prosecco - 750 ML — $25.78\n3. Mionetto Prosecco Brut - 1.5 L — $32.99\n\nSAUVIGNON BLANC\n4. Cloudy Bay Sauvignon Blanc - 750 ML — $37.39 (currently in your order)\n5. Stags' Leap Sauvignon Blanc - 750 ML — $35.19\n6. Groth Sauvignon Blanc - 750 ML — $30.79\n\nPROVENCE ROSE\n7. Rumor Organic Provence Rose - 750 ML — $28.04 (currently in your order)\n8. Chateau Minuty Rose et Or - 750 ML — $43.99\n9. Whispering Angel Chateau D'Esclans Rose - 1.5 L — $60.48";
const basket = [
  { name: 'Rumor Organic Provence Rose - 750 ML', qty: 3, price: 28.04, size: '750ML', product_id: 'ru' },
  { name: 'Kim Crawford Prosecco - 750 ML', qty: 3, price: 17.59, size: '750ml', product_id: 'kc' },
  { name: 'Cloudy Bay Sauvignon Blanc White Wine - 750 ML', qty: 3, price: 37.39, size: '750ML', product_id: 'cb' },
  { name: 'Grey Goose - 750 ML', qty: 1, price: 41.24, product_id: 'gg' },
];
const opts = PO.buildOptions({ groups, want: 2, reply }, basket, lineFor);
eq('each group sits on its basket line', opts.map(o => o.label + ' -> ' + (o.selected && o.selected.name)), ['Prosecco -> Kim Crawford Prosecco - 750 ML', 'Sauvignon Blanc -> Cloudy Bay Sauvignon Blanc White Wine - 750 ML', 'Provence Rose -> Rumor Organic Provence Rose - 750 ML']);
eq('only what the reply listed, the basket product left out, 2 each', opts.map(o => o.alternatives.map(a => a.name)), [
  ['Mionetto Prosecco Brut - 1.5 L', 'Santa Margherita Prosecco - 750 ML'],
  ["Stags' Leap Sauvignon Blanc - 750 ML", 'Groth Sauvignon Blanc - 750 ML'],
  ["Whispering Angel Chateau D'esclans Rose - 1.5 L", 'Chateau Minuty Rose et Or - 750 ML']]);
eq('selected keeps its qty', opts[0].selected.qty, 3);
eq('reply line', PO.describe(opts), 'Options listed in the PDF: Prosecco (2), Sauvignon Blanc (2), Provence Rose (2).');
eq('a group with no basket line is still listed', PO.buildOptions({ groups: [{ label: 'Mezcal', products: [P('Del Maguey Vida - 750 ML', 39.99, '750ML', 'dm')] }] }, basket, lineFor).map(o => [o.label, o.selected]), [['Mezcal', null]]);
eq('nothing shown -> no options', PO.buildOptions(null, basket, lineFor), []);

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
