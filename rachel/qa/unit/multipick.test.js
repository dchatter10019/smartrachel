// Unit tests for rachel/multipick.js against REAL option lists Rachel produced (fixtures) plus
// the other list shapes the resolver must keep handling. Run: node qa/unit/multipick.test.js
// (precheck.sh runs every qa/unit/*.test.js during lint — a failure blocks the deploy).
const fs = require('fs');
const path = require('path');
const { numberOptionLines, parseOptionGroups, resolvePicks, replacementTarget, pickLeftover, statedPickQty } = require('../../multipick.js');
const MPparse = parseOptionGroups;

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
};
const fx = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const basket = [
  { name: 'Cloudy Bay Sauvignon Blanc White Wine - 750 ML', qty: 5 },
  { name: 'Joseph Phelps Freestone Pinot Noir - 750 ML', qty: 3 },
  { name: 'Domaines Ott By Ott Rosé - 750 ML', qty: 2 },
];
const run = (text, msg) => { const g = parseOptionGroups(text); const r = resolvePicks(msg, g); return { g, r, targets: r.picks.map(p => { const t = replacementTarget(p, basket); return p.name + ' -> ' + (t ? t.name : 'NEW'); }) }; };

console.log('reprice: headings WITH a price, numbering continuous across groups (the Sep 26 failure)');
{
  const { g, r, targets } = run(fx('reprice-grouped-continuous.txt'), 'Sauvignon Blanc 1, Pinot Noir 1, rosé 1');
  eq('headings recognised', g.filter(x => x.options.length).map(x => x.heading), ['Sauvignon Blanc alternatives', 'Pinot Noir alternatives']);
  eq('picks: first option of each named group', r.picks.map(p => p.name), ['Jadot Macon Villages (Chardonnay)', "Kendall-Jackson Vintner's Reserve Pinot Noir"]);
  eq('each pick replaces the line its group names', targets, ['Jadot Macon Villages (Chardonnay) -> Cloudy Bay Sauvignon Blanc White Wine - 750 ML', "Kendall-Jackson Vintner's Reserve Pinot Noir -> Joseph Phelps Freestone Pinot Noir - 750 ML"]);
  eq('rosé: reported, not mapped to option #1', r.notes, ['no alternatives were listed for rosé — nothing changed there']);
  eq('nothing unmatched', r.unmatched, []);
}

console.log('reprice: headings with a price, an empty "Rosé alternatives" group');
{
  const { r, targets } = run(fx('reprice-grouped-per-group.txt'), 'Sauvignon Blanc 1, Pinot Noir 1, rosé 1');
  eq('picks', r.picks.map(p => p.name), ['Jadot Macon Villages (Chardonnay)', 'Louis Jadot Bourgogne Pinot Noir']);
  eq('targets', targets, ['Jadot Macon Villages (Chardonnay) -> Cloudy Bay Sauvignon Blanc White Wine - 750 ML', 'Louis Jadot Bourgogne Pinot Noir -> Joseph Phelps Freestone Pinot Noir - 750 ML']);
  eq('rosé reported', r.notes, ['no alternatives were listed for Rosé alternatives — nothing changed there']);
}

console.log('reprice: price AFTER a dash in the heading ("PINOT NOIR — ~$20", "ROSÉ — none found in $15–25 range")');
{
  const { g, r, targets } = run(fx('reprice-dash-price-headings.txt'), 'Sauvignon Blanc 1, Pinot Noir 1, rosé 1');
  eq('the Pinot group is recognised', g.filter(x => x.options.length).map(x => x.heading), ['PINOT NOIR']);
  eq('Pinot Noir 1 = first Pinot option', r.picks.map(p => p.name), ['Louis Jadot Bourgogne Pinot Noir']);
  eq('it replaces the Pinot line', targets, ['Louis Jadot Bourgogne Pinot Noir -> Joseph Phelps Freestone Pinot Noir - 750 ML']);
  eq('Sauvignon Blanc and rosé reported, not dropped', r.notes, ['no alternatives were listed for Sauvignon Blanc alternatives — nothing changed there', 'no alternatives were listed for ROSÉ — nothing changed there']);
}

