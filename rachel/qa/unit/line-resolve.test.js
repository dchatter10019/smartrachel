// Unit tests for line-resolve.js — linking a hand-built quote's lines to catalog products (exact matches only).
// Real case (Sep 29): the Gen II basket loaded from its PDF had names and prices but no product ids.
const LR = require('../../line-resolve.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const P = (name, price, id) => ({ name, price, product_id: id, upc: 'u' + id, establishmentId: 'est' });
const pick = (it, c) => { const r = LR.choose(it, c); return r.pick ? r.pick.product_id : null; };

eq('needsLink: bare line', LR.needsLink({ name: 'x', price: 1 }), true);
eq('needsLink: linked line', LR.needsLink({ name: 'x', product_id: 'p', establishmentId: 'e' }), false);
eq('size words are not name words (8x11.5)', pick({ name: 'Crook & Marker Lime Margarita 8x11.5 oz Cans *', price: 18.99 },
  [P('Crook & Marker Zero Sameness Prpl 8x11 OZ Can', 18.49, 'z'), P('Crook & Marker Lime Margarita 8pk 11.5 OZ Can 5.0% ABV', 18.99, 'lime')]), 'lime');
eq('"Cider" missing from the catalog name', pick({ name: 'Downeast Tropical Mix Cider 9x12 oz Cans *', price: 19.99 }, [P('Downeast Tropical Mix 9x12 OZ Can', 19.99, 'dt')]), 'dt');
eq('same name, different pack/price -> the one at the quoted price', pick({ name: 'Downeast Original Blend Cider 4x12 oz Cans', price: 12.99 },
  [P('Downeast Original Blend 9x12 OZ Can', 19.99, 'nine'), P('Downeast Original Blend 4x12 OZ Can', 12.99, 'four')]), 'four');
const moved = LR.choose({ name: 'Michelob ULTRA Light Lager 30x12 oz Cans', price: 32.99 }, [P('Michelob ULTRA Light Lager 30x12 OZ Can', 34.99, 'm')]);
eq('price changed since the quote -> not linked, says so', [moved.pick, /now \$34\.99/.test(moved.reason)], [null, true]);
eq('same price, different product -> not linked', pick({ name: 'High Noon Variety Pool Pack 8x12 oz Cans', price: 22.99 }, [P('High Noon Hard Seltzer OG VP - 12 OZ', 22.99, 'og')]), null);
eq('nothing found -> not linked', LR.choose({ name: 'Unobtainium Ale', price: 9 }, []).reason, "not found in this store's catalog");
eq('nameOnly strips sizes', LR.nameOnly('High Noon Variety Pool Pack 8x12 oz Cans'), 'High Noon Variety Pool Pack');
(async () => {
  const r = await LR.resolveLines([{ name: 'Baileys Irish Cream', price: 54.99, qty: 1 }, { name: 'Linked', product_id: 'p', establishmentId: 'e', price: 1 }],
    async () => [P('Baileys Irish Cream - 1.75 L', 54.99, 'b')], () => {});
  eq('resolveLines links, keeps qty, leaves linked lines alone', [r.items[0].product_id, r.items[0].qty, r.items[1].product_id, r.linked.length, r.unresolved.length], ['b', 1, 'p', 1, 0]);
  console.log(failed ? '\nline-resolve: ' + failed + ' FAILED' : '\nline-resolve: all passed');
  if (failed) process.exit(1);
})();
