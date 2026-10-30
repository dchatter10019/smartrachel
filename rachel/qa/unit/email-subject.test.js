// Unit tests for email-subject.js — the client an email subject names (Oct 2, DC: "Goody alcohol order" was not read).
// (precheck.sh runs qa/unit/*.test.js.)
const { clientFromSubject } = require('../../email-subject.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
eq('DC: "Goody alcohol order"', clientFromSubject('Goody alcohol order'), 'Goody');
eq('a reply keeps it', clientFromSubject('Re: Goody alcohol order'), 'Goody');
eq('after a separator (Sean)', clientFromSubject('Drinks quote - Gen II Fund'), 'Gen II Fund');
eq('"for <Client>"', clientFromSubject('Bar order for Acme Corp'), 'Acme Corp');
for (const s of ['Drinks order', 'Quote request', 'Fwd: Holiday party drinks', 'Re: Proposal', 'Changes 1790906102']) eq('names no one: ' + s, clientFromSubject(s), '');
eq('a date part is not the client; "Event" dropped (Oct 3)', clientFromSubject('Re: Menu Request - Foodie For All Event - Oct 6th'), 'Foodie For All');
eq('a date alone after the separator names no one', clientFromSubject('Quote - 10/6'), '');
const { clientLabeledIn } = require('../../email-subject.js');
eq('Oct 29 Sean: "Client is: Premier 360"', clientLabeledIn('Rachel,\n\nCan we have a menu proposed?\n\nClient is: Premier 360\nAddress is: 12 E 49th St'), 'Premier 360');
eq('"Client: Acme Corp"', clientLabeledIn('Client: Acme Corp'), 'Acme Corp');
eq('"Company name - Goody"', clientLabeledIn('Company name - Goody'), 'Goody');
eq('a client TBD names no one', clientLabeledIn('Client: TBD'), '');
eq('"client" mid-sentence is not a label', clientLabeledIn('Our client is hosting 40 people'), '');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
