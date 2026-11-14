// The whole email thread as context (DC, Nov 14: "the entire email exchanges should be always present, it's losing
// context"). Nov 13, HI USA NYC Hostel: DC forwarded Esthefany's "I forgot the delivery date" reply; her order sat in the
// quoted history under it, latest() cut it, and Rachel asked "what beverages, how many guests?". (precheck runs qa/unit.)
const EB = require('../../email-body.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };

const first = `Can you provide me with a proposal?
Keep the price of the bottle around $15 a bottle.

Dipanjan Chatterjee
CEO | Bevvi

---------- Forwarded message ---------
From: Esthefany Fernandez <esthefany@eterrakitchen.com>
Date: Sat, Nov 14, 2026 at 1:52 AM
Subject: Re: Order Request – HI USA NYC Hostel/ Lisa Gurvich Private Reception
To: Dipanjan Chatterjee <dipanjan@getbevvi.com>

Hello Dipanjan,

My apologies for the oversight. I forgot to mention that the requested delivery date is Thursday, November 19th

On Fri, Nov 13, 2026 at 6:10 PM Esthefany Fernandez <esthefany@eterrakitchen.com> wrote:
> *Delivery Address:*
> 891 Amsterdam Ave
> <https://www.google.com/maps/search/891+Amsterdam+Ave?entry=gmail&source=g>
> New York, NY
> *Order:*
>    - Sauvignon Blanc – 10 bottles
>    - Pinot Noir – 6 bottles
>    - Prosecco – 5 bottles
> *Delivery Contact:* Stephani Alvarez
> *Phone:* 929-278-4626`;

const cut = EB.latest(first).text;
ok('latest() still acts on the new text + forward only (order not in it)', !/Pinot Noir – 6/.test(cut));
const one = EB.threadNote([{ from: 'Dipanjan Chatterjee <dipanjan@getbevvi.com>', body: first, current: true }], { currentText: cut });
ok('first email: the quoted order is in the thread notes', /Pinot Noir – 6 bottles/.test(one.note) && /Stephani Alvarez/.test(one.note));
ok('maps link lines dropped', !/google\.com\/maps/.test(one.note));
ok('marked as the email being answered', /THE EMAIL YOU ARE ANSWERING NOW/.test(one.note));

const plain = 'Please send 3 cases of Stella to 1 Main St, New York, NY 10019';
ok('a single email with nothing cut adds no notes', EB.threadNote([{ from: 'x', body: plain, current: true }], { currentText: plain }).note === '');

const rachel = `Hi Dipanjan,

Good options available under $15 for both.

Warmly,
Rachel
Your personal mixologist at Bevvi

On Sat, Nov 14, 2026 Dipanjan Chatterjee <dipanjan@getbevvi.com> wrote:
> Can you ensure the prices do not exceed $15?`;
const reply = `Yes do that

---------- Forwarded message ---------
From: Rachel AI <rachelai@getbevvi.com>
Date: Sat, Nov 14, 2026 at 4:45 AM

Hi Dipanjan, Good options available under $15 for both.`;
const later = `Yes Do these

On Sat, Nov 14, 2026 Rachel AI <rachelai@getbevvi.com> wrote:
> Here's the proposal ... Kim Crawford`;
const t = EB.threadNote([
  { from: 'Dipanjan Chatterjee <dipanjan@getbevvi.com>', body: first },
  { from: 'Rachel AI <rachelai@getbevvi.com>', body: rachel },
  { from: 'Dipanjan Chatterjee <dipanjan@getbevvi.com>', body: later },
  { from: 'Dipanjan Chatterjee <dipanjan@getbevvi.com>', body: reply, current: true },
], { currentText: 'Yes do that' });
ok('four emails, numbered', t.count === 4 && /--- Email 4 \(THE EMAIL YOU ARE ANSWERING NOW\)/.test(t.note));
ok('Rachel\'s email: her text, no sign-off, no quote', /From: Rachel \(you\)\nHi Dipanjan,\n\nGood options/.test(t.note) && !/personal mixologist/.test(t.note));
ok('a later email: quoted history not repeated', !/> Here's the proposal/.test(t.note));
ok('a forwarded copy of Rachel\'s own email not repeated', (t.note.match(/Good options available/g) || []).length === 1);
ok('the first email\'s order still there', /Sauvignon Blanc – 10 bottles/.test(t.note));

// Long threads: the first email and the newest ones stay, the middle is left out and said.
const many = [{ from: 'c', body: first }].concat(Array.from({ length: 30 }, (_, k) => ({ from: 'c', body: 'x'.repeat(3000) + ' email ' + k })), [{ from: 'c', body: 'latest ask', current: true }]);
const L = EB.threadNote(many, { currentText: 'latest ask' });
ok('long thread: first + newest kept, middle said', /Pinot Noir – 6/.test(L.note) && /latest ask/.test(L.note) && L.omitted > 0 && /left out for length/.test(L.note) && L.chars < 42000);

const fwdOther = EB.forContext('See below\n\n---------- Forwarded message ---------\nFrom: Client <c@x.com>\n\nNeed 4 cases\n\nOn Mon wrote:\n> older ask', {});
ok('a later email forwarding outside mail keeps the whole forward', /Need 4 cases/.test(fwdOther) && /older ask/.test(fwdOther));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
