// Unit tests for store-agent/alternatives.js against the REAL 10010 Chardonnay inventory
// (fixtures/chardonnay-10010.json, saved Sep 27). Run: node qa/unit/alternatives.test.js
const { rankAlternatives, varietalOf, regionOf } = require('../../../store-agent/alternatives.js');
const inv = require('./fixtures/chardonnay-10010.json');

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
};
const names = r => r.alternatives.map(a => a.name.replace(/ - 750 ML$/, ''));

console.log('parsing');
eq('varietal', varietalOf('Paul Hobbs Chardonnay - Richard Dinner Vineyard, Sonoma Mountain'), 'chardonnay');
eq('sub-region', regionOf('Ramey Chardonnay - Russian River Valley, Sonoma Coast').name, 'russian river');
eq('producer region', regionOf('Far Niente Chardonnay - 750 ML').family, 'napa');

console.log('Paul Hobbs Richard Dinner (~$85) — the Sep 27 complaint: La Crema $21 was offered as the stand-in');
{
  const r = rankAlternatives({ name: 'Paul Hobbs Chardonnay - Richard Dinner Vineyard, Sonoma Mountain' }, inv, 85);
  eq('in-tier Far Niente first, then the nearest Sonoma-side wines', names(r), ['Far Niente Chardonnay', 'Flowers Chardonnay Sonoma Coast', 'Rombauer Vineyards Chardonnay']);
  eq('tiers are honest', r.alternatives.map(a => a.tier), ['same tier', 'lower tier', 'lower tier']);
  eq('each alternative names what it replaces', r.alternatives.every(a => a.replaces.startsWith('Paul Hobbs')), true);
  eq('La Crema ($21) is not offered', names(r).some(n => /La Crema/.test(n)), false);
}

console.log('Ramey Russian River (~$45)');
{
  const r = rankAlternatives({ name: 'Ramey Chardonnay - Russian River Valley, Sonoma Coast' }, inv, 45);
  eq('the three Sonoma-side in-tier wines (ties go to the nearest price)', names(r), ['Rombauer Vineyards Chardonnay', 'Frank Family Chardonnay Carneros', 'Flowers Chardonnay Sonoma Coast']);
  eq('all same region', r.alternatives.map(a => a.region_match), ['same region', 'same region', 'same region']);
  eq('all same tier', r.alternatives.map(a => a.tier), ['same tier', 'same tier', 'same tier']);
  eq('no_tier_match false', r.no_tier_match, false);
}

console.log('nothing at the tier');
{
  const r = rankAlternatives({ name: 'Kistler Chardonnay Vine Hill Vineyard Russian River' }, inv, 400);
  eq('no_tier_match flagged', r.no_tier_match, true);
  eq('still returns the nearest, labelled lower tier', r.alternatives.every(a => a.tier === 'lower tier'), true);
}

console.log('style and size');
{
  const r = rankAlternatives({ name: 'Paul Hobbs Chardonnay Russian River' }, inv, 60);
  eq('no sparkling, box or non-750 bottles', r.alternatives.some(a => /brut|ruinart|3 l|1\.5 l|375/i.test(a.name)), false);
}

console.log('no price anchor (rosé) — the Sep 27 smoke: Dom Perignon Rosé $659.99 and a canned cider were offered');
{
  const pool = [
    { name: 'Dom Perignon Luminous Rose - 750 ML', price: 659.99 }, { name: 'Austin East Cider Rose 24x12 Oz Cans', price: 62.99 },
    { name: "Ch d'Esclans Whispering Angel Rose - 750 ML", price: 24.19 }, { name: 'The Beach Rose - 750 ML', price: 20.89 },
    { name: 'Miraval Rose - 750 ML', price: 27.49 }, { name: 'Domaines Ott Chateau de Selle Rose - 750 ML', price: 64.89 },
  ];
  const r = rankAlternatives({ name: 'Domaines Ott By Ott Rosé' }, pool, null);
  eq('no sparkling house, no cans/cider', r.alternatives.some(a => /Perignon|Cider/.test(a.name)), false);
  eq('tier unknown when unanchored', r.alternatives.every(a => a.tier === 'unknown'), true);
}


// Same TYPE first (DC, Sep 30): Lillet Blanc (aperitif) was offered Ruinart Blanc de Blancs, Malbec, Cabernet.
{
  const c = [{ name: 'Ruinart Blanc de Blancs Brut NV - 750 ML', price: 138.59 }, { name: 'Catena Malbec - 750 ML', price: 27.29 },
    { name: 'Cocchi Americano Bianco 750 ML', price: 24.99, subCategory: 'Aperitif' }, { name: 'Chandon Brut 750 ML', price: 26.99 },
    { name: 'Ritual Zero Proof Aperitif Alt - 750 ML', price: 28.76 }];
  const r1 = rankAlternatives({ name: 'Lillet Blanc 750 mL' }, c, 27.94);
  eq('an aperitif gets only (alcoholic) aperitifs', r1.alternatives.map(a => a.name), ['Cocchi Americano Bianco 750 ML']);
  const r2 = rankAlternatives({ name: 'Lillet Blanc 750 mL', type: 'sparkling' }, c, 27.94);
  eq('asked for sparkling near its price: sparkling, in tier first', r2.alternatives.map(a => a.name), ['Chandon Brut 750 ML', 'Ruinart Blanc de Blancs Brut NV - 750 ML']);
}
console.log(failed ? '\nalternatives: ' + failed + ' FAILED' : '\nalternatives: all passed');
process.exit(failed ? 1 : 0);
