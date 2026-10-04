// Unit tests for email-order.js — "create the order" / "payment link" from an email, decided in code.
// DC (Sep 29): contact = the customer in the email; everything missing asked in ONE reply; tip 5% unless stated.
const EO = require('../../email-order.js');
const { latest } = require('../../email-body.js');
const fwd = require('./fixtures/gen2-forwarded-edits.json');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const now = new Date('2026-09-29T19:00:00Z');
const sean = { name: 'Sean Fitzgibbons', email: 'sean@getbevvi.com' };

console.log('order commands');
for (const t of ['Please create the order', 'Can you place the order?', 'create a payment link for this', 'Send me the payment link please',
  'Go ahead and place the order', 'Please create the updated order and send the pay link', 'proceed with the order'])
  eq('command: ' + t, EO.isOrderCommand(t), true);
for (const t of ["Don't place the order yet", 'Here is my order for next week', 'Thanks for the order!', 'Please send an updated quote', 'hold off on the payment link until Friday'])
  eq('not a command: ' + t, EO.isOrderCommand(t), false);

console.log("Sean forwards Natalia's email + 'please create the order'");
const body = latest(fwd.body).text.replace('Hi Rachel -- please see the email below', 'Hi Rachel -- please create the order and send the payment link. See the email below');
eq('the command is seen', EO.isOrderCommand(body), true);
const x = EO.extract(body, sean, now);
eq('contact = the forwarded customer, not Sean', [x.name, x.email, x.source], ['Natalia Diaz', 'office@example.com', 'forwarded customer']);
eq("phone from HER signature (M:)", x.phone, '(555) 010-0100');
eq('the forwarded "Date: ... 2:36 PM" header is not a delivery time', x.when, '');
eq('no tip stated', x.tip, null);
eq('missing = only the delivery time', EO.missing(Object.assign({}, x, { delivery_ok: false })), ['the delivery date and time']);

console.log('Sean writes without a forwarded customer: ask for all of it in ONE reply');
const y = EO.extract('Please create the order for Gen II.\n\nThanks,\nSean\nM: 617-555-0199', sean, now);
eq('Bevvi staff is never the customer', [y.name, y.email, y.phone], ['', '', '']);
const miss = EO.missing(Object.assign({}, y, { delivery_ok: false }));
eq('all four asked', miss.length, 4);
const ask = EO.askText(miss, y, '');
eq('one message asking for all of them', /full name/.test(ask) && /email/.test(ask) && /phone/.test(ask) && /delivery date and time/.test(ask) && /in one email/.test(ask), true);

console.log('the customer writes directly');
const z = EO.extract('Hi, please place the order. Deliver Thursday Oct 1 at 2pm, 10% tip.\nInstructions: loading dock on Water St\n\nJane Roe\nCell: (617) 555-0142', { name: 'Jane Roe', email: 'Jane@Acme.com' }, now);
eq('sender is the customer', [z.name, z.email, z.phone, z.source], ['Jane Roe', 'jane@acme.com', '(617) 555-0142', 'sender']);
eq('delivery phrase found', z.when, 'Thursday Oct 1 at 2pm');
eq('tip 10%', z.tip, { pct: 10 });
eq('instructions', z.instructions, 'loading dock on Water St');
eq('"no tip"', EO.tipIn('no tip please'), { pct: 0 });
eq('"$20 tip"', EO.tipIn('add a $20 tip'), { amount: 20 });

console.log('the answer email fills the gaps (typed fields)');
const w = EO.extract('Name: Natalia Diaz\nPhone: 781-555-0100\nEmail: natalia@gen2.example\nDeliver Friday Oct 2 at 11am', sean, now);
eq('typed fields', [w.name, w.email, w.phone, w.when], ['Natalia Diaz', 'natalia@gen2.example', '(781) 555-0100', 'Friday Oct 2 at 11am']);
eq('a date with no hour is not a delivery time', EO.findWhen(['deliver Thursday please'], now), '');

