// Replies written IN CODE remember the whole email thread too (DC, Nov 14: "all replies to the emails should remember the
// history"). The model saw the thread, but the in-code proposal / quote PDF / email order read only the newest email and
// saved values: HI USA NYC Hostel's proposal said "Event date: November 14, 2026" (the forward's sent date) while
// Esthefany's email two up said "the requested delivery date is Thursday, November 19th". (precheck runs qa/unit.)
const EB = require('../../email-body.js');
const ED = require('../../event-date.js');
const PG = require('../../proposal-guard.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };

const sent = Date.parse('2026-11-13T22:55:00Z');
const thread = [
  { from: 'Dipanjan Chatterjee <dipanjan@getbevvi.com>', ts: sent, body: `Can you provide me with a proposal?

---------- Forwarded message ---------
From: Esthefany Fernandez <esthefany@eterrakitchen.com>
Date: Sat, Nov 14, 2026 at 1:52 AM
Subject: Re: Order Request – HI USA NYC Hostel/ Lisa Gurvich Private Reception

Hello Dipanjan,

My apologies for the oversight. I forgot to mention that the requested
delivery date is* Thursday, November 19th*

Thank you` },
  { from: 'Rachel AI <rachelai@getbevvi.com>', ts: sent + 60000, body: 'Hi Dipanjan,\n\nYour proposal is ready! Event date: November 14, 2026\n\nWarmly,\nRachel' },
  { from: 'Dipanjan Chatterjee <dipanjan@getbevvi.com>', ts: sent + 120000, body: 'Order:\n- Sauvignon Blanc – 10 bottles\nAverage price of $15\n*Delivery Contact:* Stephani Alvarez\n*Phone:* 929-278-4626\n*Delivery Window:* 3:00 PM – 5:00 PM' },
  { from: 'Dipanjan Chatterjee <dipanjan@getbevvi.com>', body: 'I need a proposal and this is different request than what I send before', current: true },
];

const ce = EB.customerEmails(thread);
ok('customer emails only, newest first (Rachel\'s left out)', ce.length === 3 && ce[0].current && /Thursday, November 19th/.test(ce[2].text));
ok('an older email keeps its own sent time', ce[2].sent.getTime() === sent);

// threadEventDate as server.js builds it
const all = []; for (const e of ce) for (const d of ED.datesIn(e.text, e.sent)) if (!all.includes(d)) all.push(d);
let td = null; for (let k = 0; k < ce.length && !td; k++) { const d = ED.findEventDateIn(ce[k].text, ce[k].sent); if (d && /\d/.test(d)) td = { date: d, emailsBack: k, all }; }
ok('the thread\'s date = November 19 (not the forward header\'s Nov 14): ' + JSON.stringify(td && td.date), td && /November 19, 2026/.test(td.date));
ok('the forward\'s Date: header is never one of the customer\'s dates', !all.some(d => /November 14/.test(d)));

const pi = { client_name: 'HI USA NYC Hostel / Lisa Gurvich Private Reception', event_date: 'November 14, 2026', notes: '', line_items: [] };
const ctx = { message: thread[3].body, subject: 'Re: Fwd: Order Request – HI USA NYC Hostel/ Lisa Gurvich Private Reception', threadText: ce.map(e => e.text).join('\n\n'), threadDate: td, now: new Date('2026-11-14T03:12:00Z') };
const iss = PG.check(pi, ctx);
const di = iss.find(i => i.field === 'date');
ok('guard corrects the printed Nov 14 to the thread\'s Nov 19', di && di.fixable && /November 19/.test(di.expected));

// A date the customer DID write somewhere is never "corrected" (they answered the date question, or said "send it by ...").
const t2 = thread.slice(0, 3).concat([{ from: 'DC <dipanjan@getbevvi.com>', ts: sent + 180000, body: 'November 18' }, { from: 'DC <dipanjan@getbevvi.com>', body: 'Make it 3 cases', current: true }]);
const ce2 = EB.customerEmails(t2);
const all2 = []; for (const e of ce2) for (const d of ED.datesIn(e.text, e.sent)) if (!all2.includes(d)) all2.push(d);
const iss2 = PG.check({ ...pi, event_date: 'November 18, 2026' }, { ...ctx, message: 'Make it 3 cases', threadDate: { date: 'November 19, 2026', all: all2 } });
ok('a date the customer wrote in the thread is kept', !iss2.some(i => i.field === 'date'));

// Not an email (no thread): unchanged.
ok('no thread date -> no date issue', !PG.check(pi, { message: 'Make it 3 cases', now: ctx.now }).some(i => i.field === 'date'));

// The client the forwarded thread names counts as named by the customer (the subject check never overrides it).
const iss3 = PG.check({ ...pi, client_name: 'Eterra Kitchen' }, { ...ctx, subject: 'Fwd: Order for Acme', threadText: 'Esthefany\nEterra Kitchen <https://www.eterrakitchen.com/>' });
ok('a client named anywhere in the thread is not "corrected" to the subject\'s', !iss3.some(i => i.field === 'client'));

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
