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
if (failed) { console.log(failed + ' failed'); process.exit(1); }
