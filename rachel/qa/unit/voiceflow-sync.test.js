// Unit tests for the Voiceflow change set of Oct 21 ported to Rachel (DC: every channel behaves like the Voiceflow agent):
// event-wishes.js (ParseRequest wine_lean / mix_bias — checked for PARITY against ops/voiceflow/ParseRequest.js itself),
// mixer-guard.js, mi-campo.js, package-facts.js, staff-quote.js. (precheck runs these.)
const fs = require('fs');
const path = require('path');
const EW = require('../../event-wishes.js');
const MG = require('../../mixer-guard.js');
const MC = require('../../mi-campo.js');
const PF = require('../../package-facts.js');
const SQ = require('../../staff-quote.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

(async () => {
  // ---- event-wishes == Voiceflow ParseRequest (the same customer words give the same answer on every channel) ----
  const PHRASES = ['I want more white than red', 'mostly white please', 'white-heavy wine', 'more red than white', 'mostly red', 'red over white',
    'just wine', 'I want more beer than wine', 'I want more wine than beer', 'Please add more liquor, heavy on the spirits', 'I want it heavy on the spirits',
    '40% wine, 30% beer, more beer than wine', 'spirits-heavy please', 'beer over wine', 'beer, wine and spirits', 'heavy on the beer please',
    'mostly beer, some wine', 'less red please', 'more booze than beer'];
  let vf = null;
  const vfFile = path.join(__dirname, '../../../ops/voiceflow/ParseRequest.js');
  if (fs.existsSync(vfFile)) vf = (await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(vfFile, 'utf8')).toString('base64'))).default;
  for (const p of PHRASES) {
    const text = '40 guests, 3 hour party, budget $2500. ' + p;
    const mine = { wine_lean: EW.wineLeanIn(text), mix_bias: EW.mixBiasIn(text) };
    if (vf) { const o = (await vf({ inputVars: { customer_text: text } })).outputVars; eq('parity with Voiceflow ParseRequest: "' + p + '"', mine, { wine_lean: o.wine_lean, mix_bias: o.mix_bias }); }
  }
  eq('wine lean white', EW.wineLeanIn('more white than red'), 'white');
  eq('mix bias pair', EW.mixBiasIn('more beer than wine'), 'beer>wine');
  eq('mix bias single', EW.mixBiasIn('heavy on the spirits'), 'spirits');
  eq('percent split -> no bias', EW.mixBiasIn('60% wine, more beer'), '');

  // ---- mixer-guard ----
  const rows = n => n.map(name => ({ name }));
  eq('"Sugar" never a Coke', MG.guardMixerRows('Sugar', rows(['Coca-Cola Zero Sugar 12 OZ', 'Domino Pure Cane Sugar 1 LB'])).map(p => p.name), ['Domino Pure Cane Sugar 1 LB']);
  eq('"Coke" keeps Coca-Cola', MG.guardMixerRows('Coke', rows(['Coca-Cola Classic 2 L'])).map(p => p.name), ['Coca-Cola Classic 2 L']);
  eq('"Diet Coke" keeps Diet', MG.guardMixerRows('Diet Coke', rows(['Diet Coke 12 OZ'])).length, 1);
  eq('"Mint" never Oreo cookies', MG.guardMixerRows('Mint', rows(['Oreo Mint Cookies 14 OZ', 'Fresh Mint Bunch'])).map(p => p.name), ['Fresh Mint Bunch']);
  eq('"Chocolate Bitters" keeps chocolate', MG.guardMixerRows('Chocolate Bitters', rows(['Fee Brothers Aztec Chocolate Bitters'])).length, 1);
  eq('"Soda Water" = plain soda, never tonic', MG.guardMixerRows('Soda Water', rows(['Canada Dry Tonic Water 1 L', 'Canada Dry Club Soda 1 L'])).map(p => p.name), ['Canada Dry Club Soda 1 L']);
  eq('"Club Soda" with only tonic + a juice -> the non-tonic row', MG.guardMixerRows('Club Soda', rows(['Q Tonic Water', 'Topo Chico Mineral Water'])).map(p => p.name), ['Topo Chico Mineral Water']);
  eq('"Tonic Water" keeps tonic', MG.guardMixerRows('Tonic Water', rows(['Q Tonic Water'])).length, 1);

  // ---- mi-campo ----
  eq('generic: Tequila', MC.isGenericTequila('Tequila'), true);
  eq('generic: Blanco Tequila 750ml', MC.isGenericTequila('Blanco Tequila 750ml'), true);
  eq('branded: Patron Silver Tequila', MC.isGenericTequila('Patron Silver Tequila'), false);
  const mcRows = [{ name: 'Mi Campo Reposado Tequila - 750 ML', price: 27.49, sizeStr: '750 ML' }, { name: 'Mi Campo Blanco Tequila - 1 L', price: 32.99, sizeStr: '1 L' }];
  eq('NYC: Reposado 750 before Blanco 1 L', MC.bestMiCampo(mcRows).name, 'Mi Campo Reposado Tequila - 750 ML');
  eq('Blanco 750 first', MC.bestMiCampo(mcRows.concat([{ name: 'Mi Campo Blanco Tequila - 750 ML', price: 23.99, sizeStr: '750 ML' }])).name, 'Mi Campo Blanco Tequila - 750 ML');
  eq('customer max below Mi Campo -> none', MC.bestMiCampo(mcRows, { max: 20 }), null);
  eq('customer min above Mi Campo -> none', MC.bestMiCampo(mcRows, { min: 40 }), null);
  eq('a 50 mL is never the pick', MC.bestMiCampo([{ name: 'Mi Campo Blanco Tequila - 50 ML', price: 3 }]), null);

  // ---- package-facts ----
  const pkg = [
    { label: 'Red Wine', name: 'Josh Cabernet - 750 ML', qty: 1, category: 'wine' },
    { label: 'White Wine', name: 'Kim Crawford Sauvignon Blanc - 750 ML', qty: 1, category: 'wine' },
    { label: 'Sparkling Wine', name: 'La Marca Prosecco - 750 ML', qty: 1, category: 'wine' },
    { label: 'Beer', name: 'Corona Extra', size: '12x12 OZ', qty: 2, category: 'beer' },
    { label: 'Tequila', name: 'Mi Campo Blanco Tequila - 750 ML', qty: 1, category: 'spirits' },
    { label: 'Vodka', name: "Tito's Vodka - 750 ML", qty: 1, category: 'spirits' },
    { label: 'Bourbon', name: "Maker's Mark - 750 ML", qty: 1, category: 'spirits' },
    { label: 'Mixer: Coke', name: 'Coca-Cola 2 L', qty: 3, category: 'mixer' }];
  const f = PF.packageFacts(pkg, { guests: 20, hours: 2, targetDrinks: 60 });
  // 3 wine x 5 + 2 x 12 beer + 3 x 16 spirits = 87 -> 4 a person
  eq('wine heading counts sparkling', f.wine_heading, 'WINE — 3 bottles (1 red, 1 white, 1 sparkling)');
  eq('drinks statement: whole numbers, total = N x guests', f.drinks_statement, 'This package delivers about 4 drinks per person for your 20 guests over 2 hours (about 80 drinks total).');
  eq('why: over the target -> variety sentence', /^Your package includes at least one bottle or pack of each type/.test(f.why_drinks_statement), true);
  eq('why: at the target -> sized sentence', /^This package is sized for about 4 drinks per person/.test(PF.packageFacts(pkg, { guests: 20, hours: 2, targetDrinks: 87 }).why_drinks_statement), true);
  eq('drinks per person given -> no "over N hours"', PF.packageFacts(pkg, { guests: 20, drinksPerPerson: 4, targetDrinks: 80 }).drinks_statement, 'This package delivers about 4 drinks per person for your 20 guests (about 80 drinks total).');
  eq('no guests -> no statement (an order, not an event)', PF.packageFacts(pkg, {}).drinks_statement, '');
  eq('1.75 L counted by volume', Math.round(PF.servings({ name: "Tito's Vodka - 1.75 L", qty: 1, category: 'spirits' })), 37);
  eq('the label decides: a "White Wine" line that is a Blanc de Blancs Brut stays white (live, Oct 21: counted as sparkling)',
    PF.wineHeading([{ label: 'Red Wine', name: 'Josh Cabernet - 750 ML', qty: 1, category: 'wine' }, { label: 'White Wine', name: 'Chandon Blanc de Blancs Brut - 750 ML', qty: 1, category: 'wine' }]),
    'WINE — 2 bottles (1 red, 1 white)');
  eq('rosé is its own part', PF.wineHeading([{ label: 'Rosé', name: 'Whispering Angel Rosé - 750 ML', qty: 2, category: 'wine' }]), 'WINE — 2 bottles (2 rosé)');

  // ---- staff-quote ----
  eq('how much is a bartender', SQ.staffQuoteAsk('how much is a bartender?'), { word: 'bartender' });
  eq('quote with a bartender inside an event ask', SQ.staffQuoteAsk('40 guests, 3 hours, budget $2000. Please include a bartender in the quote'), { word: 'bartender' });
  eq('sommelier cost', SQ.staffQuoteAsk('what does a sommelier cost'), { word: 'sommelier' });
  eq('no price word -> not a quote ask', SQ.staffQuoteAsk('can I get a bartender for Saturday'), null);
  eq('our own bartender -> not a quote ask', SQ.staffQuoteAsk('we have our own bartender, what is the price of Titos?'), null);
  eq('reply is the Voiceflow line', SQ.reply('bartender'), 'I\'m not able to provide bartender pricing myself, but I\'ve alerted Bevvi Support and someone from the team will contact you with more information.');
  const al = SQ.alertEmail('bartender', { customerEmail: 'dipanjan@getbevvi.com', location: '332 Pine St, San Francisco, CA 94104', guests: 40, hours: 3, message: 'how much is a bartender?' });
  eq('alert: bevvi-support + the customer', al.to, ['bevvi-support@getbevvi.com', 'dipanjan@getbevvi.com']);
  eq('alert subject', al.subject, 'Bartender Quote Request: 40 guests - 332 Pine St, San Francisco, CA 94104');
  eq('alert: no customer email -> support only', SQ.alertEmail('bartender', {}).to, ['bevvi-support@getbevvi.com']);

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
