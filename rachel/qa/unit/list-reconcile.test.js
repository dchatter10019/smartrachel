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

// Nov 10 (DC's iCapital menu on Claude Code): "2 btls of X" was read as 1 of "2 btls of X", so the one-word lines
// ("1 btl of Frangelico", "3 btls of Prosecco") no longer matched the LLM's lines and were re-added: Frangelico as a
// MIXER (stand-in Master of Mixes Bloody Mary Mix) and a second prosecco.
const menu = ['Menu:', '- 2 btls of Woodford Reserve Bourbon', '- 2 btls of Titos Vodka', '- 1 btl of Frangelico',
  '- 1 btl of St-Germain elderflower liqueur', '- 2 btls of Bombay Sapphire Gin', '- 3 btls of Prosecco', '- 1 btl of Triple Sec'].join('\n');
eq('"N btls of X" is a count', C.parseRequest(menu).map(r => [r.qty, r.counted]), [[2, true], [2, true], [1, true], [1, true], [2, true], [3, true], [1, true]]);
const np3 = [["Woodford Reserve Bourbon", 2], ["Tito's Vodka", 2], ['Frangelico', 1], ['St-Germain Elderflower Liqueur', 1],
  ['Bombay Sapphire Gin', 2], ['Prosecco', 3], ['Triple Sec', 1]].map(([name, qty]) => ({ name, qty, category: 'spirits' }));
eq('nothing re-added for a btl list', (C.reconcileNamed(np3, menu), np3.length), 7);
eq('"1 btl of Frangelico" as a list line = Frangelico, a spirit', C.namedFromListLine('1 btl of Frangelico'), { name: 'Frangelico', category: 'spirits', qty: 1, qty_from_customer: true });
eq('"3 btls of Prosecco" = 3 x Prosecco', C.namedFromListLine('3 btls of Prosecco').qty + ' x ' + C.namedFromListLine('3 btls of Prosecco').name, '3 x Prosecco');
const DT = require('../../drink-type.js');
eq('liqueurs have a type (stand-in stays a liqueur)', ['Frangelico', 'Kahlua', 'Baileys Original Irish Cream', 'Hiram Walker Triple Sec', 'Master of Mixes Bloody Mary Mix'].map(n => DT.typeOf({ name: n })),
  ['spirit:liqueur', 'spirit:liqueur', 'spirit:liqueur', 'spirit:liqueur', '']);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
