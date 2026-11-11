// Unit tests for the Nov 11 iCapital conversation (DC on Claude Code, 10165): a counted menu asked the serving mix, the
// unplaced proposal was lost at the fresh start, and an older placed order was reopened by the new brief.
// (precheck.sh runs qa/unit/*.test.js.)
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-'));
process.env.PROPOSAL_ITEMS_DIR = dir;
const SM = require('../../serving-mix.js');
const OC = require('../../original-compare.js');
const POM = require('../../placed-order-msg.js');
const KP = require('../../kept-proposal.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

const brief = 'Client: iCapital\nEvent Date: November 12th | 5-7pm\nHead Count: 45-50 people\nDelivery Address: 60 East 42nd Street, 10th floor, New York, NY 10165\nDelivery Point of Contact: Maria Zarzuela | Cell: 917-816-4128\n\nMenu:\n- 2 btls of Woodford Reserve Bourbon\n- 2 btls of Titos Vodka\n- 1 btl of St-Germain elderflower liqueur\nWine\nSancerre 5 btls\nPinot Noir 5 btls\nBeer\nStella 1 case\nBrooklyn lager 1 case\nAthletic 12pack';
eq('the iCapital brief is a counted list', SM.isCountedList(brief), true);
eq('field lines are never counted drinks', SM.countedLines(brief).some(l => /Head Count|Cell|Delivery/.test(l)), false);
eq('an event with no counts still gets the mix question', SM.isCountedList('wine, beer and cocktails for 50 guests, 3 hours, $2000'), false);
eq('one counted line is not a list', SM.isCountedList('Event for 40 people: 3 cases of beer plus wine and spirits'), false);

eq('"Sancerre 5 btls" = 5 x Sancerre', (({ name, qty }) => ({ name, qty }))(OC.namedFromListLine('Sancerre 5 btls')), { name: 'Sancerre', qty: 5 });
eq('"Pinot Noir 5 btls" = 5 x Pinot Noir', OC.namedFromListLine('Pinot Noir 5 btls').qty, 5);
eq('"Tito\'s 1.75 L" is a size, not a count', OC.namedFromListLine("Tito's 1.75 L").qty, 1);

eq('"change my last order" names the order', POM.namesOrder('change my last order: add 2 Titos'), true);
eq('order id names the order', POM.namesOrder('add to BEVVI-AI-INFO-20261110-181030'), true);
eq('"add the following to iCapital" does not', POM.namesOrder("Per client, let's please add the following to iCapital"), false);

fs.writeFileSync(path.join(dir, 'bevvi-proposal-icapital-2026-11-12-zke2cs.pdf.json'), JSON.stringify({ pdf: 'bevvi-proposal-icapital-2026-11-12-zke2cs.pdf', client_name: 'ICapital', event_date: 'November 12, 2026', notes: 'Delivery: 60 E 42nd St, 10th floor, New York, NY 10165.', line_items: [{ name: 'Woodford Reserve', qty: 2, price: 48.94 }] }));
const prop = KP.load('bevvi-proposal-icapital-2026-11-12-zke2cs.pdf');
eq('kept from the old conversation', (KP.keepFrom({ lastProposalUrl: 'https://mcp.getbevvi.com/proposals/bevvi-proposal-icapital-2026-11-12-zke2cs.pdf' }) || {}).pdf, 'bevvi-proposal-icapital-2026-11-12-zke2cs.pdf');
eq('a kept pointer older than 14 days is dropped', KP.keepFrom({ keptProposal: { pdf: 'bevvi-proposal-icapital-2026-11-12-zke2cs.pdf', at: Date.now() - 15 * 864e5 } }), null);
eq('the client named (any case) refers to it', !!KP.refersTo("let's please add the following to iCapital:", prop), true);
eq('"the proposal" refers to it', !!KP.refersTo('add 2 cases of stella to the proposal', prop), true);
eq('an unrelated message does not', KP.refersTo('add 2 cases of stella', prop), '');
eq('its delivery address', KP.addressOf(prop), '60 E 42nd St, 10th floor, New York, NY 10165');

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('icapital-nov11: all passed');
