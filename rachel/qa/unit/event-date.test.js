// Unit tests for event-date.js — the event date printed on a proposal.
// (precheck.sh runs qa/unit/*.test.js.)
const { normalizeEventDate, parseProposalFieldEdit, findEventDateIn } = require('../../event-date.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const now = new Date(2026, 9, 1);   // Oct 1, 2026
const t = s => normalizeEventDate(s, now).text;
eq('Sean (Oct 1): sign-off in the date answer', t('Oct 6th, thanks Rache'), 'October 6, 2026');
eq('LLM wrote a past year (Oct 1)', t('October 6, 2025'), 'October 6, 2026');
eq('past year is flagged as moved', normalizeEventDate('October 6, 2025', now).moved, true);
eq('weekday + month', t('Tuesday, October 6th'), 'October 6, 2026');
eq('future year kept', t('Oct 6 2027'), 'October 6, 2027');
eq('a date already past this year -> next year', t('March 3'), 'March 3, 2027');
eq('day before month', t('the 15th of November'), 'November 15, 2026');
eq('numeric', t('10/15'), 'October 15, 2026');
eq('numeric with year', t('10/15/26'), 'October 15, 2026');
eq('ISO', t('2026-12-04'), 'December 4, 2026');
eq('not a date: kept', t('TBD'), 'TBD');
eq('not a date: sign-off removed', t('TBD, thank you!'), 'TBD');
eq('empty', t(''), '');
eq('"may" as a month only with a day', t('May 2'), 'May 2, 2027');
eq('Feb 30 is not a date', t('Feb 30'), 'Feb 30');

const pe = (m, saved) => parseProposalFieldEdit(m, saved, now);
eq('Sean (Oct 1): remove the sign-off from the date', pe('Can you please remove the "thanks Rache" from the date and send back and\nupdated PDF?', 'Oct 6th, thanks Rache'),
  { date: 'October 6, 2026', why: 'cleaned the saved date "Oct 6th, thanks Rache"' });
eq('Sean (Oct 1): client + date in one reply', pe('ok have the client be: Foodie For All\nEvent Date: Oct 6th\n\nThanks!'), { client: 'Foodie For All', date: 'October 6, 2026' });
eq('change the date', pe('can you change the event date to Oct 7?'), { date: 'October 7, 2026' });
eq('client should be', pe('the client should be Foodie For All Inc.'), { client: 'Foodie For All Inc' });
eq('client name with comma and date', pe('Please change the client to Acme Corp, and the date to 11/20'), { client: 'Acme Corp', date: 'November 20, 2026' });
eq('a delivery date question is not an edit', pe('what delivery dates do you have?'), null);
eq('already clean: still regenerated with the same date', pe('Can you please remove the "thanks Rache" from the date and send back and\nupdated PDF?', 'October 6, 2026'),
  { date: 'October 6, 2026', why: 'cleaned the saved date "October 6, 2026"' });
eq('"remove the date" = no date on the PDF', pe('please remove the date and resend', 'October 6, 2026'), { date: '', why: 'date removed' });
eq('unrelated message', pe('add 2 more cases of Modelo'), null);
eq('DC (Oct 1): pasted wrong Billed To + "it should be just Goody"', pe('Billed To:\nGoody Dipanjan Chatterjee CEO |\nBevvi getbevvi.com | @getbevvi\n\nit should be just Goody'), { client: 'Goody' });
eq('pasted label line alone still read', pe('Billed To: Goody Inc\nplease fix'), { client: 'Goody Inc' });
eq('"just X" with no client/bill-to word is not a client edit', pe('it should be just 2 bottles'), null);

const fd = m => findEventDateIn(m, now);
const quoteList = 'Hi,\r\n\r\nI need an alcohol menu quote that includes the below items.\r\n\r\nI am 21 years old. The delivery address is 100 Federal Street, Floor 6\r\nBoston, MA 02110\r\n\r\nItem Request:\r\n\r\n2 x Budlight (30 cans per case)\r\n2 Casamigos Margaritas Cocktail Cans (8 pack)\r\n2 x Sun Cruiser Ice tea Variety pack (18 cans per case)\r\n1 Oyster Bay Sauvignon Blanc, 2023\r\n\r\nThanks!\r\nSean';
eq('"Sun Cruiser" is not an event date (Oct 1, QA email-quote-list)', fd(quoteList), '');
eq("Sean's Foodie email: the delivery date", fd('Can you please draft a menu?\n\n*Delivery date: *\nTuesday, October 6th\n\n3 x Jack Daniel\'s Mixed with Coca-Cola'), 'October 6, 2026');
eq('a numeric date in a sentence', fd('Event is on 11/14, about 40 guests.'), 'November 14, 2026');
eq('"on Saturday"', fd('We need it for the party on Saturday.'), 'Saturday');
eq('a bare "Sat" is not a date', fd('Sat Bhai bottles'), '');

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
