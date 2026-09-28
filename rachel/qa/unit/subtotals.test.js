// Unit tests for package-subtotals.js on the two real event-estimates replies from Sep 28:
// one where the LLM wrote category subtotals, one where it skipped them.
// Run: node qa/unit/subtotals.test.js
const { categorySubtotals, applySubtotals } = require('../../package-subtotals.js');
const replies = require('./fixtures/package-replies-0928.json');

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
};
const count = (s, re) => (s.match(re) || []).length;

// The build behind both replies (same 20-guest $800 package).
const items = [
  { name: 'Meiomi Pinot Noir', qty: 4, price: 21.97, category: 'wine' },
  { name: 'Renato Ratti Nebbiolo Langhe', qty: 3, price: 28.59, category: 'wine' },
  { name: 'Cloudy Bay Sauvignon Blanc', qty: 2, price: 37.39, category: 'wine' },
  { name: 'Jadot Pouilly Fuissé', qty: 2, price: 40.69, category: 'wine' },
  { name: "Belvedere Organic Vodka", qty: 1, price: 59.39, category: 'spirits' },
  { name: 'Ron Zacapa 23', qty: 1, price: 59.39, category: 'spirits' },
  { name: "Angel's Envy", qty: 1, price: 57.19, category: 'spirits' },
  { name: "Hendrick's Gin", qty: 1, price: 53.67, category: 'spirits' },
  { name: 'Código 1530 Reposado', qty: 1, price: 60.49, category: 'spirits' },
];
const subs = categorySubtotals(JSON.stringify(items), '619.94');

console.log('computing');
eq('wine + spirits from line_items', subs.map(c => c.label + ' ' + c.total.toFixed(2)), ['Wine 329.81', 'Spirits 290.13']);
eq('mismatch with product total is refused', !!categorySubtotals(items, '700.00').skip, true);
eq('mixers bucket', categorySubtotals([{ qty: 2, price: 3.5, category: 'mixer' }], '7.00').map(c => c.label), ['Mixers & extras']);

for (const tag of ['without', 'with']) {
  console.log('reply ' + tag + ' LLM subtotals');
  const r = applySubtotals(replies[tag], subs, true);
  eq('one Wine total', count(r.text, /Wine total:/g), 1);
  eq('one Spirits total', count(r.text, /Spirits total:/g), 1);
  eq('values from code', [/\*Wine total: \$329\.81\*/.test(r.text), /\*Spirits total: \$290\.13\*/.test(r.text)], [true, true]);
  eq('wine total after last white, before SPIRITS', r.text.indexOf('Jadot') < r.text.indexOf('Wine total') && r.text.indexOf('Wine total') < r.text.indexOf('SPIRITS —'), true);
  eq('spirits total after tequila, before Product total', r.text.indexOf('Código') < r.text.indexOf('Spirits total') && r.text.indexOf('Spirits total') < r.text.indexOf('Product total'), true);
  eq('both placed in their sections', r.fallback, []);
  eq('item lines untouched', count(r.text, /\dx /g), count(replies[tag], /\dx /g));
}

console.log('no headers -> block before Product total');
{
  const r = applySubtotals('4x A — $10 ea = $40\n2x B — $5 ea = $10\n\n*Product total: $50.00*', [{ key: 'wine', label: 'Wine', total: 50 }], false);
  eq('fallback used', r.fallback, ['Wine']);
  eq('before product total', r.text.indexOf('Wine total: $50.00') < r.text.indexOf('Product total'), true);
}

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
