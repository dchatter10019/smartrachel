// Unit tests for list-reply.js on real LLM replies from the Sep 29 smoke runs: the shopping-list reply is
// composed in code (basket lines + product total), a generic item's option list is kept, a named
// unavailable product's size list is dropped. (precheck.sh runs qa/unit/*.test.js.)
const { compose, pickBlocks, isNamed } = require('../../list-reply.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const has = (label, text, s) => eq(label, text.includes(s), true);
const hasnt = (label, text, s) => eq(label, text.includes(s), false);

console.log('isNamed');
eq('Grey Goose Vodka 3.5 L', isNamed('Grey Goose Vodka 3.5 L'), true);
eq('Dry Rosé 750 mL', isNamed('Dry Rosé 750 mL'), false);
eq('Sauvignon Blanc or Pinot Grigio', isNamed('Sauvignon Blanc or Pinot Grigio'), false);
eq('St-Germain Elderflower Liqueur', isNamed('St-Germain Elderflower Liqueur'), true);

console.log('shopping-list (rosé options asked, no totals in the LLM reply)');
{
  const llm = "Here's what I found for everything. Four items came back perfectly \u2014 just need you to pick a ros\u00e9. Here's the full rundown:\n\n---\n\n*SPIRITS \u2014 4 bottles*\n\n*Belvedere Organic Vodka* \u2014 750 mL \u2014 $36.29 ea \u00d7 3 = $108.87\n*St Germain Elderflower Liqueur* \u2014 750 mL \u2014 $38.49 ea \u00d7 1 = $38.49\n\n*WINE \u2014 8 bottles*\n\nWhite:\n*Cloudy Bay Sauvignon Blanc* \u2014 750 mL \u2014 $37.39 ea \u00d7 5 = $186.95\n\nRed:\n*Joseph Phelps Freestone Pinot Noir* \u2014 750 mL \u2014 $71.49 ea \u00d7 3 = $214.47\n\n---\n\nFor the *2 bottles dry ros\u00e9*, I have these 750 mL options:\n\n1. *Whispering Angel Ros\u00e9* \u2014 750 mL \u2014 $24.19\n2. *The Beach Ros\u00e9* \u2014 750 mL \u2014 $20.89\n3. *Domaines Ott By Ott Ros\u00e9* \u2014 750 mL \u2014 $60.49\n4. *Nicolas Feuillatte Brut Ros\u00e9* *(Champagne)* \u2014 750 mL \u2014 $83.59\n\nOptions 1 and 2 are classic Provence-style dry ros\u00e9s. Option 3 is also Provence, a step up. Option 4 is a sparkling ros\u00e9 Champagne \u2014 a different style, just flagging it.\n\nWhich would you like for the ros\u00e9?";
  const items = [
    { name: 'Belvedere Organic Vodka - 750 ML', price: 36.29, qty: 3 },
    { name: 'St Germain Elderflower Liqueur 750ml (40 proof)', price: 38.49, qty: 1 },
    { name: 'Cloudy Bay Sauvignon Blanc White Wine - 750 ML', price: 37.39, qty: 5 },
    { name: 'Joseph Phelps Freestone Pinot Noir - 750 ML', price: 71.49, qty: 3 }];
  const r = compose({ items, unmatched: ['Dry Rosé 750 mL'], llmText: llm });
  for (const s of ['3x Belvedere', '1x St Germain', '5x Cloudy Bay', '3x Joseph Phelps', 'Product total: $548.78', '1. *Whispering Angel', '4. *Nicolas Feuillatte', 'For the *2 bottles dry rosé*']) has('has ' + s, r.text, s);
  hasnt('no "couldn\'t find" for the rosé (its options are shown)', r.text, 'couldn\'t find');
  eq('ends with one question', /Which one would you like\?$/.test(r.text), true);
  eq('one option list kept', r.blocks.length, 1);
}

console.log('cta-sub-named (Grey Goose 3.5 L unavailable; LLM listed its sizes)');
{
  const llm = "Here's what I found:\n\n*Grey Goose Vodka 3.5 L* isn't available at this location. The largest size in stock is the *Grey Goose Vodka 1.75 L* at $54.40 each. Here are the available Grey Goose sizes:\n\n1. *Grey Goose Vodka \u2014 1.75 L* \u2014 $54.40 ea\n2. *Grey Goose Vodka \u2014 750 mL* \u2014 $35.20 ea\n3. *Grey Goose Vodka \u2014 375 mL* \u2014 $19.79 ea\n\n*Tito's Handmade Vodka \u2014 750 mL* \u2014 $24.19 ea \u2705 (3 bottles confirmed)\n\nWould you like to swap the Grey Goose 3.5 L for one of the sizes above? If so, which size and how many bottles would you like?";
  const r = compose({ items: [{ name: "Tito's Handmade Vodka - 750 ML", price: 24.19, qty: 3 }], unmatched: ['Grey Goose Vodka 3.5 L'], llmText: llm });
  has('Tito\'s line', r.text, "3x Tito's Handmade Vodka - 750 ML — $24.19 ea = $72.57");
  has('named unavailable line', r.text, "Grey Goose Vodka 3.5 L isn't available at this store.");
  hasnt('size list dropped', r.text, '1.75 L* — $54.40');
  eq('no question (the CTA offers the substitute)', /\?\s*$/.test(r.text), false);
  eq('named first', r.named, ['Grey Goose Vodka 3.5 L']);
}

console.log('everything matched');
{
  const r = compose({ items: [{ name: 'A - 750 ML', price: 10, qty: 2 }], unmatched: [], llmText: 'Here you go! Would you like to place the order?' });
  eq('text', r.text, "Here's your list:\n\n2x A - 750 ML — $10.00 ea = $20.00\n\nProduct total: $20.00");
}
console.log('generic unmatched with no options');
{
  const r = compose({ items: [{ name: 'A - 750 ML', price: 10, qty: 1 }], unmatched: ['2 bottles dry riesling'], llmText: 'no luck' });
  has('couldn\'t find', r.text, "I couldn't find a match for dry riesling at this store.");
}
console.log('pickBlocks ignores unpriced numbered steps');
eq('no blocks', pickBlocks('1. Pick a size\n2. Tell me how many').length, 0);

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
