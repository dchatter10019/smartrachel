// Per-bottle price wordings (bottle-price.js). Nov 14 (DC, HI USA forward): "The wines should not be more than $15" was not
// read and the proposal had Cloudy Bay $37 / Belle Glos $51 (earlier forwards said "not more than" / "not exceed").
const BP = require('../../bottle-price.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const cap = (t, max) => { const r = BP.read(t); return !!r && r.max === max && r.min === 0 && r.category === 'wine'; };
ok('"The wines should not be more\\nthan $15"', cap('check the email below and create a proposal. The wines should not be more\nthan $15. Yes I am 21', 15));
ok('"shouldn\'t cost over $18"', cap("the wine shouldn't cost over $18", 18));
ok('"no higher than $25"', cap('wine bottles no higher than $25', 25));
ok('"must not go above $20"', cap('the wines must not go above $20 a bottle', 20));
ok('the old wordings still read', cap('wine bottles not more than $15', 15) && cap('The wine bottles should not exceed $15.', 15) && cap('wines under $15', 15));
ok('a budget is not a bottle price', BP.read('budget is not more than $500 total') === null);
ok('"more than 20 bottles at $15" is not a cap', BP.read('we need more than 20 bottles at $15') === null);
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
