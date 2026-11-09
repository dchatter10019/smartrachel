// Nov 9 (DC on Claude Code, connector rachel_chat): "Open bar with mixed drinks (spirits + mixers), beer, and wine for 15
// people ... Please use Mi Campo for any tequila, and only 750 mL or larger bottles for wine and spirits" — read in code.
// Run: node qa/unit/event-intake-nov9.test.js (precheck.sh runs every qa/unit/*.test.js).
const { spiritTypesIn } = require('../../event-prefs.js');
const { minBottleMlIn } = require('../../bottle-size.js');
const { mixersFor } = require('../../mixers.js');
const { durationIn } = require('../../serving-mix.js');
const { stripModelDrinkClaims } = require('../../package-facts.js');
let failed = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want))); };
const brief = 'Hi Rachel, I need an event package for a corporate event. Open bar with mixed drinks (spirits + mixers), beer, and wine for 15 people. Budget $25–30 per person ($375–$450 total). Please use Mi Campo for any tequila, and only 750 mL or larger bottles for wine and spirits.';
const sp = t => (spiritTypesIn(t) || {}).types || null;
eq('"Mi Campo for any tequila" is a brand preference, not a tequila-only bar', sp(brief), null);
eq('"if there\'s tequila, Mi Campo" too', sp("if there's tequila make it Mi Campo"), null);
eq('a preferred spirit joins the named ones', sp('for the tequila use Mi Campo, and a bourbon'), ['bourbon', 'tequila']);
eq('"tequila bar" still narrows', sp('a tequila bar for 20'), ['tequila']);
eq('750 mL or larger', minBottleMlIn(brief), 750);
eq('no half bottles', minBottleMlIn('wine for 30, no half bottles'), 750);
eq('a plain size is not a minimum', minBottleMlIn('2 x Tito\'s 750ml'), 0);
eq('unnamed mixers -> the standard set', mixersFor(brief), { keys: ['tonic', 'soda_water', 'cranberry', 'orange'], defaulted: true });
eq('"mixed drinks" alone -> the standard set', mixersFor('Open bar with mixed drinks, beer, and wine').defaulted, true);
eq('named mixers win', mixersFor('mixers: coke and oj').keys, ['cola', 'orange']);
eq('"no mixers" -> none', mixersFor('no mixers, we have our own').keys, []);
eq('"we have mixers" -> none', mixersFor('we have mixers already').keys, []);
eq('no duration in the brief', durationIn(brief), '');
eq('duration in an answer', durationIn('about even, 2 hours'), '2 hours');
const r = stripModelDrinkClaims('Here it is.\n\nThis package delivers about 3 drinks per person for your 15 guests over 2 hours.\n\nThis package delivers 4 drinks per person for your 15 guests. One heads-up: the Chandon came in 375 mL.');
eq('model drinks claims removed, the rest kept', r, { text: 'Here it is.\n\nOne heads-up: the Chandon came in 375 mL.', removed: 2 });
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('event-intake-nov9: all passed');
