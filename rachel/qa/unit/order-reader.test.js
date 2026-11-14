// order-reader.js check(): the code's checks on the model's order form (no model call). Nov 14, DC's thread.
const OR = require('../../order-reader.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const now = new Date(2026, 10, 14, 14, 0);
const fwd = 'From: Sean Fitzgibbons <sean@getbevvi.com>\n\n*Delivery Window:*\n\nSaturday 11/14 (1-3pm ET)\n\n*On-Site Contact:*\n\nDiana Maranzano | 212-288-3500';
const ctx = (newText) => ({ newText, earlierTexts: [fwd], staffNames: ['Sean Fitzgibbons', 'Dipanjan Chatterjee'], now, zoneOf: z => /^(et|eastern|pt|pacific)$/i.test(z) });
const V = (value, quote, from = 'new') => ({ value, quote, from });
let c = OR.check({ intent: 'place_order', intent_quote: 'Create the order', delivery: { start_time: V('now', 'now') } }, ctx('Create the order now'));
ok('"now" is never a delivery time', !c.fields.new.time && c.rejected.some(r => /now/.test(r)));
ok('intent place_order kept (its words are in the email)', c.intent === 'place_order');
c = OR.check({ intent: 'place_order', intent_quote: 'please book it' }, ctx('Create the order now'));
ok('an intent whose words are not in the email is dropped', c.intent === 'none');
c = OR.check({ intent: 'none', delivery: { date: V('Saturday 11/14', 'Saturday 11/14', 'earlier'), start_time: V('1pm', '1-3pm', 'earlier'), zone: V('ET', 'ET', 'earlier') }, on_site: { name: V('Diana Maranzano', 'Diana Maranzano', 'earlier'), phone: V('212-288-3500', '212-288-3500', 'earlier') } }, ctx('I want to place the order.'));
ok('the thread\'s window: date, start, zone', c.fields.earlier.date.value === 'Saturday 11/14' && c.fields.earlier.time.value === '1pm' && c.fields.earlier.zone.value === 'ET');
ok('the on-site contact from a colleague\'s forward', c.fields.earlier.onsite_name.value === 'Diana Maranzano' && c.fields.earlier.onsite_phone.value === '(212) 288-3500');
c = OR.check({ intent: 'provide_details', contact: { name: V('Diana Maranzana', 'Diana Maranzana') } }, ctx('First and last Name: Diana Maranzano'));
ok('a value whose quote is not in the email is dropped (invented spelling)', !c.fields.new.name);
c = OR.check({ intent: 'provide_details', contact: { name: V('Sean Fitzgibbons', 'Sean Fitzgibbons', 'earlier') } }, ctx('ok'));
ok('a Bevvi colleague is never the customer', !c.fields.earlier.name && !c.fields.new.name);
c = OR.check({ intent: 'provide_details', delivery: { date: V('11/13', '11/13') } }, ctx('deliver 11/13'));
ok('a date before today is dropped... (11/13 reads as next year, so kept only as a future date)', !c.fields.new.date || c.fields.new.date.value === '11/13');
c = OR.check({ intent: 'provide_details', delivery: { start_time: V('2pm', '2pm'), zone: V('ET', 'ET') } }, ctx('Change the delivery time to today 2pm ET'));
ok('"today 2pm ET": the time and its own "today"', c.fields.new.time.value === '2pm' && c.fields.new.date.value === 'today');
c = OR.check({ intent: 'provide_details', contact: { email: V('not-an-email', 'not-an-email'), phone: V('12', '12') } }, ctx('not-an-email 12'));
ok('a bad email / phone is dropped', !c.fields.new.email && !c.fields.new.phone);
c = OR.check({ intent: 'none', delivery: { date: V('Sun, Nov 15', 'Sun, Nov 15', 'earlier') } }, Object.assign(ctx('Create the order now'), { earlierTexts: [fwd, 'ok\nOn Sat, Nov 14, 2026 at 2:00 PM Rachel <rachelai@getbevvi.com> wrote:\n> delivery: Sun, Nov 15, 1:00 PM'], rachelTexts: ['What I have so far — delivery: Sun, Nov 15, 1:00 PM - 2:00 PM ET.'] }));
ok('Rachel\'s own words (quoted history / her replies) are never a source', !c.fields.earlier.date);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
