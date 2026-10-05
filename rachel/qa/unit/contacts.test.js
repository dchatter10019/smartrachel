// Unit tests for customer-contacts.js: which replies correct / refuse a prefilled name at checkout,
// and which channel profile names are usable as the order name. (precheck.sh runs qa/unit/*.test.js.)
const { nameCorrection, refusesName, profileName } = require('../../customer-contacts.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
console.log('nameCorrection');
eq('no, it\'s Jordan Smith', nameCorrection('no, it\'s Jordan Smith'), 'Jordan Smith');
eq('use jane doe', nameCorrection('use jane doe'), 'jane doe');
eq('put it under Mary Ann Lee.', nameCorrection('put it under Mary Ann Lee.'), 'Mary Ann Lee');
eq('bare Jane Doe', nameCorrection('Jane Doe'), 'Jane Doe');
eq('same', nameCorrection('same'), null);
eq('use the same', nameCorrection('use the same'), null);
eq('use my account email', nameCorrection('use my account email'), null);
eq('Same Please', nameCorrection('Same Please'), null);
eq('sounds good', nameCorrection('sounds good'), null);
eq('an email', nameCorrection('jane@x.com'), null);
console.log('refusesName');
eq('no', refusesName('no'), true);
eq('that\'s wrong', refusesName('that\'s wrong'), true);
eq('no, it\'s Jordan Smith', refusesName('no, it\'s Jordan Smith'), false);
eq('same', refusesName('same'), false);
console.log('profileName');
eq('Dipanjan Chatterjee', profileName('Dipanjan Chatterjee'), 'Dipanjan Chatterjee');
eq('one word', profileName('DC'), '');
eq('email', profileName('dc@getbevvi.com'), '');
eq('empty', profileName(''), '');
// A recipient named with the email answer (Oct 5, DC: "Khira Patel" was dropped, the order went under the Slack name).
const { recipientNameIn } = require('../../customer-contacts.js');
eq('recipient named with the email', recipientNameIn('The Name of the recipient is Khira Patel but the email is <mailto:dc@getbevvi.com|dc@getbevvi.com>'), 'Khira Patel');
eq('recipient: Name, email', recipientNameIn('recipient: Khira Patel, khira@x.com'), 'Khira Patel');
eq("it's for First Last", recipientNameIn("it's for John Smith"), 'John Smith');
eq('"same" names no one', recipientNameIn('same'), null);
eq('an email alone names no one', recipientNameIn('dc@getbevvi.com'), null);
eq('"the recipient email is same" names no one', recipientNameIn('the recipient email is same'), null);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
