// Unit tests for the Nov 13 email + connector review (DC forwarding Eterra Kitchen's orders by email; DC on Claude Code
// with the KPMG and Sancerre/Bordeaux proposals; Sean's Sancerre / Saint-Emilion email). (precheck.sh runs qa/unit/*.test.js.)
const PO = require('../../proposal-options.js');
const PE = require('../../proposal-edits.js');
const BP = require('../../bottle-price.js');
const RQ = require('../../request-qty.js');
const EB = require('../../email-body.js');
const AX = require('../../address-extract.js');
const ED = require('../../event-date.js');
const ES = require('../../email-subject.js');
const SM = require('../../serving-mix.js');
const QE = require('../../quote-edits.js');
const IN = require('../../instructions.js');
const DT = require('../../drink-type.js');
const CP = require('../../customer-prefs.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

console.log('options in the proposal');
eq('"Do not show any options ever" drops them', [PO.wantsOptions('Do not show any options ever in a proposal.'), PO.dropsOptions('Do not show any options ever in a proposal.')], [false, true]);
eq('"take out the alternatives" drops them', PO.dropsOptions('take out the alternatives'), true);
eq('"sounds good with the choices" is no options ask', PO.wantsOptions('Yes sounds good with the choices and create a proposal'), false);
eq('"options around $30 per bottle" is no options ask', PO.wantsOptions('Replace the champagne with options around $30 per bottle, then regenerate the KPMG proposal.'), false);
eq('"include the ... options separately" still asks', PO.wantsOptions('send a pdf proposal and include the various prosecco, sauv blanc, and rose options separately'), true);
eq('"only the 5 items ... no options" drops them', PO.dropsOptions('Regenerate the proposal PDF with only the 5 items in the basket. Do not include any options or alternatives.'), true);
eq('"options ever" is a lasting preference', CP.extract('Do not show any options ever in a proposal. Just show me a proposal').length, 1);
eq('quote-edits never removes a line called "alternatives"', QE.parseEdits('take out the alternatives').count, 0);

console.log('proposal ask with basket changes');
eq('KPMG change + regenerate = edits', PE.editsIn('Change Corona Light to 1 case and Blue Moon to 1 case. Replace the champagne, Cabernet and Chardonnay with options around $30 per bottle, 2 bottles of each, then regenerate the KPMG proposal.').length, 2);
eq('a plain proposal ask has no edits', PE.editsIn('Regenerate the pdf proposal'), []);
eq('a client change is not a basket edit', PE.editsIn('Change the name of the client to KPMG'), []);
eq('a fee in the ask is not a basket edit', PE.editsIn('create a proposal with a 8% service charge'), []);
eq('instructions are not a basket edit', PE.editsIn('change the delivery instructions to ring the bell'), []);
eq('yes to "Shall I go with ...?" accepts the offer', PE.acceptsOffer('Yes sounds good with the choices and create a proposal', 'Shall I go with Kendall-Jackson for the Sauvignon Blanc and Underwood for the Pinot Noir, or would you prefer a different option?'), true);
eq('yes to "want a PDF?" is not a swap', PE.acceptsOffer('yes', 'Want me to put together a PDF proposal?'), false);

console.log('per-bottle price');
eq('"average price ... is $15" (wrapped)', (BP.read('Also the average price\nof the wine bottles is $15') || {}).max, 15);
eq('"should not exceed $15 for wine" is a cap', BP.read('The bottles should not exceed $15 for wine'), { category: 'wine', max: 15, min: 0, said: 'The bottles should not exceed $15 for wine' });
eq('"prices do not exceed $15?"', (BP.read('Can you ensure the prices do not exceed $15?') || {}).max, 15);
eq('a total budget is not a bottle price', BP.read('Budget is $1500 total for 40 guests'), null);
eq('a per-person price is not a bottle price', BP.read('price is $35 per person'), null);
eq('a pasted basket line is not a bottle price', BP.read('24x Ruffino Prosecco - 750 ML — $14.96 ea = $359.04'), null);
eq('Tito\'s under $25 = spirits', (BP.read("I need 3 bottles of Tito's under $25") || {}).category, 'spirits');

console.log('counts from a generic request line');
const sb = "Please search for what's in stock for delivery to 1076 Madison Ave, New York, NY 10028 on Sunday 11/15 between 9 AM and 12 PM: (1) Sancerre, 750 ML bottles, need 15 bottles; (2) Bordeaux red, 750 ML bottles, need 12 bottles. Please list the available options with prices and stock quantities.";
eq('Sancerre pick = 15', (RQ.genericLineFor(sb, 'Patient Cottat Anciennes Vignes Sancerre - 2017 - 750 ML') || {}).qty, 15);
eq('Bordeaux pick = 12', (RQ.genericLineFor(sb, 'Château Malvat Bordeaux - 750 ML') || {}).qty, 12);
eq('a prosecco is neither', RQ.genericLineFor(sb, 'Ruffino Prosecco'), null);
eq('"Pinot Noir – 15 bottles"', (RQ.genericLineFor('Prosecco – 24 bottles\n\nPinot Noir – 15 bottles', 'Underwood Pinot Noir - 750 ML') || {}).qty, 15);

console.log('email bodies, addresses, dates, client');
const fwdRachel = 'Price of wine cannot exceed $15\n\n---------- Forwarded message ---------\nFrom: Rachel AI <rachelai@getbevvi.com>\nDate: Sat, Nov 14, 2026 at 4:44 AM\nSubject: Re: x\n\nHi Dipanjan,\n\nYour proposal is ready!\nClient: Dipanjan Chatterjee\nOptions listed in the PDF: Prosecco (1)';
eq('a forwarded copy of Rachel\'s own email is cut', EB.latest(fwdRachel).text, 'Price of wine cannot exceed $15');
const fwdCust = 'Can you provide me with a proposal?\n\n---------- Forwarded message ---------\nFrom: E <e@eterrakitchen.com>\nDate: Sat, Nov 14, 2026\n\nHello';
eq('a forwarded customer email is kept', EB.latest(fwdCust).forwarded, true);
const parkAve = 'Hi,\n\n*Delivery Address:*\n1580 Park Avenue\n<https://www.google.com/maps/search/1580+Park+Avenue?entry=gmail&source=g>\nKitchen 3\nNew York, NY 10029\n\n*Order Details:*';
eq('maps link + "Kitchen 3" line', AX.findAddress(parkAve), '1580 Park Avenue, Kitchen 3, New York, NY 10029');
eq('a wrapped street number still joins', AX.findAddress('Deliver to 100\nFederal Street, Boston, MA 02110'), '100 Federal Street, Boston, MA 02110');
eq('address block: label, venue line and links go', AX.cleanTyped('*Delivery Address:*\nHI USA NYC Hostel – Penthouse\n891 Amsterdam Ave\n<https://www.google.com/maps/search/891>\nNew York, NY\n<https://www.google.com/maps/x>', { fromStreet: true }), '891 Amsterdam Ave\nNew York, NY');
const now = new Date(2026, 10, 13);
eq('the forward\'s Date: header is not the event', ED.findEventDateIn('Hi\n\n---------- Forwarded message ---------\nFrom: E <e@x.com>\nDate: Sat, Nov 14, 2026 at 2:09 AM\nSubject: New Beverage Order – November 17\n\nWe would like to submit a new beverage order for delivery on *Tuesday,\nNovember 17.*', now), 'November 17, 2026');
eq('"the requested delivery date is Thursday, November 19th"', ED.findEventDateIn('Date: Sat, Nov 14, 2026 at 1:52 AM\n\nI forgot to mention that the requested\ndelivery date is* Thursday, November 19th*', now), 'November 19, 2026');
eq('"This Sunday" is a date', ED.normalizeEventDate('This Sunday', now).text, 'November 15, 2026');
eq('"next Friday" on a Friday = a week out', ED.normalizeEventDate('next Friday', now).text, 'November 20, 2026');
eq('"tomorrow"', ED.normalizeEventDate('tomorrow', now).text, 'November 14, 2026');
eq('"None" stays none', ED.normalizeEventDate('None', now).date, false);
const sig = 'Hi\n\n---------- Forwarded message ---------\nFrom: Esthefany Fernandez <esthefany@eterrakitchen.com>\n\nBest Regards,\n*Esthefany Fernandez*\n*Maiden Voyage Catering <https://www.maidenvoyagecatering.com/>*\n*Eterra Kitchen <https://www.eterrakitchen.com/>*';
eq('client = the forwarded sender\'s company', ES.clientFromForward(sig), 'Eterra Kitchen');
eq('free mail names no company', ES.clientFromForward('From: Bob <bob@gmail.com>\nBob'), '');

console.log('lists, stand-in types, instructions');
const kpmg = 'Please build it with exactly these items: 2 x Veuve Clicquot Vintage Brut 750 ML; 2 x Joseph Phelps Napa Valley Cabernet Sauvignon 750 ML; 2 x Kistler Sonoma Mountain Chardonnay 750 ML; 2 x Corona Light Mexican Lager 24 x 12 OZ Cans; and 1 case of Blue Moon Belgian White cans. 40 guests, 1 hour.';
eq('an inline ";" list is a counted list (no mix question)', SM.isCountedList(kpmg), true);
eq('an event brief with ";" is not', SM.isCountedList('wine and beer for 40 guests; 2 hours; budget $500'), false);
eq('Sancerre is white, its stand-in search "sancerre"', [DT.typeOf({ name: 'Nicolas Idiart Sancerre' }), DT.styleWordOf({ name: 'Nicolas Idiart Sancerre' })], ['white', 'sancerre']);
eq('Saint Emillion Bordeaux is red, not the Riesling', [DT.typeOf({ name: 'Chateau Lamour Saint Emillion Grand Cru Bordeaux' }), DT.typeOf({ name: 'Chateau Ste. Michelle Riesling - 750 ML' })], ['red', 'white']);
eq('Nicolas Feuillatte is sparkling', DT.typeOf({ name: 'Nicolas Feuillatte Réserve Exclusive Brut Champagne - 750 ML' }), 'sparkling');
eq('Rachel\'s own "I haven\'t done these yet" pasted back is no task', IN.splitInstructions('Yes Do these\n\nI haven\'t done these yet:\n• Average price of $15\n• Phone: 929-278-4626\nWant me to go ahead with both?'), []);
eq('contact / phone / price lines are facts', IN.unaddressed(['Average price of $15', 'Delivery Contact: Stephani Alvarez', 'Phone: 929-278-4626'], 'Here is your proposal', [], []), []);

console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
