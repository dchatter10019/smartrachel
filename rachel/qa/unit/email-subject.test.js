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
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
