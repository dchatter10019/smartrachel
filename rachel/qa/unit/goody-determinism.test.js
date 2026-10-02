// Unit tests on DC's real Goody thread (Oct 2): basket-hygiene.js, annotated-reply.js, original-compare.js.
// Fixture = the session's real basket, pending list, saved client and the thread's first email.
// (precheck.sh runs qa/unit/*.test.js.)
const H = require('../../basket-hygiene.js');
const A = require('../../annotated-reply.js');
const C = require('../../original-compare.js');
const fx = require('./goody-oct2.fixture.json');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

// basket-hygiene
const st = { lastLineItems: JSON.stringify(fx.items), pendingSubstitutes: fx.pending, savedClientName: fx.client, originalRequest: fx.first };
const h = H.check(st, { userName: 'Dipanjan Chatterjee' });
eq('on-hand wine dropped', h.droppedOnHand.map(d => d.name), ['La Crema Pinot Noir Willamette - 750 ML', 'The Prisoner Cabernet Sauvignon - 750 ML', 'Conundrum White - 750 ML']);
eq('14 lines left', h.items.length, 14);
eq('pending cleared by the RIGHT lines', h.pendingCleared, [
  { pending: 'Vodka 1.75L', by: 'Ketel One - 1.75 L' },
  { pending: 'Lemon Juice 1L', by: 'Master Of Mixes Single Pressed Lemon Juice 375 ML' },
  { pending: 'Simple Syrup 2L', by: 'Sonoma Classic Simple Syrup 24.5 OZ' }]);
eq('client cleaned', h.client, 'Goody');
eq('clean client unchanged', H.cleanClient('Gen II Fund', 'Sean Smith'), 'Gen II Fund');
eq('title-only signature cut', H.cleanClient('Goody CEO | Bevvi'), 'Goody');
eq('pending with no stand-in kept', H.check({ lastLineItems: '[]', pendingSubstitutes: ['Vodka 1.75L'] }).pendingCleared, []);
eq('a line answering ANOTHER item is no stand-in', H.check({ lastLineItems: JSON.stringify([{ label: 'Lime Juice 1L', name: 'Finest Call Single Pressed Lime Juice 1 Liter', qty: 1 }]), pendingSubstitutes: ['Lemon Juice 1L'] }).pendingCleared, []);

// annotated-reply
const last = "Mango puree updated to 6x — done!\n\nFor the other two, here's what I found:\n\nBUNDABERG — regular (non-diet) is available:\nBundaberg Ginger Beer 4 CT 375 ML — $7.34 (same price as the Diet). Want me to swap the Diet for the regular 4-pack, keeping 4x?\n\nSPARKLING WATER — no 24-pack available, but here are options to get to 48 cans (2x 24-packs):\nSan Pellegrino 500 ML 12-pack — $19.94 (need 4x to hit 48 units)\nSpindrift Grapefruit Sparkling Water 8pk 12 OZ — $9.44 (need 6x to hit 48 cans)\nLaCroix Sparkling Lime 8pk 12 OZ — $6.18 (need 6x to hit 48 cans)\n\nWhich sparkling water would you like, and shall I swap the Bundaberg to regular at the same time?";
const msg = 'Want me to swap the Diet for the regular 4-pack, keeping 4x? -> do you have\nany other non diet Ginger Beer the same size?\nSan Pellegrino 500 ML 12-pack — $19.94 (need 4x to hit 48 units) -> this is\ngood';
const p = A.parse(msg, last);
eq('two pairs', p.length, 2);
eq('ginger beer question is NOT an acceptance', [p[0].accept, p[0].answer], [false, 'do you have any other non diet Ginger Beer the same size?']);
eq('San Pellegrino accepted at 4x under SPARKLING WATER', [p[1].accept, p[1].qty, p[1].header], [true, 4, 'SPARKLING WATER']);
const shown = [{ name: 'San Pellegrino Plastic (PET) - 500 ML', price: 19.94, product_id: 'sp' }, { name: 'Spindrift Grapefruit Sparkling Water 8pk 12 OZ', price: 9.44, product_id: 'sd' }];
eq('product = brand + price', (A.productFor(p[1].quote, shown) || {}).product_id, 'sp');
eq('replaces the sparkling water line (Nixie)', fx.items[A.lineForHeader(p[1].header, fx.items)].name, 'Nixie Wtrmln Mint Sparkling Water - 12 OZ');
eq('a plain "A -> B" not quoting the reply is not a pair', A.parse('Remy Cointreau -> Cointreau 750 ML', last), []);
eq('"-&gt;" (Slack) works', A.parse('San Pellegrino 500 ML 12-pack — $19.94 (need 4x to hit 48 units) -&gt; yes', last).map(x => x.accept), [true]);
eq('"yes but 2" is not a bare acceptance', A.parse('San Pellegrino 500 ML 12-pack — $19.94 (need 4x to hit 48 units) -> yes but only 2 of them and a lime one too please', last).map(x => x.accept), [false]);

