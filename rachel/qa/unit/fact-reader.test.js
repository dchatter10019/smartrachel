// fact-reader.js code-side parts (no model call): when it reads, and how its answers become the code's shapes.
// (DC, Nov 14: the model understands the wording, the code enforces.) (precheck runs qa/unit.)
const FR = require('../../fact-reader.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
ok('reads a message with a price / date / fee / client / address / bottles-not-cases',
  ['The wines should not be more than $15', 'nothing pricier than twenty bucks a bottle', 'delivery is Thursday, November 19th', 'service fee 8 percent',
   'the client is Acme', 'deliver to 1335 6th Ave', 'we need 48 bottles not 48 cases'].every(FR.wants));
ok('never on a short reply or a plain pick', !['yes', '2', 'place the order', 'sounds good thanks', 'Kim Crawford please'].some(FR.wants));
const f = FR.feesShape({ tip_amount: 0, delivery_fee: 0, service_percent: 8 });
ok('fees -> tax-command shape', f.tip_amount === 0 && f.delivery_fee === 0 && f.service_rate === 0.08 && !('tax_rate' in f));
ok('tax exempt -> tax_rate 0', FR.feesShape({ tax_exempt: true }).tax_rate === 0 && FR.feesShape({ tax_percent: 8.875 }).tax_rate === 0.08875);
ok('no fees -> null', FR.feesShape({}) === null && FR.feesShape(null) === null);
const b = FR.bottleShape({ category: 'wine', max: 15 }, 'The wines should not be more than $15');
ok('bottle price -> bottle-price shape (cap, min 0)', b.category === 'wine' && b.max === 15 && b.min === 0 && b.via === 'model');
ok('"around" keeps its floor; bad min dropped', FR.bottleShape({ category: 'wine', max: 20, min: 12 }).min === 12 && FR.bottleShape({ category: 'spirits', max: 20, min: 30 }).min === 0);
ok('no max -> null', FR.bottleShape({ category: 'wine' }) === null);
ok('the prompt keeps the rules: per bottle only, corrections only, never sent dates', /NOT a total budget/.test(FR.system('x')) && /ONLY a CORRECTION/.test(FR.system('x')) && /Never an email's sent date/.test(FR.system('x')));
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
