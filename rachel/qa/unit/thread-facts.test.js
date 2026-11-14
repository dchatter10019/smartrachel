// thread-facts.js (DC, Nov 14: "always checks the entire email thread and gathers all the information and only if it can't
// find a required piece of information, it asks"). (precheck runs qa/unit.)
const TF = require('../../thread-facts.js');
const EB = require('../../email-body.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const DC = 'Dipanjan Chatterjee <dipanjan@getbevvi.com>';
const ctx = { subject: 'Fwd: Order Request – HI USA NYC Hostel/ Lisa Gurvich Private Reception', senderName: 'Dipanjan Chatterjee', senderEmail: 'dipanjan@getbevvi.com' };

// The real HI USA re-forward: everything is in the email the forwarded reply quotes.
const fwd = `can you check the email below? create a proposal with wine bottles not more
than $15. Yes I am 21

---------- Forwarded message ---------
From: Esthefany Fernandez <esthefany@eterrakitchen.com>
Date: Fri, Nov 13, 2026 at 3:22 PM
Subject: Re: Order Request – HI USA NYC Hostel/ Lisa Gurvich Private Reception

Hello Dipanjan,

My apologies for the oversight. I forgot to mention that the requested
delivery date is* Thursday, November 19th*

On Fri, Nov 13, 2026 at 3:10 PM Esthefany Fernandez <esthefany@eterrakitchen.com> wrote:

> *Delivery Address:*
> HI USA NYC Hostel – Penthouse
> 891 Amsterdam Ave
> <https://www.google.com/maps/search/891>
> New York, NY
>
> Sauvignon Blanc – 10 bottles
>
> Pinot Noir – 6 bottles
>
> Prosecco – 5 bottles
>
> *Delivery Contact:* Stephani Alvarez
> *Phone:* 929-278-4626
> *Delivery Window:* 3:00 PM – 5:00 PM
>
> Esthefany Fernandez
> Eterra Kitchen <https://www.eterrakitchen.com/>`;
const f = TF.gather(EB.customerEmails([{ from: DC, body: fwd, current: true }]), ctx);
ok('address from the quoted email', f.address && f.address.value === '891 Amsterdam Ave, New York, NY');
ok('date: November 19 (never the forward\'s Nov 13/14 headers)', f.eventDate && /November 19, 2026/.test(f.eventDate.value));
ok('items: the 3 quoted lines', f.items && f.items.count === 3 && /Prosecco – 5 bottles/.test(f.items.value));
ok('phone + window + wine $15 cap', f.phone && /929/.test(f.phone.value) && f.window && /3:00 PM/.test(f.window.value) && f.bottlePrice && /"max":15/.test(f.bottlePrice.value));
ok('client: the forwarded sender\'s company', f.client && f.client.value === 'Eterra Kitchen');
ok('the Bevvi forwarder is never the contact', !f.contactName || !/Dipanjan/.test(f.contactName.value));
const n = TF.note(f);
ok('note lists the facts and says never to ask for them', /KNOWN FROM THE EMAIL THREAD/.test(n) && /891 Amsterdam Ave/.test(n) && /Never ask/.test(n));
ok('asks the thread answers are caught', TF.askedKnown("Thanks! What's your delivery address? (street, city, state and zip)", f).map(x => x.field).join() === 'address'
  && TF.askedKnown('What is the event date?', f)[0].field === 'eventDate' && TF.askedKnown('What is the client or company name?', f)[0].field === 'client'
  && TF.askedKnown('How many bottles would you like on the proposal?', f)[0].field === 'items');
ok('a question the thread can\'t answer is fine', !TF.askedKnown('Which time zone is that in — PT, MT, CT or ET?', f).length);

// Newest statement wins: a later email moves the date.
const t2 = EB.customerEmails([
  { from: 'Sean <sean@acme.com>', ts: Date.parse('2026-11-10T15:00:00Z'), body: 'Quote please for our party on December 5.\nDeliver to: 1 Rockefeller Plaza, New York, NY 10019\n- 3 x Tito\'s\n- 2 x Stella case' },
  { from: 'Rachel AI <rachelai@getbevvi.com>', ts: Date.parse('2026-11-10T15:05:00Z'), body: 'Your proposal is ready! Event date: December 5, 2026' },
  { from: 'Sean <sean@acme.com>', body: 'The party moved — the event date is now December 12. Please update.', current: true },
]);
const f2 = TF.gather(t2, { subject: 'Drinks for Acme', senderName: 'Sean', senderEmail: 'sean@acme.com' });
ok('newest date wins (Dec 12), Rachel\'s own emails never count', f2.eventDate && /December 12/.test(f2.eventDate.value));
ok('address + items from the first email', f2.address && /10019/.test(f2.address.value) && f2.items && f2.items.count === 2);
ok('client from the subject', f2.client && f2.client.value === 'Acme');
ok('nothing known -> no note', TF.note(TF.gather([], {})) === '');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