// original-compare
const cmp = C.compare(fx.first, h.items, h.onHand);
const by = t => (cmp.rows.find(r => r.asked.indexOf(t) >= 0) || {}).status;
eq('vodka matches (Ketel One)', by('vodka'), 'ok');
eq('lemon juice 3x375 mL covers 1 L', by('lemon juice'), 'ok');
eq('simple syrup 3x24.5 oz covers 2 L', by('simple syrup'), 'ok');
eq('sparkling water: Nixie "- 12 OZ" gives no pack size -> unclear, never guessed', by('sparkling water'), 'unclear');
eq('a 4pk line counts its pack (16 units = 4 x 4-packs)', by('Bundaberg'), 'ok');
const rep = C.reply(cmp, h.onHand);
eq('the only fix offered: FIJI 12 -> 24 (no fix for an unclear pack)', rep.fixes, [{ name: 'FIJI Natural Artesian Bottled Water 16.9 OZ Btl', from: 12, to: 24 }]);
eq('reply lists the on-hand stock as not ordered', /Not ordered — you already have: 2x La Crema/.test(rep.text), true);
eq('DC\'s compare asks are compare asks', ['Can you take my original request any this proposal and see if they are the\nsame.. if not show me the changes that we need to make', 'can you check and see if this menu mathces my original request'].map(C.isCompareAsk), [true, true]);
eq('an add is not a compare ask', C.isCompareAsk('add 2 vodka to my original request'), false);
eq('apply asks', ['Please make the changes as you recommended', 'yes', 'go ahead'].map(C.isApplyAsk), [true, true, true]);
eq('not apply asks', ['yes but not the water', 'I am good with your recommendations.. let create a proposal with these'].map(C.isApplyAsk), [false, false]);
eq('a case of water = 24; 12 FIJI is SHORT', by('bottled water'), 'short');
eq('Athletic N/A matches', by('Athletic'), 'ok');
eq('on-hand wine not compared', cmp.rows.some(r => /crema|prisoner|conundrum/i.test(r.asked)), false);
eq('Fever Tree (the "or" option, also in) + San Pellegrino are extra', cmp.extra, ['3x Fever Tree Ginger Beer - 6.8 OZ', '1x San Pellegrino Plastic (PET) - 500 ML']);

