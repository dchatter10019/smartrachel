// Unit tests for drink-type.js — a stand-in must be the same TYPE (DC, Sep 30: Lillet Blanc -> Ruinart Blanc de
// Blancs). (precheck runs these.)
const { typeOf, isNA } = require('../../drink-type.js');
let failed = 0;
function eq(label, got, want) {
  const ok = got === want; if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '  got: ' + JSON.stringify(got) + ' want: ' + JSON.stringify(want)));
}
const T = (name, sub) => typeOf({ name, subCategory: sub });
eq('Lillet Blanc is an aperitif (not a white)', T('Lillet Blanc 750 mL'), 'aperitif');
eq('Bevvi subCategory decides', T('Lillet Blanc - 750 ML', 'Aperitif'), 'aperitif');
eq('Ruinart Blanc de Blancs is sparkling', T('Ruinart Blanc de Blancs Brut NV - 750 ML'), 'sparkling');
eq('Chandon Reserve Blanc de Blancs is sparkling', T('Chandon Reserve Blanc de Blancs 750 mL'), 'sparkling');
eq('a brut rosé is sparkling', T('Moet & Chandon Brut Rose Imperial'), 'sparkling');
eq('Whispering Angel is rosé', T('Whispering Angel Cotes de Provence'), 'rose');
eq('The Prisoner Red Blend is red', T('The Prisoner Red Blend 750 mL'), 'red');
eq('La Crema Pinot Noir is red', T('La Crema Pinot Noir Sonoma Coast 750 mL'), 'red');
eq('Craggy Range Sauvignon Blanc is white', T('Craggy Range Sauvignon Blanc 750 ML'), 'white');
eq('Conundrum White is white', T('Conundrum White 750 mL'), 'white');
eq("Taylor Fladgate Tawny is fortified", T('Taylor Fladgate 10 Year Tawny Port'), 'fortified');
eq("Tito's is vodka", T("Tito's Handmade Vodka 1.75 L"), 'spirit:vodka');
eq('Fort Point Kolsch has no wine type ("port" is a word match only)', T('Fort Point Beer Co. KSA Kolsch'), '');
eq('Ritual Zero Proof is non-alcoholic', isNA({ name: 'Ritual Zero Proof Aperitif Alt - 750 ML' }), true);
eq('KSA Kolsch Non-Alcoholic is non-alcoholic', isNA({ name: 'Fort Point Beer Co. KSA Kolsch Non-Alcoholic 6-pack' }), true);
eq('Lillet Blanc is not', isNA({ name: 'Lillet Blanc 750 mL' }), false);
eq('Napa is not "na"', isNA({ name: 'Mumm Napa Brut' }), false);
console.log(failed ? '\ndrink-type: ' + failed + ' FAILED' : '\ndrink-type: all passed');
if (failed) process.exit(1);
