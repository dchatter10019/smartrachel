// feedback.js + customer-prefs.js (DC, Oct 3: "constantly train"): corrections and "Rachel feedback:" lines are recorded;
// lasting preferences are learned per customer / client. Runs in a temp data dir — never touches the real files.
const os = require('os'), fs = require('fs'), path = require('path');
process.env.RACHEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbprefs-'));
const F = require('../../feedback.js');
const P = require('../../customer-prefs.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const quiet = () => {};
// corrections — DC's real Foodie For All emails, and ordinary messages that are not corrections
eq('"you have the name from before ... X is not the customer" is a correction', !!F.correctionIn("You have the name from before. It's Pat Lee (Jordan is not not customer)"), true);
for (const t of ['I already told you the date is Oct 6', "That's wrong, I asked for cans", 'Why do you keep asking for Jordan']) eq('correction: ' + t, !!F.correctionIn(t), true);
for (const t of ['please place the order', 'Can you add 2 more?', 'we have the below inventory from last time', 'Yes place the order and send the payment link'])
  eq('not a correction: ' + t, F.correctionIn(t), '');
eq('"Rachel feedback:" line split from the rest', F.feedbackLine('Thanks!\nRachel feedback: the PDF had the wrong date\nAlso add 2 Titos'), { text: 'the PDF had the wrong date', rest: 'Thanks!\nAlso add 2 Titos' });
F.record({ kind: 'correction', session: 'email-x', who: 'pat@example.com', text: 'I already told you' }, quiet);
const rec = fs.readFileSync(F.FILE, 'utf8').trim().split('\n').map(JSON.parse);
eq('recorded to feedback.jsonl (not QA)', [rec.length, rec[0].kind, rec[0].qa], [1, 'correction', false]);
// preferences
eq('lasting statements only', ['We always do cans, not bottles.', 'Send 2 cases for this event.', 'From now on, send invoices to ap@example.com.', 'Thanks as always!', 'Can you always send the payment link as a link?', 'Can we always get it by noon?'].map(t => P.extract(t).length), [1, 0, 1, 0, 1, 0]);
P.learn('We always do cans, not bottles.', { email: 'pat@example.com', client: 'Example Co' }, quiet);
P.learn('From now on send invoices to ap@example.com.', { email: 'dc@getbevvi.com', client: 'Example Co', staff: true }, quiet);
const r = P.render({ email: 'pat@example.com', client: 'Example Co' });
eq('customer + client preferences shown', [/cans, not bottles/.test(r), /invoices to ap@/.test(r)], [true, true]);
eq('staff writing for a client: saved under the client only, never the staff member', P.render({ email: 'dc@getbevvi.com', client: 'Other Co' }), '');
P.learn('We always do cans, not bottles.', { email: 'pat@example.com', client: 'Example Co' }, quiet);
eq('the same preference is not saved twice', (r.match(/cans, not bottles/g) || []).length, 1);
P.learn('please forget the cans preference', { email: 'pat@example.com', client: 'Example Co' }, quiet);
eq('"forget the cans preference" removes it', /cans/.test(P.render({ email: 'pat@example.com', client: 'Example Co' })), false);
P.learn('We always do cans.', { email: 'qa-x@getbevvi.com', client: 'Example Co' }, quiet);
eq('a QA identity never writes to a real client', /We always do cans\./.test(P.render({ email: '', client: 'Example Co' })), false);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
