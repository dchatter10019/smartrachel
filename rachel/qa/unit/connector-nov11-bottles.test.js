// Unit tests for the Nov 11 morning connector chats (DC on Claude Code, 10165 / 10001): specific bottles with no counts were
// asked "how many guests / hours / budget?" and "how many of each? is this for an event?"; a pasted proposal got the serving-mix
// question; "8% service charge" (number first) was never read and three PDFs printed 10%. (precheck.sh runs qa/unit/*.test.js.)
const OW = require('../../order-wording.js');
const SM = require('../../serving-mix.js');
const OC = require('../../original-compare.js');
const TC = require('../../tax-command.js');
const I = require('../../instructions.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

const brands = 'I need the following\n\n* Bacardi Rum\n* Angel’s Envy Bourbon\n* Grey Goose Vodka\n* Casamigos Tequila\n* Bombay Sapphire Gin\n* Kim Crawford Sav Blanc\n* Ruffino Prosecco or Champagne\n* Modelo Beer\n* Robert Mondavi Cab Sav';
const L1 = OW.listItems(brands, { emptyBasket: true });
eq('uncounted brand list is built in code', L1 && L1.length, 9);
eq('... at 1 each, all marked uncounted', L1 && [L1.every(n => n.qty === 1), L1.uncounted], [true, 9]);
eq('"Cab Sav" / "Sav Blanc" are wines', L1 && L1.filter(n => /Cab Sav|Sav Blanc/.test(n.name)).map(n => n.category), ['wine', 'wine']);
eq('"Ruffino Prosecco or Champagne" = the first one', L1 && L1.find(n => /Ruffino/.test(n.name)).name, 'Ruffino Prosecco');

const swapNew = 'Can you swap this menu with the following items\n\n* Bacardi Rum\n* Grey Goose Vodka\n* Robert Mondavi Cab Sav is good to go';
eq('"swap this menu" on an EMPTY cart = build these', (OW.listItems(swapNew, { emptyBasket: true }) || []).map(n => n.name), ['Bacardi Rum', 'Grey Goose Vodka', 'Robert Mondavi Cab Sav']);
eq('... with a cart it stays with the LLM (a real swap)', OW.listItems(swapNew, { emptyBasket: false }), null);

const picks = 'Bacardi Gold Rum 750 mL — $19.79\nAngel’s Envy Kentucky Straight Bourbon (Port Wine Barrel Finish) 750 mL — $57.19\nModelo Especial 24 x 12 oz Bottles — $62.99\nRobert Mondavi Winery Napa Valley Cabernet Sauvignon 750 mL — $54.99';
const L2 = OW.listItems(picks, { emptyBasket: true });
eq('search-result picks (priced lines) on an empty cart are built', L2 && L2.map(n => n.name + ' [' + n.category + ']'),
  ['Bacardi Gold Rum 750ml [spirits]', 'Angel’s Envy Kentucky Straight Bourbon Port Wine Barrel Finish 750ml [spirits]', 'Modelo Especial Bottles 12oz 24-pack [beer]', 'Robert Mondavi Winery Napa Valley Cabernet Sauvignon 750ml [wine]']);
eq('... but with a cart priced picks stay with the LLM (never replace the cart)', OW.listItems(picks, { emptyBasket: false }), null);
eq('a counted list is not "uncounted"', OW.listItems('- 3 x Tito\'s 750ml\n- 2 x Grey Goose 750ml').uncounted, 0);

eq('White Rum is a spirit, not a white wine', OC.namedFromListLine('Bacardi Superior White Rum - 750 ML — $18.58').category, 'spirits');
eq('pasted basket line: prices cut, count kept', OC.namedFromListLine('2x Woodford Reserve Kentucky Straight Bourbon - 750 ML — $48.94 ea = $97.88'),
  { name: 'Woodford Reserve Kentucky Straight Bourbon 750ML', category: 'spirits', qty: 2, qty_from_customer: true });
eq('"24 x 12 OZ" is a pack, a note in brackets is not the name', OC.namedFromListLine('Modelo Especial 24 x 12 OZ — $62.99/case (This is in addition to the beers already there)').name, 'Modelo Especial 12OZ 24-pack');
eq('1L lemon juice is still an amount', OC.namedFromListLine('1L lemon juice').volume_ml, 1000);

const pasted = 'I meant with these\n\nYour proposal is ready!\nClient: iCapital\nEvent date: November 12, 2026\n2x Woodford Reserve Kentucky Straight Bourbon - 750 ML — $48.94 ea = $97.88\n2x Tito\'s Handmade Vodka - 750 ML — $24.19 ea = $48.38\n5x Marie du Lac Sancerre - 750 ML — $38.49 ea = $192.45\n1x Stella Artois 24 x 12 OZ Bottles — $62.99 ea = $62.99';
eq('a pasted proposal is a counted list (no serving-mix question)', SM.isCountedList(pasted), true);

for (const [m, want] of [['create a porposal with a 8% service charge', { service_rate: 0.08 }], ['its 8% service charge', { service_rate: 0.08 }],
  ['apply a 8% service charge', { service_rate: 0.08 }], ['12th Nov 2026, The Service charge is 8%', { service_rate: 0.08 }],
  ['add a 15% tip', { tip_rate: 0.15 }], ['$50 tip', { tip_amount: 50 }], ['8.875% tax', { tax_rate: 0.08875 }],
  ['no it doesn\'t .. I have changed the service charge before', null], ['delivery to 1460 Broadway', null]]) eq('fees ' + JSON.stringify(m), TC.fees(m), want);
eq('a pasted estimate keeps its tip as 5%, not $77.71', TC.fees('Estimated Tax (10%): $77.71\nService Charge (10%): $77.71\nTip (5%): $38.85').tip_rate, 0.05);

eq('the list heading is not a task', I.splitInstructions(brands)[0], 'Bacardi Rum');
eq('... "actutally swap with these brands" either', I.splitInstructions('actutally swap with these brands\n\n* Bacardi Rum\n* Grey Goose Vodka')[0], 'Bacardi Rum');

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('connector-nov11-bottles: all passed');
