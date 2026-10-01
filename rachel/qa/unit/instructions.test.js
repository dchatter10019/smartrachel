// Unit tests for the Sep 29 Slack session (zip 33409): a 3-bullet message whose "Change the Rum count
// to 5" was silently dropped, Casamigos added at 1 instead of replacing the 4 Patron, and "higher end
// whiskey" searched as "High ...". (precheck.sh runs every qa/unit/*.test.js during lint.)
const { splitInstructions, unaddressed, applyCountInstructions } = require('../../instructions.js');
const { spiritType } = require('../../spirit-type.js');
const { stripDescriptors } = require('../../../store-agent/core-first.js');

let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

const MSG = '• Instead of Bacardi – please replace with a higher end whiskey\n• Change the Rum count to 5\n• For tequila, they would like Don Julio and Casa Migos as their two options.';
const BASKET = [['BACARDI Superior White Rum - 750 ML', 5], ['Mount Gay Black Barrel - 750 ML', 4], ['Mi Campo Reposado Tequila - 750 ML', 5],
  ['Patron Silver - 750 ML', 4], ['Belvedere Organic Vodka - 750 ML', 4]].map(([name, qty]) => ({ name, qty }));
// Rachel's real reply to MSG (the options turn): swaps listed, rum count never mentioned.
const REPLY = "A few options to nail down — let me take these one at a time:\n\n*WHISKEY (replacing Bacardi, 5 bottles):*\n1. *High West A Midwinter's Night Dram* — 750 mL — $223.99\n4. *High West Bourbon Whiskey* — 750 mL — $42.55\n\n*DON JULIO (replacing Mi Campo, pick a style):*\n6. *Don Julio Blanco* — 750 mL — $49.99\n\n*CASAMIGOS:*\n8. *Casamigos Blanco* — 750 mL — $53.99\n\nFor the tequila, the plan would be to split the 5 bottles between Don Julio and Casamigos — which Don Julio style do you prefer? And which whiskey would you like for the 5-bottle replacement?";

console.log('instructions split');
{
  eq('3 bullets -> 3 instructions', splitInstructions(MSG), ['Instead of Bacardi – please replace with a higher end whiskey', 'Change the Rum count to 5', 'For tequila, they would like Don Julio and Casa Migos as their two options.']);
  eq('a one-line message is not a checklist', splitInstructions('5 Bacardi and 4 Patron'), []);
}

console.log('unaddressed instructions (the dropped rum count)');
{
  eq('real reply -> only the rum count is unaddressed', unaddressed(splitInstructions(MSG), REPLY, BASKET, BASKET), ['Change the Rum count to 5']);
  const after = BASKET.map(it => /Mount Gay/.test(it.name) ? { name: it.name, qty: 5 } : it);
  eq('Mount Gay set to 5 in the basket -> handled', unaddressed(['Change the Rum count to 5'], 'Done.', BASKET, after), []);
  eq('reply asks which rum, with the 5 -> handled', unaddressed(['Change the Rum count to 5'], 'Which rum should go to 5 bottles — Mount Gay or Bacardi?', BASKET, BASKET), []);
  eq('Bacardi removed is not the rum count', unaddressed(['Change the Rum count to 5'], 'Swapped Bacardi for High West.', BASKET, BASKET.filter(it => !/BACARDI/.test(it.name))), ['Change the Rum count to 5']);
}

console.log('count instruction applied in code (Rum = Mount Gay, not the Bacardi being replaced)');
{
  const items = BASKET.map(it => Object.assign({}, it));
  const done = applyCountInstructions(splitInstructions(MSG), items, () => {});
  eq('one change: Mount Gay 4 -> 5', done.map(d => [d.name, d.from, d.to]), [['Mount Gay Black Barrel - 750 ML', 4, 5]]);
  eq('Bacardi untouched', items.find(it => /BACARDI/.test(it.name)).qty, 5);
  const two = [{ name: 'BACARDI Superior White Rum - 750 ML', qty: 5 }, { name: 'Mount Gay Black Barrel - 750 ML', qty: 4 }];
  eq('two rums, none replaced -> left to the LLM', applyCountInstructions(['Change the Rum count to 5', 'Add ice'], two, () => {}), []);
  eq('"make the Patron 6"-style without "to" is not parsed', applyCountInstructions(['Patron please', 'Add ice'], BASKET.map(it => Object.assign({}, it)), () => {}), []);
}