console.log('reprice: prose with a price range under a heading ("No rosé found in the $15–$25 range") — the Sep 27 failure');
{
  const { g, r, targets } = run(fx('reprice-price-range-prose.txt'), 'Sauvignon Blanc 1, Pinot Noir 1, rosé 1');
  eq('the prose line is not an option', g.filter(x => x.options.length).map(x => x.heading), ['Sauvignon Blanc alternatives', 'Pinot Noir alternatives']);
  eq('picks', r.picks.map(p => p.name), ['Jadot Macon Villages (Chardonnay)', 'Louis Jadot Bourgogne Pinot Noir']);
  eq('targets', targets, ['Jadot Macon Villages (Chardonnay) -> Cloudy Bay Sauvignon Blanc White Wine - 750 ML', 'Louis Jadot Bourgogne Pinot Noir -> Joseph Phelps Freestone Pinot Noir - 750 ML']);
  eq('rosé reported', r.notes, ['no alternatives were listed for Rosé alternatives — nothing changed there']);
}

console.log('reprice: options shown with a line total ("$18.69 ea = $93.45")');
{
  const { r, targets } = run(fx('reprice-options-with-line-totals.txt'), 'Sauvignon Blanc 1, Pinot Noir 1, rosé 1');
  eq('all three picks resolved', r.picks.map(p => p.name), ['Justin Sauvignon Blanc', "Kendall-Jackson Vintner's Reserve Pinot Noir ⭐", 'The Beach Rosé']);
  eq('each replaces its line', targets.map(x => x.split(' -> ')[1]), ['Cloudy Bay Sauvignon Blanc White Wine - 750 ML', 'Joseph Phelps Freestone Pinot Noir - 750 ML', 'Domaines Ott By Ott Rosé - 750 ML']);
  eq('no false "no alternatives" notes', r.notes, []);
  const basketLine = MPparse('5x Cloudy Bay Sauvignon Blanc — $37.39 ea = $186.95\nWhich would you like?');
  eq('a basket line is still not an option', basketLine.flatMap(x => x.options).length, 0);
}

console.log('grouped, each group numbered from 1');
{
  const text = ['Sauvignon Blanc:', '1. Kim Crawford Sauvignon Blanc — 750 mL — $16.42', '2. Whitehaven Sauvignon Blanc — 750 mL — $17.59',
    'Pinot Noir:', '1. Meiomi Pinot Noir — 750 mL — $21.99', '2. Kendall-Jackson Pinot Noir — 750 mL — $20.89', 'Which would you like?'].join('\n');
  const { r, targets } = run(text, 'Sauv Blanc 2, Pinot noir 1');
  eq('picks by group-local number', r.picks.map(p => p.name), ['Whitehaven Sauvignon Blanc', 'Meiomi Pinot Noir']);
  eq('targets', targets, ['Whitehaven Sauvignon Blanc -> Cloudy Bay Sauvignon Blanc White Wine - 750 ML', 'Meiomi Pinot Noir -> Joseph Phelps Freestone Pinot Noir - 750 ML']);
  eq('bare numbers map to groups in order', run(text, '2, 2').r.picks.map(p => p.name), ['Whitehaven Sauvignon Blanc', 'Kendall-Jackson Pinot Noir']);
}

console.log('flat list, picks by name');
{
  const text = ['Here are some options:', '1. Decoy Cabernet Sauvignon — 750 mL — $24.19', '2. Louis Jadot Bourgogne Pinot Noir — 750 mL — $24.19', '3. Wolffer Estate Rosé — 750 mL — $19.99', 'Which would you like to add?'].join('\n');
  const { r } = run(text, 'give me decoy, louis jadot and wolffer');
  eq('all three by name', r.picks.map(p => p.name), ['Decoy Cabernet Sauvignon', 'Louis Jadot Bourgogne Pinot Noir', 'Wolffer Estate Rosé']);
  eq('no headings: a category word falls back to the shown number', run(text, 'wine 2').r.picks.map(p => p.name), ['Louis Jadot Bourgogne Pinot Noir']);
}

console.log('add_item by partial name from a list two replies back (the Sep 28 WhatsApp failure)');
{
  const { matchListedByName } = require('../../multipick.js');
  const replies = [fx('reds-list-0928.txt'), 'Which one would you like to add — and how many bottles?'];
  const names = (ref, rs) => { const m = matchListedByName(ref, rs || replies); return m && m.matches.map(o => o.name); };
  eq('"Kendall Pinot" -> only #4', names('Kendall Pinot'), ["Kendall-Jackson Vintner's Reserve Pinot Noir"]);
  eq('price/size carried', (({ size, price }) => ({ size, price }))(matchListedByName('Kendall Pinot', replies).matches[0]), { size: '750 mL', price: 20.89 });
  eq('"kendall cab" (abbreviation) -> #3', names('kendall cab'), ["Kendall-Jackson Vintner's Reserve Cabernet Sauvignon"]);
  eq('"Kendall" alone -> both KJ lines, ask among those', names('Kendall'), ["Kendall-Jackson Vintner's Reserve Cabernet Sauvignon", "Kendall-Jackson Vintner's Reserve Pinot Noir"]);
  eq('not listed -> no matches (catalog search)', names('Meiomi Pinot'), []);
  eq('no list in recent replies -> null', matchListedByName('Kendall Pinot', ['Which one?', 'Sure.']), null);
  eq('newest list wins over an older one', names('Pinot', [fx('reds-list-0928.txt'), 'Options:\n1. Meiomi Pinot Noir — 750 mL — $22.99\n2. Decoy Merlot — 750 mL — $24.19']), ['Meiomi Pinot Noir']);
}

