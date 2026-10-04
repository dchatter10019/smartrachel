// Unit tests for serving-mix.js — the customer's drink mix for an event. (precheck.sh runs qa/unit/*.test.js.)
const S = require('../../serving-mix.js');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const mix = (t, c) => { const r = S.parseServingMix(t, c || ['beer', 'wine'], false); return r && Object.fromEntries(Object.entries(r.mix).map(([k, v]) => [k, Math.round(v * 100)])); };
eq('"60 pct wine, 40 pct beer" (Oct 4, claude.ai connector — was read as 50/50)', mix('60 pct wine, 40 pct beer'), { beer: 40, wine: 60 });
eq('"60 percent wine"', mix('60 percent wine'), { beer: 40, wine: 60 });
eq('"60/40 wine/beer"', mix('60/40 wine/beer'), { beer: 40, wine: 60 });
eq('"70-30 beer to wine"', mix('70-30 beer to wine'), { beer: 70, wine: 30 });
eq('"wine 70%, beer 30%" (number after the drink was NaN)', mix('wine 70%, beer 30%'), { beer: 30, wine: 70 });
eq('"50% wine" with three types', mix('50% wine', ['beer', 'wine', 'spirits']), { beer: 25, wine: 50, spirits: 25 });
eq('"mostly wine" unchanged', mix('mostly wine'), { beer: 35, wine: 65 });
console.log(failed ? '\nserving-mix: ' + failed + ' FAILED' : '\nserving-mix: all passed');
if (failed) process.exit(1);
