// edit-reader.js: the gate and the code's checks on the model's reading (no model call). Nov 14, DC's email thread.
const ER = require('../../edit-reader.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const basket = [{ name: 'Cloudy Bay Sauvignon Blanc - 750 ML', qty: 12, price: 37.39 }, { name: 'Chateau Lamour Saint Emilion Grand Cru - 750 ML', qty: 9, price: 21.99 }];
const offer = 'Want me to swap the Cloudy Bay out for the Nicolas Idiart Sancerre and regenerate the proposal?';
ok('gate: a yes to an offered swap', ER.wants('Yes do that.. and also provide a free delivery', { basket, lastReply: offer }));
ok('gate: "take out X and regenerate"', ER.wants('Take out the cloudy bay and regenerate the proposal.', { basket, lastReply: '' }));
ok('gate: no basket = no call', !ER.wants('take out the cloudy bay', { basket: [], lastReply: '' }));
ok('gate: a bare pick stays with the pick paths', !ER.wants('1, 4, 7', { basket, lastReply: offer }) && !ER.wants('2', { basket, lastReply: offer }));
ok('gate: a plain yes with no offered change', !ER.wants('yes', { basket, lastReply: 'Shall I place the order?' }));
const shown = [{ name: 'Nicolas Idiart Sancerre Blanc - 750 ML', price: 32.99 }];
const v1 = ER.validate({ ops: [{ op: 'replace', line: 1, product: 1 }], shown }, basket);
ok('replace L1 with P1: valid, line = Cloudy Bay, product = Sancerre', v1.ok && v1.ops[0].item.name.startsWith('Cloudy Bay') && v1.ops[0].product.name.startsWith('Nicolas'));
ok('a line that does not exist: rejected', !ER.validate({ ops: [{ op: 'remove', line: 3 }], shown }, basket).ok);
ok('a product that was not shown: rejected', !ER.validate({ ops: [{ op: 'replace', line: 1, product: 2 }], shown }, basket).ok);
ok('two changes to one line: rejected', !ER.validate({ ops: [{ op: 'remove', line: 1 }, { op: 'set_qty', line: 1, qty: 3 }], shown }, basket).ok);
ok('set_qty with no quantity: rejected', !ER.validate({ ops: [{ op: 'set_qty', line: 2 }], shown }, basket).ok);
ok('a silly quantity: rejected', !ER.validate({ ops: [{ op: 'set_qty', line: 2, qty: 99999 }], shown }, basket).ok);
ok('replace a line with itself: rejected', !ER.validate({ ops: [{ op: 'replace', line: 1, product: 1 }], shown: [{ name: basket[0].name }] }, basket).ok);
ok('no ops: valid, nothing to do', ER.validate({ ops: [], shown }, basket).ok);
ok('shown products: those Rachel named first', ER.shownFor([{ name: 'Kim Crawford Sauvignon Blanc' }, { name: 'Nicolas Idiart Sancerre Blanc - 750 ML' }], offer)[0].name.startsWith('Nicolas'));
const rv = ER.regexView('Take out the cloudy bay and regenerate the proposal.', basket, '');
ok('regex view = removes Cloudy Bay too (no disagreement)', ER.disagreement([{ op: 'remove', item: basket[0] }], rv).length === 0);
const beer = [{ name: 'Goose Island IPA 12 x 12 OZ Bottles', qty: 4, price: 31.99 }];
ok('24 bottles on a 12-pack line is never 24 packs (rejected; the units reader converts)', !ER.validate({ ops: [{ op: 'set_qty', line: 1, qty: 24 }], shown: [] }, beer, 'we need 24 bottles not 4 cases').ok);
ok('"make it 6 packs" on a pack line is fine', ER.validate({ ops: [{ op: 'set_qty', line: 1, qty: 6 }], shown: [] }, beer, 'make the IPA 6 packs').ok);
{ const vu = ER.validate({ ops: [{ op: 'units', line: 1, qty: 24 }], shown: [] }, beer, 'we need 24 bottles not 4 cases');
  ok('units: 24 bottles of a 12-pack line = 2 packs, converted in code', vu.ok && vu.ops[0].op === 'set_qty' && vu.ops[0].qty === 2); }
ok('units on a line that is not a pack: rejected', !ER.validate({ ops: [{ op: 'units', line: 1, qty: 6 }], shown: [] }, [{ name: 'Tito\'s Handmade Vodka - 750 ML', qty: 2 }], '6 bottles').ok);
// Fix A (Nov 20 nightly, pick-plus-question / F-0016): a line the customer wants REPLACED by something not chosen yet stays.
{ const bac = [{ name: 'Bacardi Superior White Rum 750ML', qty: 5, price: 18.58 }, { name: 'Patrón Silver Tequila - 750 ML', qty: 4, price: 47.29 }];
  const msgA = "Instead of the Bacardi I'd like a higher end bourbon, same 5 bottles — show me a few options";
  const vA = ER.validate({ ops: [{ op: 'remove', line: 1 }], shown: [] }, bac, msgA);
  ok('A: "Instead of the Bacardi ... show me a few options" — remove NOT applied, the line stays', vA.ok && vA.ops.length === 0);
  const vB = ER.validate({ ops: [{ op: 'remove', line: 1 }], shown: [] }, bac, 'remove the Bacardi');
  ok('A: "remove the Bacardi" still removes it', vB.ok && vB.ops.length === 1 && vB.ops[0].op === 'remove' && vB.ops[0].item.name.startsWith('Bacardi'));
  ok('A: "swap out the Bacardi for something nicer" keeps the line', ER.validate({ ops: [{ op: 'remove', line: 1 }], shown: [] }, bac, 'swap out the Bacardi for something nicer').ops.length === 0);
  ok('A: "in place of the Bacardi" keeps the line', ER.validate({ ops: [{ op: 'remove', line: 1 }], shown: [] }, bac, 'in place of the Bacardi, what bourbons do you have?').ops.length === 0);
  ok('A: a cue that names ANOTHER line does not keep this one ("drop the Bacardi, and switch the Patron")',
    ER.validate({ ops: [{ op: 'remove', line: 1 }], shown: [] }, bac, 'drop the Bacardi, and switch the Patron to Casamigos').ops.length === 1);
  ok('A: the reading adds a replacement -> the remove stands', ER.validate({ ops: [{ op: 'remove', line: 1 }, { op: 'add', product: 1, qty: 5 }], shown: [{ name: 'Buffalo Trace Kentucky Straight Bourbon - 750 ML', price: 40.69 }] }, bac, 'Instead of the Bacardi, add 5 Buffalo Trace').ops.some(o => o.op === 'remove'));
  ok('A: a type word alone is not the line ("instead of white rum ...")', !ER.wantsReplaced('instead of white rum I want vodka. remove the Bacardi', bac[0]));
}
if (failed) { console.log(failed + ' failed'); process.exit(1); }