// Oct 2 replay: San Pellegrino (4x) replaced Nixie; FIJI must answer ONLY "1 case bottled water" — one fix, 12 -> 24
for (const label of ['Sparkling Water 24-pack', 'San Pellegrino 500 ML 12 - 500 ML']) {
  const its = h.items.map(x => x.name.startsWith('Nixie') ? { label, name: 'San Pellegrino Plastic (PET) - 500 ML', qty: 4, price: 19.94 } : x);
  const c2 = C.compare(fx.first, its, h.onHand);
  eq('one-to-one (' + label + '): only fix is FIJI 12 -> 24', C.reply(c2, h.onHand).fixes, [{ name: 'FIJI Natural Artesian Bottled Water 16.9 OZ Btl', from: 12, to: 24 }]);
}
// Oct 2, 03:05: DC's notes on his own request lines (answers wrapped onto the next line)
const IN = require('../../instructions.js');
const notesMsg = '• 4 × 4-packs Bundaberg ginger beer (or 1 × 12-pack Fever-Tree) ->\nBundaberg ginger beer or Fever-Tree not both\n• 1L lime juice + 1L lemon juice (unsweetened)\n• 2L simple syrup\n• 3L mango purée\n• 2 × 24-packs sparkling water -> Nixie Wtrmln Mint Sparkling Water - 12 OZ\ndoesn;t look rith\n• 1 × 12-pack Athletic N/A beer\n• 1 case bottled water -> San Pellegrino Plastic (PET) - 500 ML doesn\'t\nlook right';
eq('wrapped answers join their line (no "doesn;t look rith" instruction)', IN.splitInstructions(notesMsg).some(l => /^doesn|^look right/.test(l)), false);
eq('a verdict is never a swap', IN.arrowSwaps(notesMsg), []);
const ns = C.requestNotes(notesMsg, fx.first, h.onHand);
eq('three notes: not both, wrong, wrong', ns.map(x => x.kind), ['not_both', 'wrong', 'wrong']);
const nb = C.applyNotBoth(h.items, ns[0]);
eq('not both: Fever Tree removed, Bundaberg kept', [nb.removed, nb.items.some(x => /Bundaberg/.test(x.name))], [['3x Fever Tree Ginger Beer - 6.8 OZ'], true]);
eq('a note on a line that is not in the request is ignored', C.requestNotes('• 2 cases Corona -> not both', fx.first, h.onHand), []);
// Oct 2 first build: the LLM's named_products vs DC's own lines
const nps = [{ name: 'Vodka 1.75L', qty: 2 }, { name: 'Lime Juice 1L', qty: 1 }, { name: 'Lemon Juice 1L', qty: 1 }, { name: 'Simple Syrup 2L', qty: 1 },
  { name: 'Mango Puree', qty: 3 }, { name: 'Sparkling Water 24-pack', qty: 2 }, { name: 'Bottled Water case', qty: 1 }, { name: 'Tequila Blanco 1.75L', qty: 2 }];
C.reconcileNamed(nps, fx.first);
const pick = n => nps.find(x => x.name.startsWith(n));
eq('"3L mango purée" is 3000 mL, not 3 bottles', [pick('Mango').volume_ml, pick('Mango').qty], [3000, 1]);
eq('"1L lemon juice" is an amount: any bottle size', [pick('Lemon Juice').name, pick('Lemon Juice').volume_ml], ['Lemon Juice', 1000]);
eq('"2L simple syrup" -> 2000 mL', pick('Simple Syrup').volume_ml, 2000);
eq('a counted line keeps its count (vodka 2)', [pick('Vodka').qty, pick('Vodka').volume_ml], [2, undefined]);
eq('the LLM\'s wrong count is corrected (tequila 2 -> 3)', pick('Tequila').qty, 3);
eq('packs are not volumes (sparkling water 2 x 24-packs)', [pick('Sparkling').qty, pick('Sparkling').volume_ml], [2, undefined]);
eq('a case is not a volume', pick('Bottled Water').volume_ml, undefined);
const nps2 = nps.filter(x => !x.name.startsWith('Mango'));
const lg = C.reconcileNamed(nps2, fx.first);
eq('a line the LLM left out is added (mango 3 L)', (nps2.find(x => /mango/i.test(x.name)) || {}).volume_ml, 3000);
eq('on-hand lines are never added', nps2.some(x => /crema|prisoner|conundrum|high noon|modelo/i.test(x.name)), false);
// Oct 2, 05:43: DC's change email — 4 requests, only one was parsed and the reply said "Done"
const QE = require('../../quote-edits.js');
const chg = 'Couple of changes / questions:\n\n   - can we swap the ketel one for titos?\n      - we have some leftover titos on hand so it may make sense to have\n      the same brand\n   - remove the water case\n   - remove the sparkling water (we should have enough on hand!)\n   - can we add back some wine?\n      - 4 red\n      - 4 white';
const qe = QE.parseEdits(chg);
eq('both removes parsed (per line, not run together)', qe.removes, ['water case', 'sparkling water']);
eq('the add and the swap are seen (they go to the LLM)', [qe.adds, qe.swaps], [true, true]);
const live = [{ name: 'FIJI Natural Artesian Bottled Water 16.9 OZ Btl', label: 'Bottled Water case', qty: 12, price: 3.14 }, { name: 'San Pellegrino Plastic (PET) - 500 ML', label: 'San Pellegrino 500 ML 12 - 500 ML', qty: 4, price: 19.94 }, { name: 'Ketel One - 1.75 L', qty: 2, price: 44.09 }];
const ap = QE.applyEdits(live, qe);
eq('"sparkling water" = San Pellegrino, "water case" = FIJI', ap.changes.map(c => c.name).sort(), ['FIJI Natural Artesian Bottled Water 16.9 OZ Btl', 'San Pellegrino Plastic (PET) - 500 ML']);
eq('heading and reason lines are not instructions', IN.splitInstructions(chg).some(l => /^Couple|leftover titos/.test(l)), false);

