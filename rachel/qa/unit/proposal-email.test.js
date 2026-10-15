// Unit tests for proposal-email.js — who the connector's rachel_generate_proposal send_to may email (Oct 15, DC:
// caller's own email, its company domain — never for consumer mail — or @getbevvi.com; max 10; QA never sends).
// (precheck runs these.)
const PE = require('../../proposal-email.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const R = (caller, to, cc) => { const r = PE.allowedRecipients(caller, to, cc); return { to: r.to, cc: r.cc, rejected: r.rejected.map(x => x.address) }; };

eq('own address', R('dipanjan@getbevvi.com', 'dipanjan@getbevvi.com'), { to: ['dipanjan@getbevvi.com'], cc: [], rejected: [] });
eq('gmail rejected for a Bevvi caller', R('dipanjan@getbevvi.com', 'someone@gmail.com'), { to: [], cc: [], rejected: ['someone@gmail.com'] });
eq('same company domain allowed', R('sean@genii.com', 'Ann <ann@genii.com>, ops@getbevvi.com'), { to: ['ann@genii.com', 'ops@getbevvi.com'], cc: [], rejected: [] });
eq('other domain rejected, valid ones still sent', R('sean@genii.com', 'ann@genii.com; x@other.com'), { to: ['ann@genii.com'], cc: [], rejected: ['x@other.com'] });
eq('free mail: only the exact address', R('joe@gmail.com', 'joe@gmail.com, amy@gmail.com'), { to: ['joe@gmail.com'], cc: [], rejected: ['amy@gmail.com'] });
eq('free mail: getbevvi still allowed', R('joe@yahoo.co.uk', 'team@getbevvi.com'), { to: ['team@getbevvi.com'], cc: [], rejected: [] });
eq('dedupe, case-insensitive, cc', R('sean@genii.com', 'Ann@GenII.com', 'ann@genii.com, bob@genii.com'), { to: ['ann@genii.com'], cc: ['bob@genii.com'], rejected: [] });
eq('cc only -> first cc becomes To', R('sean@genii.com', '', 'bob@genii.com'), { to: ['bob@genii.com'], cc: [], rejected: [] });
eq('not an address', R('sean@genii.com', 'ann at genii'), { to: [], cc: [], rejected: ['ann at genii'] });
const many = Array.from({ length: 12 }, (_, i) => 'p' + i + '@genii.com').join(',');
eq('cap 10', R('sean@genii.com', many).to.length, 10);
eq('cap 10 reports the rest', R('sean@genii.com', many).rejected, ['p10@genii.com', 'p11@genii.com']);
eq('array input', R('sean@genii.com', ['ann@genii.com']), { to: ['ann@genii.com'], cc: [], rejected: [] });

eq('QA caller -> dry run', PE.isQA('qa-mcp@getbevvi.com', ['dipanjan@getbevvi.com'], []), true);
eq('only QA recipients -> dry run', PE.isQA('dipanjan@getbevvi.com', ['qa-voiceflow@getbevvi.com'], ['rachel_qa@getbevvi.com']), true);
eq('a real recipient -> sends', PE.isQA('dipanjan@getbevvi.com', ['qa-voiceflow@getbevvi.com', 'dipanjan@getbevvi.com'], []), false);

eq('first name from recipient_name', PE.firstName('sean o\'brien', 'x@y.com'), 'Sean');
eq('first name from address', PE.firstName('', 'dipanjan@getbevvi.com'), 'Dipanjan');
eq('first.last address', PE.firstName('', 'mara.lopez@foodie.com'), 'Mara');
eq('role mailbox -> none', PE.firstName('', 'events@foodie.com'), '');

eq('subject with date', PE.subjectFor('Fooda', 'December 5, 2026'), 'Your Bevvi proposal – Fooda – December 5, 2026');
eq('subject without date', PE.subjectFor('Fooda', ''), 'Your Bevvi proposal – Fooda');
const body = PE.bodyFor({ first: 'Sean', clientName: 'Fooda', eventDate: 'December 5, 2026',
  totals: { products: 142.98, tax_label: 'Tax (9%)', tax: 12.87, service_label: 'Service (10%)', service: 14.3, tip_label: 'Tip (5%)', tip: 7.15, delivery: 25, grand_total: 202.3 } });
eq('body greeting', body.split('\n')[0], 'Hi Sean,');
eq('body attached line', /proposal for Fooda is attached, for December 5, 2026\./.test(body), true);
eq('body totals', /Total: \$202\.30 \(products \$142\.98, Tax \(9%\) \$12\.87, Service \(10%\) \$14\.30, Tip \(5%\) \$7\.15, delivery \$25\.00\)\./.test(body), true);
eq('body sign-off', body.endsWith('Warmly,\nRachel\nYour personal mixologist at Bevvi'), true);
eq('body has no link', /https?:/.test(body), false);

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('proposal-email: all passed');
