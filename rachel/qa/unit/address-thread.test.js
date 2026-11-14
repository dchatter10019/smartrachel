// Nov 14 (DC forwarding Esthefany's "I forgot to mention ... delivery date is Thursday, November 19th" reply): the address
// was in her ORIGINAL email, quoted under the forwarded reply; the email cut dropped it and Rachel asked for it. The address
// step now reads the thread (server.js threadAddressFor -> address-extract.js addressAfterLabel). (precheck runs qa/unit.)
const AX = require('../../address-extract.js');
const EB = require('../../email-body.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const body = `Can you create a proposal for this? The wine bottles should not exceed
$15.  I am over 21

---------- Forwarded message ---------
From: Esthefany Fernandez <esthefany@eterrakitchen.com>
Date: Fri, Nov 13, 2026 at 3:22 PM
Subject: Re: Order Request – HI USA NYC Hostel/ Lisa Gurvich Private Reception

Hello Dipanjan,

My apologies for the oversight. I forgot to mention that the requested
delivery date is* Thursday, November 19th*

Thank you

On Fri, Nov 13, 2026 at 3:10 PM Esthefany Fernandez <esthefany@eterrakitchen.com> wrote:

> Hello Dipanjan,
>
> *Delivery Address:*
> HI USA NYC Hostel – Penthouse
> 891 Amsterdam Ave
> <https://www.google.com/maps/search/891+Amsterdam+Ave+New+York,+NY?entry=gmail&source=g>
> New York, NY
> <https://www.google.com/maps/search/891+Amsterdam+Ave+New+York,+NY?entry=gmail&source=g>
>
> *Order:*
>    - Sauvignon Blanc – 10 bottles
`;
ok('the email cut drops the quoted original (what Rachel acts on)', !/Amsterdam/.test(EB.latest(body).text));
const ce = EB.customerEmails([{ from: 'DC <dipanjan@getbevvi.com>', body, current: true }]);
ok('the thread copy keeps it', /891 Amsterdam Ave/.test(ce[0].text));
ok('address under the label, venue line and maps links skipped: ' + JSON.stringify(AX.addressAfterLabel(ce[0].text)), AX.addressAfterLabel(ce[0].text) === '891 Amsterdam Ave, New York, NY');
ok('with a zip and a unit line', AX.addressAfterLabel('*Delivery Address:*\n1580 Park Avenue\n<https://www.google.com/maps/x>\nKitchen 3\nNew York, NY 10029') === '1580 Park Avenue, Kitchen 3, New York, NY 10029');
ok('a label with no street is not an address', AX.addressAfterLabel('Delivery address: TBD, will confirm\nthanks') === null);
ok('the appended "Address:" line splits off cleanly', AX.splitAddress('Can you create a proposal?\nAddress: 891 Amsterdam Ave, New York, NY 10025').rest === 'Can you create a proposal?');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
