// Nov 20 (DC on Slack, "With A Twist", Coral Springs FL 33071, 100 guests / 3 h / $6 a person, lemon drop + triple sec).
// per-person-budget.js, type-phrase.js, instructions.js (brief notes / pasted basket lines), saved-baskets.js ("no save ...").
const P = require('../../per-person-budget.js');
const T = require('../../type-phrase.js');
const I = require('../../instructions.js');
const S = require('../../saved-baskets.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
// per-person budget
eq('"100, 3 hours, 6 per person" = $6 a person', P.perPerson('100, 3 hours, 6 per person'), 6);
eq('"the budget is 6 per person" = $6 a person', P.perPerson('the budget is 6 per person'), 6);
eq('"$35/person"', P.perPerson('$35/person'), 35);
eq('"budget 35 a head"', P.perPerson('budget 35 a head'), 35);
eq('"6 drinks per person" is drinks', P.perPerson('6 drinks per person'), null);
eq('"4 drinks a person, budget $600" is drinks', P.perPerson('4 drinks a person, budget $600'), null);
eq('a bare "6 per person" with no hours / money cue is not read', P.perPerson('100 guests, 6 per person'), null);
eq('"600 dollars is the budget" is a total', P.perPerson('600 dollars is the budget'), null);
// type phrases
const ts = T.acceptFor('Triple Sec');
eq('Alizé Triple Melon is not a triple sec', ts.test('Alizé Triple Melon Liqueur - 750 ML'), false);
eq('Macallan Triple Cask is not a triple sec', ts.test('The Macallan Triple Cask 15 Years Old Single Malt Scotch Whisky - 750 ML'), false);
eq('Hiram Walker Triple Sec is', ts.test('Hiram Walker Triple Sec 60 Proof - 750 ML'), true);
eq('Cointreau stands in for triple sec', ts.test('Cointreau Orange Liqueur - 750 ML'), true);
eq('a brand term is not a type phrase', T.acceptFor('Tito\'s Vodka'), null);
// instructions: brief notes + pasted basket lines
const basket = [{ name: 'New Amsterdam Gluten Free Vodka - 750 ML', qty: 4 }, { name: 'Alizé Triple Melon Liqueur - 750 ML', qty: 3 }];
const i1 = I.splitInstructions('Requests: Beer, Wine, Seltzers, one sig Vodka (lemon drop); triple sec too.\nNotes: 80% Women. Go light on the beer.');
eq('"Requests:" / "Notes:" brief lines are not tasks', I.unaddressed(i1, 'How many guests?', [], []), []);
const i2 = I.splitInstructions('4x New Amsterdam Gluten Free Vodka - 750 ML — $16.67 ea = $66.68\n3x Alizé Triple Melon Liqueur - 750 ML — $24.63 ea = $73.89\nare these the ingredients for vodka lemon drop');
eq('pasted basket lines under a question are not tasks', I.unaddressed(i2, 'Yes, those are the core spirits for a Lemon Drop.', basket, basket), []);
const i3 = I.splitInstructions('6x New Amsterdam Gluten Free Vodka - 750 ML — $16.67 ea = $66.68\nremove the melon');
eq('a pasted line with a NEW count is still a task', I.unaddressed(i3, 'ok', basket, basket).length, 2);
// saved baskets
eq('"no save the basket" asks for a name', S.parse('no save the basket'), { kind: 'save', name: '' });
eq('"no, load my WAT basket"', S.parse('no, load my WAT basket'), { kind: 'load', name: 'WAT', explicit: true });
eq('"no thanks" is not a command', S.parse('no thanks'), null);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
