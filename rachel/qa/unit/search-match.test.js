// Unit tests for search-match.js — real catalog rows returned for queries the store doesn't carry (DC, Oct 6, claude.ai).
// (precheck.sh runs qa/unit/*.test.js.)
const { rankByMatch } = require('../../search-match.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const P = (...n) => n.map(name => ({ name }));
const names = r => r.products.map(p => p.name);

let r = rankByMatch('Green Chartreuse', P('Johnnie Walker Green 15yr - 750 ML', 'Green Spot Irish Whiskey - 750 ML', 'William Fevre Chablis Champs Royaux - 750 ML'));
eq('Green Chartreuse: no result carries it -> not found', [r.found, names(r)], [false, []]);
r = rankByMatch('Yellow Chartreuse', P('Veuve Clicquot Brut Yellow Label 6 Liter', 'Pinhook Single Barrel Bourbon Yellow 750 ML'));
eq('Yellow Chartreuse -> not found', r.found, false);
r = rankByMatch('creme de cassis', P('Hall Napa Valley, Cabernet Sauvignon - 750 ML', 'Giffard Creme de Pamplemousse Rose - 750 ML'));
eq('creme de cassis -> not found', r.found, false);
r = rankByMatch('Rioja', P('Bodegas Caro Malbec Cabernet Sauvignon Blend 750 ML', 'Bodegas Muga Reserva Rioja 750 ML', 'Campo Viejo Rioja Tempranillo - 750 ML'));
eq('Rioja: the Argentine blend is dropped, the Riojas kept in order', names(r), ['Bodegas Muga Reserva Rioja 750 ML', 'Campo Viejo Rioja Tempranillo - 750 ML']);
r = rankByMatch('Topo Chico mineral water', P('Topo Chico Hard Seltzer Variety Pack 12 x 12 OZ Cans', 'Topo Chico Mineral Water 12 x 12 OZ Glass'));
eq('more of the query\'s words rank first', names(r)[0], 'Topo Chico Mineral Water 12 x 12 OZ Glass');
r = rankByMatch("Titos", P("Tito's Handmade Vodka - 1.75 L"));
eq('"Titos" = "Tito\'s"', r.found, true);
r = rankByMatch('Budlight', P('Bud Light 24 x 12 OZ Cans'));
eq('"Budlight" = "Bud Light"', r.found, true);
r = rankByMatch('Grey Goose Vodka', P('Grey Goose 750 ML'));
eq('a type word the brand implies is not required', r.found, true);
r = rankByMatch('Fever-Tree Ginger Beer', P('Fever Tree Ginger Beer 4 x 6.8 OZ'));
eq('hyphen', r.found, true);
r = rankByMatch('Génépy', P('Dolin Genepy Le Chamois 750 ML'));
eq('accents', r.found, true);
r = rankByMatch('sparkling rose', P('Veuve Clicquot Brut Rose Champagne 750ml', 'Cuvee 89 Sparkling Rose 750 ML'));
eq('a generic query is not filtered', [r.found, names(r).length], [true, 2]);
// F-0022 (Oct 7 nightly): filler / container / Spanish type words were required in the product name.
r = rankByMatch('Conundrum White 750 ML too', P('Conundrum White - 750 ML'));
eq('"too" is filler', r.found, true);
r = rankByMatch('vino tinto', P('Mondavi Napa Cabernet - 750 ML', "Stag's Leap Merlot - 750 ML"));
eq('"vino tinto" is a type, not a producer', [r.found, names(r).length], [true, 2]);
r = rankByMatch('Modelo can', P('Modelo Especial 24x12 Oz Bottle'));
eq('"can" is a container', r.found, true);
r = rankByMatch('Green Chartreuse', P('Johnnie Walker Green 15yr - 750 ML'));
eq('a real producer word still required', r.found, false);
process.exit(failed ? 1 : 0);
