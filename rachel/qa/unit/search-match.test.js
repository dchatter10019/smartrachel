// Unit tests for search-match.js — real catalog rows returned for queries the store doesn't carry (DC, Oct 6, claude.ai).
// (precheck.sh runs qa/unit/*.test.js.)
const { rankByMatch, missingNameWords, modelNumbers } = require('../../search-match.js');
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
// F-0091: a grape named next to a producer must be in the name (or the name shows no grape at all).
r = rankByMatch('Hess Cabernet', P('Hess Select Treo Red Blend 750 ML'));
eq('Hess Cabernet: a Hess red blend is not it', r.found, false);
r = rankByMatch('Hess Cabernet', P('Hess Select Treo Red Blend 750 ML', 'Hess Shirtail Ranches Cabernet Sauvignon 750 ML'));
eq('Hess Cabernet: the Cabernet kept', names(r), ['Hess Shirtail Ranches Cabernet Sauvignon 750 ML']);
eq('Opus One Cabernet = Opus One Red Wine (no grape in the name)', rankByMatch('Opus One Cabernet', P('Opus One Napa Valley Red Wine 750 ML')).found, true);
eq('syrah = shiraz', rankByMatch('Meiomi Shiraz', P('Meiomi Syrah 750 ML')).found, true);
eq('a grape alone is unchanged', rankByMatch('cabernet', P('Hess Select Treo Red Blend 750 ML')).found, true);
// F-0090: a bottling number is part of the name; sizes, counts, packs and vintages are not.
eq('Penfolds Bin 407: other bins dropped', rankByMatch('Penfolds Bin 407', P('Penfolds Bin 389 Cabernet Shiraz', 'Penfolds Bin 600 Cabernet Shiraz')).found, false);
eq('Penfolds Bin 407 found', names(rankByMatch('Penfolds Bin 407', P('Penfolds Bin 389 Cabernet Shiraz', 'Penfolds Bin 407 Cabernet Sauvignon 750 ML'))), ['Penfolds Bin 407 Cabernet Sauvignon 750 ML']);
eq('Macallan 18 is not the 12', rankByMatch('Macallan 18', P('The Macallan 12 Year Double Cask')).found, false);
eq('numbers read', [modelNumbers('Penfolds Bin 407'), modelNumbers('Macallan 18'), modelNumbers('Glenlivet 12 year old'), modelNumbers("3 Tito's 750"), modelNumbers('Stella Artois 12 pack'), modelNumbers('Caymus 2021'), modelNumbers('Don Julio 1942')], [['407'], ['18'], ['12'], [], [], [], []]);
// F-0089: the wine's own name after the producer; places and descriptors don't count.
eq('Orin Swift Prisoner: prisoner missing', missingNameWords('Orin Swift Prisoner', P('Orin Swift Abstract Red', 'Orin Swift Sign of the Times')), ['prisoner']);
eq('Napa / Original / Label never missing', [missingNameWords('Caymus Napa Valley', P('Caymus Cabernet')), missingNameWords('Grey Goose Vodka Original', P('Grey Goose Vodka 750 ML')), missingNameWords('Johnnie Walker Black Label', P('Johnnie Walker Black 750 ML'))], [[], [], []]);
process.exit(failed ? 1 : 0);
