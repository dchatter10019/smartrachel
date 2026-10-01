// Unit tests for product-match.js on Sean's real 22-line quote (Sep 29, zip 02110): the right product
// ranks first when it's in stock, and a non-exact pick is labeled with what differs.
// (precheck.sh runs qa/unit/*.test.js.)
const { fit, verdict, packCount, styleQuery, searchKey, brandWords, displayName } = require('../../product-match.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const P = (name, sizeStr) => ({ name, sizeStr });
const best = (req, prods) => prods.slice().sort((a, b) => fit(req, b).score - fit(req, a).score)[0].name;

console.log('packCount');
eq('30x12 OZ', packCount('Bud Light American Lager Beer 30x12 OZ Can'), 30);
eq('(30 cans per case)', packCount('Bud Light (30 cans per case)'), 30);
eq('12pk', packCount('Pilsner Urquell 12pk 12 OZ Btl'), 12);
eq('8pk', packCount('High Noon Variety Pool Pack 8pk 12 OZ Can'), 8);
eq('750 mL bottle', packCount('Oyster Bay Sauvignon Blanc - 750 ML'), 0);

console.log('the right product ranks first when it is in stock');
eq('Bud Light 30 pack: the lager, not the Platinum seltzer 6-pack',
  best('Bud Light 30 pack cans', [P('Bud Light Platinum Hard Seltzer Variety Pack 6pk 12 OZ Slim Cans 8% ABV'), P('Bud Light American Lager Beer 30x12 OZ Can', '30x12 Oz Can')]),
  'Bud Light American Lager Beer 30x12 OZ Can');
eq('Carlsberg 12 cans: the 12-pack',
  best('Carlsberg 12 cans per case', [P('Carlsberg 4x16 OZ Can'), P('Carlsberg 12x16 OZ Can'), P('Carlsberg 6x11 OZ Bottle')]), 'Carlsberg 12x16 OZ Can');
eq('Pumpkin beer: a pumpkin ale, not a spiked seltzer',
  best('Pumpkin beer 12 cans', [P('Bon & Viv Spiked Seltzer Variety Pack - 12 X12 OZ CANS'), P('Shipyard Pumpkinhead Ale 12x12 OZ Can')]), 'Shipyard Pumpkinhead Ale 12x12 OZ Can');
eq('Sun Cruiser Lemonade: never the Iced Tea pack when a lemonade exists',
  best('Sun Cruiser Lemonade Variety pack 18 cans', [P('Sun Cruiser Iced Tea Vodka VP - 355 ML'), P('Surfside Vodka Lemonade Variety - 12 OZ')]), 'Surfside Vodka Lemonade Variety - 12 OZ');
eq('Oktoberfest spelling counts as Octoberfest',
  best('Samuel Adams Octoberfest 12 cans', [P('Samuel Adams Boston Lager 12x12 OZ Bottle'), P('Samuel Adams Octoberfest 12x12 OZ Can')]), 'Samuel Adams Octoberfest 12x12 OZ Can');

console.log('verdicts');
eq('exact', verdict('Michelob Ultra 30 pack cans', P('Michelob ULTRA Light Lager 30x12 OZ Can')).kind, 'exact');
eq('exact wine', verdict('Josh Cellars Cabernet Sauvignon', P('Josh Cellars Cabernet Sauvignon - 750 ML')).kind, 'exact');
const w = verdict('Warsteiner Premium Pilsener 24 cans', P('Warsteiner Variety Pack 15x11 OZ Can'));
eq('Warsteiner variety is closest', w.kind, 'closest');
eq('...and says why', w.note, 'no pilsener in stock; 15-pack, not 24');
eq('Sam Adams Boston Lager for Octoberfest is closest', verdict('Samuel Adams Octoberfest 12 cans', P('Samuel Adams Boston Lager 12x12 OZ Bottle')).note, 'no octoberfest in stock');
eq('Bud Light Platinum seltzer is not Bud Light', verdict('Bud Light 30 pack cans', P('Bud Light Platinum Hard Seltzer Variety Pack 6pk 12 OZ Slim Cans')).kind, 'closest');
eq('High Noon 8-pack for a 12-pack', verdict('High Noon Hard Seltzer Variety 12 cans', P('High Noon Variety Pool Pack 8pk 12 OZ Can 4.5% ABV')).note, '8-pack, not 12');

console.log('styleQuery (alternative search when the brand is not carried)');
eq('Smithwicks Red Ale', styleQuery('Smithwicks Red Ale', ['smithwicks']), 'red ale');
eq('Sam Adams Octoberfest (catalog spelling, cans)', styleQuery('Samuel Adams Octoberfest 12 cans', ['octoberfest']), 'oktoberfest can');
eq('Casamigos Margarita cans', styleQuery('Casamigos Margarita Cocktail Cans 8 pack', ['casamigos']), 'margarita can');
eq('Ciderboys names cider', styleQuery('Ciderboys Island Mix Pack 12 pack cans', ['ciderboys', 'island']), 'cider can');
eq('a brand-only request has no style', styleQuery('Lord Hobo Boom Sauce', ['lord', 'hobo']), '');

console.log('Sean replay fixes (Sep 29)');
eq('Pumpkinhead 12-pack beats a 16 oz single', best('Pumpkin beer 12 pack cans', [P('Shipyard Smashed Pumpkin - 16 OZ', '16OZ'), P('Shipyard Pumpkinhead Ale 12x12 OZ Can', '12x12 Oz Can')]), 'Shipyard Pumpkinhead Ale 12x12 OZ Can');
eq('margarita cans: an 8-pack of cans beats a 750 mL bottle', best('Casamigos Margarita Cocktail Cans 8 pack', [P('Skinnygirl Margarita - 750 ML', '750ML'), P('Crook & Marker Lime Margarita 8pk 11.5 OZ Can 5.0% ABV', '11.5OZ')]), 'Crook & Marker Lime Margarita 8pk 11.5 OZ Can 5.0% ABV');
eq('lemonade variety beats a single can', best('Sun Cruiser Lemonade Variety Pack 18 cans', [P('Smirnoff Ice Smash Pink Lemonade 23.5 OZ Can 8.0% ABV'), P('Surfside Vodka Lemonade Variety - 12 OZ')]), 'Surfside Vodka Lemonade Variety - 12 OZ');
eq('Sun Cruiser Iced Tea Vodka VP is the Iced Tea variety', verdict('Sun Cruiser Iced Tea Variety Pack 18 cans', P('Sun Cruiser Iced Tea Vodka VP - 355 ML')).kind, 'exact');
eq('Pilsner Urquell beats the Warsteiner variety for "Pilsener only"', best('Warsteiner Premium Pilsener 24 cans', [P('Warsteiner Variety Pack 15x11 OZ Can'), P('Pilsner Urquell 12pk 12 OZ Btl 4.4% ABV')]), 'Pilsner Urquell 12pk 12 OZ Btl 4.4% ABV');
eq('searchKey', searchKey('Bud Light 30 pack cans'), 'bud light 30');
eq('brandWords generic', brandWords('Pumpkin beer 12 pack cans'), []);
eq('brandWords named', brandWords('Samuel Adams Octoberfest 12 pack cans'), ['samuel', 'adams']);
eq('displayName', displayName('Warsteiner Premium Pilsener 24 cans'), 'Warsteiner Premium Pilsener');
eq('displayName (per case)', displayName('Bud Light (30 cans per case)'), 'Bud Light');

eq('an Oktoberfest from another brand beats Sam Adams Boston Lager', best('Samuel Adams Octoberfest 12 pack cans', [P('Samuel Adams Boston Lager 12x12 OZ Bottle'), P('Goose Island Seasonal - Oktoberfest 6pk 12 OZ Can')]), 'Goose Island Seasonal - Oktoberfest 6pk 12 OZ Can');
eq('"Rose from Provence": "from" is not a missing brand word (Oct 1, DC: "no from in stock")', verdict('Rose from Provence', P('Rumor Organic Provence Rose - 750 ML')).note, '');
eq('"Grey Goose Vodka 750ml" is Grey Goose - 750 ML (Oct 1, Sean: flagged, Stoli offered)', verdict('Grey Goose Vodka 750ml', P('Grey Goose - 750 ML')).kind, 'exact');
eq('the brand implies the type only when the product adds no words: Patron XO Cafe is not "Patron Tequila"', verdict('Patron Tequila', P('Patron XO Cafe - 750 ML')).kind, 'closest');
eq('...nor Grey Goose Le Citron "Grey Goose Vodka"', verdict('Grey Goose Vodka', P('Grey Goose Le Citron - 750 ML')).kind, 'closest');
eq('another brand of the type is still not it', verdict("Tito's Vodka", P('Smirnoff Vodka - 750 ML')).note, 'no titos in stock');

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
