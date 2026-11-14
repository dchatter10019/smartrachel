// Nov 14 (DC email, "Bevvi - Nov 14th Delivery", 1076 Madison Ave): swap offer read backwards, a removal missed, and the
// subject's date billed as the client.
const ST = require('../../swap-target.js');
const QE = require('../../quote-edits.js');
const PE = require('../../proposal-edits.js');
const ES = require('../../email-subject.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const items = [
  { name: 'Cloudy Bay Sauvignon Blanc - 750 ML', qty: 12, price: 37.39 },
  { name: 'Chateau Lamour Saint Emilion Grand Cru - 750 ML', qty: 9, price: 21.99 },
];
const q = 'Great news — it is in stock.\n\nWant me to swap the Cloudy Bay out for the Nicolas Idiart Sancerre and regenerate the proposal?';
const tg = ST.swapTarget(q, items, 'Nicolas Idiart Sancerre Blanc - 750 ML');
ok('"swap X out for Y": the line is X (Cloudy Bay)', tg && tg.index === 0);
ok('"swap that in for X": still X', (ST.swapPhrase('Shall I swap that in for the Bread & Butter Pinot Grigio?') || {}).what === 'Bread & Butter Pinot Grigio');
ok('"swap in for X": still X', (ST.swapPhrase('Which one would you like to swap in for The Prisoner?') || {}).what === 'Prisoner');
ok('"replacing one of the X bottles"', (ST.swapPhrase('Which one as your second red (replacing one of the Prisoner bottles)?') || {}).oneOf === true);
ok('"swap X for Y": X', (ST.swapPhrase("Shall I swap the Tito's for Ketel One?") || {}).what === "Tito's");
const e = QE.parseEdits('Take out the cloudy bay and regenerate the proposal.');
ok('removal read without the "and regenerate" tail', JSON.stringify(e.removes) === '["cloudy bay"]' && e.wantsQuote);
ok('removal applied to the Cloudy Bay line', QE.applyEdits(items, e).changes.some(c => c.kind === 'removed' && /Cloudy Bay/.test(c.name)));
ok('proposal-edits sees "take out" as a basket edit', PE.editsIn('Take out the cloudy bay and regenerate the proposal.').length === 1);
ok('subject "Bevvi - Nov 14th Delivery" names no client', ES.clientFromSubject('Fwd: Bevvi - Nov 14th Delivery') === '');
ok('subject "Acme Corp delivery" -> Acme Corp', ES.clientFromSubject('Acme Corp delivery') === 'Acme Corp');
ok('subject "Menu Request - Foodie For All Event - Oct 6th" unchanged', ES.clientFromSubject('Menu Request - Foodie For All Event - Oct 6th') === 'Foodie For All');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