console.log("Sean's real follow-up (Sep 29): a date without a time, and who gets the link");
const seanFU = "Rachel, \n\nCan you please send dipanjan@getbevvi.com a payment link to process this order? \n\nAlso, note the delivery date is Monday, October 5th. \n\nThanks";
const f = EO.extract(seanFU, sean, now);
eq('the command is seen', EO.isOrderCommand(seanFU), true);
eq('date kept, no time', [f.when, f.date, f.time], ['', 'Monday, October 5th', '']);
eq('link recipient', f.link_to, ['dipanjan@getbevvi.com']);
eq('the ask names the date and asks only for the time', EO.missing({ name: 'Natalia Diaz', email: 'n@x.com', phone: '1', delivery_date: 'Monday, October 5th', delivery_date_label: 'Mon, Oct 5' }), ['the delivery time on Mon, Oct 5']);
eq('"earlier today" is not a delivery date', EO.timing(['the proposal curated for Gen II Fund earlier today?'], now).date, '');
eq('a time alone', EO.timing(['2pm works'], now), { when: '', date: '', time: '2pm' });
eq('"send the payment link to a@b.com"', EO.linkRecipients('Please send the payment link to ap@gen2.example and me.'), ['ap@gen2.example']);
eq('an address not about the link is not a recipient', EO.linkRecipients('Invoice questions go to ap@gen2.example.'), []);

console.log('delivery date/time phrasings (checked on real wording, Sep 29) -> the hour Rachel will check');
{
  const chrono = require('chrono-node');
  const hourOf = x => { const t = EO.timing(x.split('\n'), now); const ph = t.when || (t.date && t.time ? t.date + ' at ' + t.time : ''); const r = ph && chrono.parse(ph.replace(/\b(ET|EST|EDT)\b/g, ''), now, { forwardDate: true })[0]; return r ? r.start.get('month') + '/' + r.start.get('day') + ' ' + r.start.get('hour') + ':' + String(r.start.get('minute')).padStart(2, '0') : null; };
  const cases = [
    ["Sean's email: 'Delivery Date: Monday, Oct 5th' + 'Delivery Time: noon - 2pm ET'", 'Delivery Date: Monday, Oct 5th\nDelivery Time: noon - 2pm ET', '10/5 12:00'],
    ['Oct 5 at 2pm', 'Please deliver Oct 5 at 2pm', '10/5 14:00'],
    ['10/5 at 11:30am', 'deliver 10/5 at 11:30am', '10/5 11:30'],
    ['a range starts at its start: between 2 and 4pm', 'next Friday between 2 and 4pm', '10/9 14:00'],
    ['1-2pm', 'Monday 10/5, 1-2pm', '10/5 13:00'],
    ['11-1pm is 11am', 'Oct 5, 11-1pm', '10/5 11:00'],
    ['12-2 with no am/pm is noon', 'Monday Oct 5 anytime between 12-2', '10/5 12:00'],
    ['a bare "at 3" is 3pm', 'tomorrow at 3', '9/30 15:00'],
    ['a bare "at 11" is 11am', 'Monday at 11', '10/5 11:00'],
    ['"the 5th" is the next 5th', 'deliver on the 5th at 2pm', '10/5 14:00'],
    ['ISO date', 'delivery 2026-10-05 at 2pm', '10/5 14:00'],
    ['vague time: date kept, time asked', 'Thursday morning', null],
    ['a street number is not a time', 'order #3 at 5 Main St', null],
    ['"Suite 10-5" is not a time', 'Suite 10-5', null],
  ];
  for (const [label, text, want] of cases) eq(label, hourOf(text), want);
}

// Oct 3, Foodie For All: the instructions start on the label's own line.
eq('instructions on the same line as the label', EO.extract('*Please see the delivery instructions below:Main POC is Mara **(862)\n252-5077 <8622525077>**. Say you are delivering from Foodie For All.*\n*Freight: loading dock on your left.*\n\nThanks!', { email: 'sean@getbevvi.com' }, new Date()).instructions, 'Main POC is Mara (862) 252-5077. Say you are delivering from Foodie For All. Freight: loading dock on your left.');

console.log(failed ? '\nemail-order: ' + failed + ' FAILED' : '\nemail-order: all passed');
if (failed) process.exit(1);
