// reconcileNamed (original-compare.js) on Sean's real 22-line email (nightly Oct 3, email-quote-list timed out): the
// customer's spellings ("Budlight", "Michelop", "Pumkin", "Ice tea") and the "(30 cans per case)" notes made lines read
// as missing; they were re-added as junk rows, and "Sun Cruiser Lemonade" was taken as the Iced Tea line.
// (precheck.sh runs qa/unit/*.test.js.)
const C = require('../../original-compare.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const text = ['2 x Budlight (30 cans per case)', '2 x Michelop ULTRA (30 cans per case)', '2 x Carlsberg (12 cans per case)',
  '8 x High Noon Hard Seltzer Variety (12 cans per case Include GRAPEFRUIT)', '1 x Pumkin beer (12 cans per case)',
  '2 x Sun Cruiser Ice tea Variety pack (18 cans per case)', '2 x Sun Cruiser Lemonade Variety pack (18 cans per case)'].join('\n');
const llm = ['Bud Light 30 cans', 'Michelob Ultra 30 cans', 'Carlsberg 12 cans', 'High Noon Hard Seltzer Variety 12 cans Grapefruit',
  'Pumpkin Beer 12 cans', 'Sun Cruiser Iced Tea Variety Pack 18 cans'];
const np = llm.map(name => ({ name, qty: 1 }));
const log = C.reconcileNamed(np, text);
eq('typos and run-together words match the LLM lines (nothing re-added for them)', np.slice(llm.length).map(x => x.name), ['Sun Cruiser Lemonade Variety pack 18 cans per case']);
eq('counts taken from the list', np.slice(0, llm.length).map(x => x.qty), [2, 2, 2, 8, 1, 2]);
eq('lemonade never taken as the iced tea line', log.some(l => /Lemonade.*partly matches/.test(l)), false);
const np2 = llm.concat(['Sun Cruiser Lemonade Variety Pack 18 cans']).map(name => ({ name, qty: 1 }));
C.reconcileNamed(np2, text);
eq('with the LLM\'s lemonade line, nothing is added', np2.length, 7);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
