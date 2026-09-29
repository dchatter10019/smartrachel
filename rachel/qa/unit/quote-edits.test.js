// Unit tests for quote-edits.js + email-body.js — edits to a quote the customer already has, decided in code.
// Real case (Sep 29, Gen II Fund): Sean forwarded Natalia's "remove the following ... remove all beer in bottles
// ... I only need 1 case ... resend an updated quote" (fixtures/gen2-forwarded-edits.json, contact details
// replaced) against the 23-line quote she had (fixtures/gen2-quote-sent.json). (precheck.sh runs qa/unit/*.test.js.)
const QE = require('../../quote-edits.js');
const { latest } = require('../../email-body.js');
const fwd = require('./fixtures/gen2-forwarded-edits.json');
const sent = require('./fixtures/gen2-quote-sent.json').line_items;
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}

console.log('email-body: only the new text + the forwarded message');
const body = latest(fwd.body);
eq('forwarded', body.forwarded, true);
eq('older history cut', body.trimmed, true);
eq("Sean's note kept", /can you make these modifications/.test(body.text), true);
eq("Natalia's edits kept", /Founders All Day IPA \(I only need 1 case\)/.test(body.text), true);
eq("her ORIGINAL Monday list is gone", /Allagash White 2 cases/.test(body.text), false);
eq("Sean's earlier replies are gone", /updated the order to include the cases/.test(body.text), false);
eq('plain reply: quote cut', latest('Sounds good, 3 please.\n\nOn Tue, Sep 29, 2026 at 2:36 PM Rachel <rachelai@getbevvi.com> wrote:\n> old').text, 'Sounds good, 3 please.');
eq('wrapped "On ... wrote:"', latest('Yes\n\nOn Tue, Sep 29, 2026 at 2:36 PM Rachel AI <\nrachelai@getbevvi.com> wrote:\n> x').text, 'Yes');
eq('Outlook block cut', latest('Please add ice.\n\n*From:* Rachel\n*Sent:* today').text, 'Please add ice.');
eq('no history: unchanged', latest('2 cases of Bud Light to 10 Main St, Boston, MA 02110').trimmed, false);

console.log('parseEdits on the real email');
const e = QE.parseEdits(body.text);
eq('removals', e.removes, ['Cantena Malbec', 'Pilsener Urquell', 'Octoberfest Bottles', 'Spaten Oktoberfest Ur-Marzen Bottles', 'Redhook ESB Bottles']);
eq('quantity', e.setQty, [{ name: 'Founders All Day IPA', qty: 1 }]);
eq('all bottled beer', e.attrs, [{ category: 'beer', packaging: 'bottle' }]);
eq('wants an updated quote', e.wantsQuote, true);
eq('no adds', e.adds, false);

console.log('applyEdits: the updated quote');
const r = QE.applyEdits(sent, e);
eq('23 -> 19 lines', [sent.length, r.items.length], [23, 19]);
eq('product total $954.55', QE.total(r.items), 954.55);
eq('no bottle left', r.items.filter(it => /bottle/i.test(it.name)).length, 0);
eq('"Cantena" (typo) removed Catena', r.changes.some(c => c.kind === 'removed' && c.name === 'Catena Malbec'), true);
eq('two requests for the Spaten line: removed once, nothing "not found"', [r.changes.filter(c => /Spaten/.test(c.name)).length, r.notFound], [1, []]);
eq('All Day IPA 2 -> 1', r.changes.find(c => c.kind === 'qty'), { kind: 'qty', name: 'Founders All Day IPA 15x12 oz Cans', from: 2, to: 1 });
eq('the sent list is not mutated', sent.find(it => /All Day/.test(it.name)).qty, 2);
const txt = QE.describe(r, sent);
eq('reply lists the change and totals', /All Day IPA 15x12 oz Cans: 2 → 1/.test(txt) && /\$954\.55 \(was \$1,102\.45\)/.test(txt), true);

console.log('other shapes');
eq('inline removal', QE.parseEdits('Please remove the Josh Cellars Cabernet from the order, thanks').removes, ['Josh Cellars Cabernet']);
eq('inline quantity', QE.parseEdits('We only need 2 cases of Bud Light.').setQty, [{ name: 'Bud Light', qty: 2 }]);
eq('"no bottled beer"', QE.parseEdits('No bottled beer please').attrs, [{ category: 'beer', packaging: 'bottle' }]);
eq('an add list is flagged (not handled in code)', QE.parseEdits('Please add the following:\n- Tito\'s 1.75L').adds, true);
eq('a plain order is not an edit', QE.parseEdits('I need 2 cases of Bud Light and 1 Tito\'s delivered Friday').count, 0);
const two = [{ name: 'Josh Cellars Cabernet Sauvignon', qty: 1, price: 15 }, { name: 'Josh Cellars Chardonnay', qty: 1, price: 15 }];
eq('ambiguous name: asked, not guessed', QE.applyEdits(two, { removes: ['Josh Cellars'] }).ambiguous.length, 1);
eq('unknown name: reported', QE.applyEdits(two, { removes: ['Grey Goose'] }).notFound, ['Grey Goose']);

console.log(failed ? '\nquote-edits: ' + failed + ' FAILED' : '\nquote-edits: all passed');
if (failed) process.exit(1);
