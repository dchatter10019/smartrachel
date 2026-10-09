// event-prefs.js: which spirits / which beer an event customer asked for (Oct 7, connector: "bourbon and tequila bar",
// "Oktoberfest selections" and "remove the vodka, rum and gin" were never passed — every rebuild was the same full bar).
// Run: node qa/unit/event-prefs.test.js (precheck.sh runs every qa/unit/*.test.js).
const { spiritTypesIn, beerStyleIn } = require('../../event-prefs.js');
let failed = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want))); };
const sp = t => (spiritTypesIn(t) || {}).types || null, bs = t => (beerStyleIn(t) || {}).label || null;
eq('DC Oct 7 brief', sp('Oktoberfest-themed party. Wine, beer (Oktoberfest selections), bourbon, and tequila bar. 150 guests'), ['bourbon', 'tequila']);
eq('DC Oct 7 revision', sp('The spirits should be only bourbon and tequila — remove the vodka, rum and gin, and replace the Evan Williams Egg Nog with an actual bourbon.'), ['bourbon', 'tequila']);
eq('"no vodka or gin" = the rest', sp('beer wine and liquor, no vodka or gin'), ['rum', 'bourbon', 'tequila']);
eq('nothing named = full bar', sp('party for 50 people, 4 hours, wine beer and spirits'), null);
eq('mixers are not spirits', sp('mostly spirits mixed with coke and OJ'), null);
eq('"mostly whiskey" leans, never one spirit', sp('mostly whiskey drinkers'), null);
eq('whiskey fills the bourbon slot', sp('a tequila and whiskey bar'), ['bourbon', 'tequila']);
eq('Oktoberfest beer', bs('beer (Oktoberfest selections)'), 'Oktoberfest');
eq('Oktoberfest theme alone is not the beer', bs('Oktoberfest-themed party, wine and spirits'), null);
eq('German beers', bs('we want german beers'), 'German');
eq('Mexican beers', bs('Mexican beers and margaritas'), 'Mexican');
eq('Oktoberfest falls back to German', (beerStyleIn('Oktoberfest beer') || {}).then.label, 'German');
const { isStyleLine } = require('../../event-prefs.js'), sl = t => (isStyleLine(t) || {}).label || null;
eq('"Oktoberfest Beer" is a style line', sl('Oktoberfest Beer'), 'Oktoberfest');
eq('"German beers - 3 cases" is a style line', sl('German beers - 3 cases'), 'German');
eq('a named lager is NOT a style line (Oct 9: Stella -> Busch Light)', sl('Stella Artois Premium Lager Beer 24 x 12 oz Cans'), null);
eq('Sam Adams Octoberfest is a product', sl('Sam Adams Octoberfest'), null);
eq('Goose Island IPA is a product', sl('Goose Island IPA 24 x 12 oz'), null);
console.log(failed ? '\nevent-prefs: ' + failed + ' FAILED' : '\nevent-prefs: all passed');
if (failed) process.exit(1);