// Oct 2, 13:08-13:30: the change email wiped the quote; the wine he approved was dropped as on-hand; picks went in at 1x
const BM = require('../../basket-merge.js');
const quote = [{ name: 'Don Julio Blanco Tequila - 1.75 L', qty: 3, price: 137.01 }, { name: 'Flatboat Bourbon - 1.75 L', qty: 3, price: 52.49 }, { name: 'Ketel One - 1.75 L', qty: 2, price: 44.09 }, { name: 'Cointreau - 750 ML', qty: 1, price: 62.99 }, { name: 'Simply Squeeze Mango Puree 16.9 OZ', qty: 6, price: 9.12 }];
const build = [{ name: 'Troublemaker Red Wine - 750 ML', qty: 4, price: 22 }, { name: 'Conundrum White - 750 ML', qty: 4, price: 17.84 }, { name: "Tito's Handmade Vodka - 1.75 L", qty: 1, price: 37.79 }];
const mg = BM.mergeEdit(quote, build, chg);
eq('an add on an edit turn MERGES into the quote (nothing lost)', mg.items.map(i => i.qty + 'x ' + i.name), ['3x Don Julio Blanco Tequila - 1.75 L', '3x Flatboat Bourbon - 1.75 L', '1x Cointreau - 750 ML', '6x Simply Squeeze Mango Puree 16.9 OZ', '4x Troublemaker Red Wine - 750 ML', '4x Conundrum White - 750 ML', "2x Tito's Handmade Vodka - 1.75 L"]);
eq('a new list / start over is not an edit (the build replaces)', [BM.mergeEdit(quote, build, 'start over: 4 red, 4 white'), BM.mergeEdit(quote, build, 'Hi, here is my list\n4 red\n4 white')], [null, null]);
const npsC = [{ name: 'red wine', category: 'wine', qty: 4 }, { name: 'white wine', category: 'wine', qty: 4 }];
C.reconcileNamed(npsC, chg);
eq('instruction / question lines are never added as products', npsC.map(n => n.name), ['red wine', 'white wine']);
const OH = require('../../on-hand.js');
const ohG = [{ name: 'La Crema pinot noir' }, { name: 'the prisoner' }, { name: 'conundrum white' }];
eq('an on-hand product the customer chose later is released', [OH.releasedBy("4x Conundrum White - 750 ML — $17.84 ea = $71.36 -> This is good\n1x Owen's Transfusion -> Remove this", ohG), OH.releasedBy('so 4 The Prisoner Red Blend 750 ML — $53.54', ohG)], [['conundrum white'], ['the prisoner']]);
eq('"remove" / "we have" never release', [OH.releasedBy('remove the conundrum white', ohG), OH.releasedBy('we have 2 bottles of conundrum white already', ohG)], [[], []]);
const stR = { lastLineItems: JSON.stringify([{ name: 'The Prisoner Red Blend - 750 ML', qty: 4, price: 53.54 }, { name: 'Conundrum White - 750 ML', qty: 4, price: 17.84 }]), onHand: ohG, onHandReleased: ['the prisoner', 'conundrum white'] };
eq('hygiene keeps released on-hand lines', H.check(stR, {}).droppedOnHand, []);
eq('line notes: remove / qty / keep / a swap is not one', ['Remove this', 'Make this 2 bottles', 'This is good', 'switch to a Prisoner Red'].map(A.lineAction), [{ remove: true }, { qty: 2 }, { keep: true }, null]);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