console.log('spirit types (names that never say the type)');
{
  eq('Patron Silver', spiritType('Patron Silver - 750 ML'), 'tequila');
  eq('Casamigos Blanco', spiritType('Casamigos Blanco - 750 ML'), 'tequila');
  eq('Mount Gay Black Barrel', spiritType('Mount Gay Black Barrel - 750 ML'), 'rum');
  eq('High West Bourbon Whiskey', spiritType('High West Bourbon Whiskey - 750 ML'), 'whiskey');
  eq('Belvedere', spiritType('Belvedere Organic Vodka - 750 ML'), 'vodka');
  eq('a wine', spiritType('Bogle Pinot Noir California - 750 ML'), '');
}

console.log('descriptor words out of search text');
{
  eq('"high end whiskey 750 ml"', stripDescriptors('high end whiskey 750 ml'), 'whiskey 750 ml');
  eq('"higher-end bourbon"', stripDescriptors('higher-end bourbon'), 'bourbon');
  eq('"top shelf tequila"', stripDescriptors('top shelf tequila'), 'tequila');
  eq('"High West Bourbon" untouched', stripDescriptors('High West Bourbon'), 'High West Bourbon');
  eq('nothing left -> unchanged', stripDescriptors('premium 750 ml'), 'premium 750 ml');
}

// An approval is not an unaddressed instruction (Sep 30, DC: "... -> good" got "I haven't done this one yet").
{
  const { unaddressed } = require('../../instructions.js');
  const got = unaddressed(['12x Fort Point KSA Kolsch 6pk 12 OZ Can -> good', 'La Crema Pinot Noir Sonoma Coast 750 mL -> suggest another 750 ML'], 'Here are some alternatives for La Crema Pinot Noir', [], []);
  const ok = JSON.stringify(got) === JSON.stringify([]);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + 'an approval ("-> good") is never flagged as not done' + (ok ? '' : ' got ' + JSON.stringify(got)));
}
// Oct 1, DC (Slack): "Remy Cointreau -> Cointreau 750 ML" narrated as done, never applied.
{
  const { arrowSwaps, uniqueProductFor, unaddressed } = require('../../instructions.js');
  const t = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want))); };
  const msg = 'Rose from Provence -&gt; can we do whispering agnel?\nRemy Cointreau -&gt; Cointreau 750 ML';
  t('Slack-escaped arrows parse into swaps', arrowSwaps(msg).map(s => [s.from, s.to]), [['Rose from Provence', 'can we do whispering agnel?'], ['Remy Cointreau', 'Cointreau 750 ML']]);
  t('an approval arrow is not a swap', arrowSwaps('12x Fort Point KSA Kolsch -> good'), []);
  const shown = [{ name: "Ch d'Esclans Whispering Angel Rose - 750 ML", size: '750 ML', product_id: 'a' }, { name: "Whispering Angel Chateau d'Esclans Rose - 1.5 L", size: '1.5 L', product_id: 'b' },
    { name: 'Cointreau Orange Liqueur - 750 ML', size: '750 ML', product_id: 'c' }, { name: 'Cointreau Orange Liqueur - 1 L', size: '1 L', product_id: 'd' }];
  t('"Cointreau 750 ML" = the one 750 mL Cointreau shown', (uniqueProductFor('Cointreau 750 ML', shown) || {}).name, 'Cointreau Orange Liqueur - 750 ML');
  t('"Cointreau" with two sizes shown = not unique (ask)', uniqueProductFor('Cointreau', shown), null);
  t('"can we do whispering agnel?" = not resolved in code (the LLM asks the size)', uniqueProductFor('can we do whispering agnel?', shown), null);
  const before = [{ name: 'Remy Martin 1738 Accord Royal - 375 ML', qty: 1 }];
  const reply = 'Whispering Angel Rosé — which size for the 3 bottles?\n✅ Cointreau Orange Liqueur - 750 ML — $43.96 — replacing the Remy Martin 1738';
  t('a swap only NARRATED (basket unchanged) is not done', unaddressed(['Remy Cointreau -&gt; Cointreau 750 ML'], reply, before, before), ['Remy Cointreau -&gt; Cointreau 750 ML']);
  t('a swap asked about in a question is handled', unaddressed(['Rose from Provence -&gt; can we do whispering agnel?'], reply, before, before), []);
  t('one sentence claims the other swap, the next asks about this one: handled', unaddressed(['Rose from Provence -&gt; can we do whispering agnel?'], "*Cointreau Orange Liqueur - 750 ML* is swapped in. Just let me know which Whispering Angel size you'd like and I'll update the rosé too!", before, before), []);
  t('a swap applied in the basket is done', unaddressed(['Remy Cointreau -&gt; Cointreau 750 ML'], reply, before, [{ name: 'Cointreau Orange Liqueur - 750 ML', qty: 1 }]), []);
}
console.log(failed ? '\ninstructions: ' + failed + ' FAILED' : '\ninstructions: all passed');
process.exit(failed ? 1 : 0);
