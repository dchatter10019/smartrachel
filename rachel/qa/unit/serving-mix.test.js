// Unit tests for serving-mix.js — the customer's drink mix for an event. (precheck.sh runs qa/unit/*.test.js.)
const S = require('../../serving-mix.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const mix = (t, c) => { const r = S.parseServingMix(t, c || ['beer', 'wine'], false); return r && Object.fromEntries(Object.entries(r.mix).map(([k, v]) => [k, Math.round(v * 100)])); };
eq('"60 pct wine, 40 pct beer" (Oct 4, claude.ai connector — was read as 50/50)', mix('60 pct wine, 40 pct beer'), { beer: 40, wine: 60 });
eq('"60 percent wine"', mix('60 percent wine'), { beer: 40, wine: 60 });
eq('"60/40 wine/beer"', mix('60/40 wine/beer'), { beer: 40, wine: 60 });
eq('"70-30 beer to wine"', mix('70-30 beer to wine'), { beer: 70, wine: 30 });
eq('"wine 70%, beer 30%" (number after the drink was NaN)', mix('wine 70%, beer 30%'), { beer: 30, wine: 70 });
eq('"50% wine" with three types', mix('50% wine', ['beer', 'wine', 'spirits']), { beer: 25, wine: 50, spirits: 25 });
eq('"mostly wine" unchanged', mix('mostly wine'), { beer: 35, wine: 65 });
// Cocktails asked for with no names are asked in code (Oct 7, event-serving-mix on staging: a full bar, then the names wiped the package)
eq('"wine, beer and cocktails" has no cocktail names', S.cocktailsUnnamed('party for 40 guests, 3 hours, budget $2500 — we want wine, beer and cocktails'), true);
eq('"2 signature cocktails" has no names', S.cocktailsUnnamed('2 signature cocktails and some wine'), true);
eq('a name from prompt 8.3 counts ("margaritas")', S.cocktailsUnnamed('wine and cocktails, margaritas mostly'), false);
eq('"cocktails: X and Y" counts as named (any cocktail, not only 8.3)', S.cocktailsUnnamed('cocktails: french 75 and a bramble'), false);
eq('"cocktails like ..." counts as named', S.cocktailsUnnamed('beer and cocktails like a Hugo spritz'), false);
eq('"gin and tonic" = Gin & Tonic', S.cocktailsUnnamed('wine and cocktails — gin and tonics'), false);
eq('no cocktail word: not this gate', S.cocktailsUnnamed('wine, beer and liquor'), false);
eq('a product line with "Cocktail" in its name is not a request', S.cocktailsUnnamed('3 x Jack Daniel\'s Mixed with Coca-Cola Cocktail 4-Pack\nfor 20 guests, mostly beer'), false);
eq('the 8.3 names are read from prompt.md', S.knownCocktails().includes('Moscow Mule'), true);
console.log(failed ? '\nserving-mix: ' + failed + ' FAILED' : '\nserving-mix: all passed');
if (failed) process.exit(1);
