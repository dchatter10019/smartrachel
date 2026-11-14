// Sean, Nov 13-14: "12 Bottles of Chateau Lamour Saint Emillion Grand Cru Bordeaux" — the store's "Chateau Lamour Saint
// Emilion Grand Cru - 750 ML" (catalog region Bordeaux) was "not an exact match": "emillion" (his spelling) and "bordeaux"
// (the region, not in the name) counted as missing, and Château La Plaige Bordeaux was offered. (precheck runs qa/unit.)
const PM = require('../../product-match.js');
let failed = 0;
const eq = (label, got, want) => { const ok = got === want; if (!ok) failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : ' — got ' + got)); };
const lamour = { name: 'Chateau Lamour Saint Emilion Grand Cru - 750 ML', sizeStr: '750 ML', region: 'Bordeaux', appellation: 'Saint-Emilion Grand Cru', varietal: 'Merlot, Cabernet Franc', country: 'France' };
eq('Sean\'s line = exact (spelling + region from the catalog fields)', PM.verdict('Chateau Lamour Saint Emillion Grand Cru Bordeaux', lamour).kind, 'exact');
eq('region not in the catalog fields -> still flagged', PM.verdict('Chateau Lamour Saint Emilion Grand Cru Bordeaux', Object.assign({}, lamour, { region: '' })).kind, 'closest');
eq('another chateau is never exact', PM.verdict('Chateau Margaux Bordeaux', lamour).kind, 'closest');
eq('descriptor words alone never make an exact match', PM.verdict('Merlot Bordeaux', lamour).kind, 'closest');
eq('short words need the real spelling', PM.verdict('Bud Lite', { name: 'Bud Light 12pk' }).kind === 'exact' ? 'exact' : 'closest', 'closest');
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
