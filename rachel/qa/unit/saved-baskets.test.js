// Saved baskets (saved-baskets.js; DC, Nov 20): parse the commands, save / list / find / delete with dates.
const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
process.env.RACHEL_DATA_DIR = dir;
const SB = require('../../saved-baskets.js');
let n = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// SAVE
eq(SB.parse('save this basket as Holiday Party'), { kind: 'save', name: 'Holiday Party' });
eq(SB.parse('Please save my cart as "Q1 offsite".'), { kind: 'save', name: 'Q1 offsite' });
eq(SB.parse('can you save this basket as Goody Friday?'), { kind: 'save', name: 'Goody Friday' });
eq(SB.parse('Save the basket'), { kind: 'save', name: '' });
eq(SB.parse('save this order for later'), { kind: 'save', name: '' });
eq(SB.parse('name this basket Board dinner'), { kind: 'save', name: 'Board dinner' });
eq(SB.parse('Hi Rachel,\n\nPlease save this basket as Eterra weekly.\n\nThanks,\nDC'), { kind: 'save', name: 'Eterra weekly' });
// LIST
for (const m of ['show my saved baskets', 'What baskets have I saved?', 'list my baskets', 'saved baskets', 'Can you show me all my saved carts?', 'which saved baskets do I have'])
  eq(SB.parse(m), { kind: 'list' }, m);
// LOAD / DELETE
eq(SB.parse('load Holiday Party'), { kind: 'load', name: 'Holiday Party', explicit: true });
eq(SB.parse('load my Holiday Party basket'), { kind: 'load', name: 'Holiday Party', explicit: true });
eq(SB.parse('use the saved basket called Board dinner'), { kind: 'load', name: 'Board dinner', explicit: true });
eq(SB.parse('use my board dinner basket again'), { kind: 'load', name: 'board dinner', explicit: false });
eq(SB.parse('delete saved basket Holiday Party'), { kind: 'delete', name: 'Holiday Party', explicit: true });
// NOT saved-basket commands
for (const m of ['show my basket', 'save this basket and place the order', 'add 3 Tito\'s', 'keep the order as it is', 'I need 2 cases of Stella',
  '3 x Tito\'s 750ml\n2 x Stella 12pk', 'what is in my cart?', 'place the order'])
  eq(SB.parse(m), null, m);
// "remove the tito's from my cart" parses as a delete of a name that is no saved basket and not explicit -> server passes it on
eq(SB.parse('remove the tito\'s from my cart').explicit, false);
// name answer
eq(SB.nameAnswer('Holiday Party'), 'Holiday Party');
eq(SB.nameAnswer('call it "Friday drinks"'), 'Friday drinks');
eq(SB.nameAnswer('add 2 more Tito\'s'), '');
eq(SB.nameAnswer('what do you mean?'), '');

// storage
const items = [{ name: 'Tito\'s Handmade Vodka - 750 ML', qty: 3, price: 21.99 }, { name: 'Stella Artois 12 x 11.2 OZ', qty: 2, price: 19.5 }];
const a = SB.save('DC@getbevvi.com', 'Holiday Party', items, { zip: '10019' });
eq(a.replaced, false); eq(a.entry.total, 104.97);
const created = a.entry.created_at;
const b = SB.save('dc@getbevvi.com', 'holiday party', items.slice(0, 1));
eq(b.replaced, true); eq(b.entry.created_at, created, 're-save keeps the created date'); eq(b.entry.items.length, 1);
SB.save('dc@getbevvi.com', 'Board dinner', items);
eq(SB.list('dc@getbevvi.com').length, 2);
eq(SB.find('dc@getbevvi.com', 'HOLIDAY  party!').entry.name, 'holiday party');
eq(SB.find('dc@getbevvi.com', 'board').entry.name, 'Board dinner');
eq(SB.find('dc@getbevvi.com', 'nothing').entry, null);
eq(SB.list('someone@else.com').length, 0, 'per customer');
const lt = SB.listText('dc@getbevvi.com');
assert.ok(/saved [A-Z][a-z]{2} \d{1,2}, \d{4}/.test(lt) && /Board dinner/.test(lt) && !/^\s*1\./m.test(lt), lt); n++;
eq(SB.remove('dc@getbevvi.com', 'Board Dinner').name, 'Board dinner');
eq(SB.list('dc@getbevvi.com').length, 1);
// Nov 20 (DC on Slack): the name answer had a Slack-linked address in it.
eq(SB.nameAnswer('WAT - <https://www.google.com/maps/search/707+Roy+Moore+Rd,+Ona,+FL+33865?entry=gmail&amp;source=g|707 Roy Moore Rd, Ona, FL 33865>'), 'WAT - 707 Roy Moore Rd, Ona, FL 33865');
eq(SB.parse('save this basket as <https://x.com/a|Party Night>').name, 'Party Night');
eq(SB.claimsSaved('Saved! Your basket "WAT" is ready to go whenever you are.'), true);
eq(SB.claimsSaved('Would you like me to place the order, or send you a PDF proposal?'), false);
fs.rmSync(dir, { recursive: true, force: true });
console.log('saved-baskets: ' + n + ' checks passed');
