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
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