console.log('single pick: only a message that is JUST the pick (the Sep 28 Knob Creek failure)');
{
  const opts = parseOptionGroups(fx('bourbon-tequila-picks-0928.txt')).flatMap(g => g.options);
  const kc = opts.find(o => /^Knob Creek 12/.test(o.name));
  eq('option 1 parsed', kc && [kc.name, kc.size, kc.price], ['Knob Creek 12 Year Straight Bourbon', '750mL', 100.79]);
  const real = '*Knob Creek 12 Year Straight Bourbon* — 750mL looks good. Do you have regular DOn julio blanco? Casamigos look good';
  eq('pick + question + second pick -> leftover, so the LLM gets it', pickLeftover(real, kc).length > 0, true);
  eq('the question is part of the leftover', pickLeftover(real, kc).includes('?'), true);
  eq('"<name> — 750mL looks good" -> selection-shaped', pickLeftover('Knob Creek 12 Year Straight Bourbon — 750mL looks good', kc), []);
  eq('"I\'ll take the knob creek 12 year please" -> selection-shaped', pickLeftover("I'll take the knob creek 12 year please", kc), []);
  eq('"5 bottles of <name>" -> selection-shaped', pickLeftover('5 bottles of Knob Creek 12 Year Straight Bourbon', kc), []);
  eq('"<name> and 2 Casamigos" -> not a single pick', pickLeftover('Knob Creek 12 Year and 2 Casamigos', kc), ['casamigos']);
  eq('"12" in the name is not a quantity', statedPickQty(real, kc), 0);
  eq('"<name> looks good" -> no quantity', statedPickQty('Knob Creek 12 Year Straight Bourbon — 750mL looks good', kc), 0);
  eq('"5 bottles of <name>" -> 5', statedPickQty('5 bottles of Knob Creek 12 Year Straight Bourbon', kc), 5);
  eq('"<name>, 12 bottles" -> 12 (unit given)', statedPickQty('Knob Creek 12 Year, 12 bottles', kc), 12);
  eq('"<name> x6" -> 6', statedPickQty('Knob Creek 12 Year x6', kc), 6);
  eq('"750mL" is never a quantity', statedPickQty('Woodford Reserve Master 750 mL', opts.find(o => /Woodford/.test(o.name))), 0);
}

console.log('options lists are always numbered (the Sep 29 unnumbered Tito\'s list)');
{
  const bare = "Yep! Here's what's available:\n\n*Tito's Handmade Vodka* — 1.75 L — $43.99\n*Tito's Handmade Vodka* — 1 L — $31.89\n*Tito's Handmade Vodka* — 750 mL — $24.19\n\nWhich size works for you?";
  const out = numberOptionLines(bare);
  eq('bare lines numbered 1..3', out.split('\n').filter(l => /^\d\. /.test(l)).map(l => l.slice(0, 3)), ['1. ', '2. ', '3. ']);
  eq('numbered result parses as options', parseOptionGroups(out).flatMap(g => g.options).map(o => o.size), ['1.75 L', '1 L', '750 mL']);
  eq('bulleted lines numbered', numberOptionLines('- *A Wine* — 750 mL — $20.00\n- *B Wine* — 750 mL — $22.00'), '1. *A Wine* — 750 mL — $20.00\n2. *B Wine* — 750 mL — $22.00');
  const already = 'Options:\n1. *A* — 750 mL — $20.00\n*B* — 750 mL — $22.00';
  eq('an already-numbered reply is untouched', numberOptionLines(already), already);
  const basket = '*SPIRITS*\n5x *BACARDI Superior White Rum* — 750 mL — $18.58 ea = $92.90\n4x *Patron Silver* — 750 mL — $47.29 ea = $189.16';
  eq('basket lines are untouched', numberOptionLines(basket), basket);
  const one = 'Casamigos Blanco Tequila — 1 L — $62.87';
  eq('a single product is untouched', numberOptionLines(one), one);
}

console.log(failed ? '\nmultipick: ' + failed + ' FAILED' : '\nmultipick: all passed');
process.exit(failed ? 1 : 0);
