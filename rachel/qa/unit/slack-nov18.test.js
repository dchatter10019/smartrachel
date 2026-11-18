// Nov 18 (DC on Slack, Foodie For All, 140 guests / 2 h, 300 Park Ave): the readers behind each miss.
const TAX = require('../../tax-command.js');
const ED = require('../../event-date.js');
const MP = require('../../multipick.js');
const CTA = require('../../cta.js');
const WC = require('../../wine-coverage.js');
const BO = require('../../bottle-only.js');
let failed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want), ok = g === w; if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '  got ' + g + ', want ' + w));
}
// fees: "delivery as free" + "tip to be $50" — delivery was read as $50
eq('free delivery + $50 tip', TAX.fees('Change the service charge to 8 pct and make the delivery as free and make the tip to be $50'), { service_rate: 0.08, tip_amount: 50, delivery_fee: 0 });
eq('delivery to be free', TAX.fees('Make the delivery to be free'), { delivery_fee: 0 });
eq('delivery to 1460 Broadway is an address', TAX.fees('delivery to 1460 Broadway'), null);
// event date "Thursday 19th" was printed as is
const now = new Date(2026, 10, 18);
eq('Thursday 19th', ED.normalizeEventDate('Thursday 19th', now).text, 'November 19, 2026');
eq('the 19th', ED.normalizeEventDate('the 19th', now).text, 'November 19, 2026');
eq('a bare number is not a date', ED.normalizeEventDate('19', now).date, false);
// Hendrick's
const r1 = 'Options:\n\n1. *Hendrick\'s Gin* — 1 L — $53.67\n2. *The Botanist Islay Dry Gin* — 1 L — $47.29\n3. *Bombay Sapphire London Dry Gin* — 1 L — $41.78\n\nWhich one would you like?';
const r2 = 'Two Hendrick\'s options in 750 mL:\n\n1. *Hendrick\'s Another Gin* — 750 mL — $47.29\n2. *Hendrick\'s Gin* — 750 mL — $42.89\n\nWhich one would you like to swap in for the Monkey 47?';
eq('"Hendricks" = the listed Hendrick\'s', MP.matchListedByName('Hendricks', [r1]).matches.map(o => o.name), ["Hendrick's Gin"]);
eq('"the regular Hendrick’s gin" = the plain one', MP.matchListedByName('regular Hendrick’s gin', [r2]).matches.map(o => o.name), ["Hendrick's Gin"]);
// CTA: "Ok <request>" is the request
eq('"Ok find any other gin" is not a yes', CTA.accepted('basket.offer_order_or_proposal', 'Ok find any other gin'), false);
eq('"ok" is a yes', CTA.accepted('basket.offer_order_or_proposal', 'ok'), true);
eq('"ok place it" is a yes', CTA.accepted('basket.offer_order_or_proposal', 'ok place it'), true);
// sparkling out of an event package -> the wine kept covers it
const kept = [{ name: 'Ventisquero Enclave Cabernet Sauvignon - 750 ML', qty: 7 }, { name: 'Château Gloria Saint-Julien - 750 ML', qty: 7 },
  { name: 'Louis Jadot Pouilly-Fuissé Premier Cru - 750 ML', qty: 4 }, { name: 'Louis Jadot Chablis - 2018 - 750 ML', qty: 4 }, { name: 'Stella Artois 24 x 12 OZ Bottles', qty: 4 }];
const gone = [{ name: 'Chandon California Brut - 1.5 L', qty: 2 }, { name: 'Nicolas Feuillatte Réserve Exclusive Brut Rosé Champagne - 750 ML', qty: 2 }];
const wc = WC.rebalance(kept, gone, { guests: 140 });
eq('4.5 L of sparkling = 6 more bottles of red/white', wc && wc.bottles, 6);
eq('beer untouched', wc && wc.items[4].qty, 4);
eq('no event = no rebalance', WC.rebalance(kept, gone, {}), null);
eq('one red of two removed = the customer cutting back', WC.rebalance(kept, [{ name: 'Other Cabernet Sauvignon - 750 ML', qty: 3 }], { guests: 140 }), null);
eq('no sparkling words', WC.noWineTypesIn("I don't need sparkling only red  and white wines"), ['sparkling', 'rose']);
// "use only 750 ml bottles"
eq('size rule', BO.exactSizeIn('Use only 750 ml bottles… use high west for bourbon'), 750);
eq('the rest of the message', BO.remainderOf('Use only 750 ml bottles… use high west for bourbon'), 'use high west for bourbon');
eq('a floor is not this rule', BO.exactSizeIn('only 750 mL or larger'), 0);
eq('a counted line is not this rule', BO.exactSizeIn('I need 3 x 750ml Titos'), 0);
eq('same product in 750', (BO.sameInSize('Belvedere Organic Vodka - 1.75 L', [{ name: 'Belvedere Vodka - 750 ML' }, { name: 'Belvedere Organic Vodka - 750 ML' }], 750) || {}).name, 'Belvedere Organic Vodka - 750 ML');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
