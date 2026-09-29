// Unit tests for the Sep 29 "search issue" (Slack, zip 33409): core expressions ranked first,
// classifier JSON with trailing text, descriptor words are not a producer.
// (precheck.sh runs every qa/unit/*.test.js during lint — a failure blocks the deploy).
const { coreFirst, spaceSize } = require('../../../store-agent/core-first.js');
const { firstJson } = require('../../classify-intent.js');

let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const origLog = console.log;
const quiet = f => { console.log = () => {}; try { return f(); } finally { console.log = origLog; } };

console.log('core expressions first (Don Julio at 33409 — the real Bevvi order, price-sorted)');
{
  const rows = ['Don Julio Ultima Reserva Ex Anejo - 750 ML', 'Don Julio Primavera Reposado - 750 ML', 'Don Julio 1942 Tequila - 750 ML',
    'Don Julio Rosado - 750 ML', 'Don Julio Alma Miel Joven Tequila - 750 ML', 'Don Julio 70 Cristalino Tequila - 750 ML',
    'Don Julio Reposado Tequila - 750 ML', 'Don Julio Blanco Tequila - 750 ML'].map(name => ({ name }));
  eq('top 3 for "Don Julio Tequila 750 mL"', quiet(() => coreFirst('Don Julio Tequila 750 mL', rows)).slice(0, 3).map(p => p.name),
    ['Don Julio Reposado Tequila - 750 ML', 'Don Julio Blanco Tequila - 750 ML', 'Don Julio Ultima Reserva Ex Anejo - 750 ML']);
  eq('"Don Julio 1942" -> the 1942 first', quiet(() => coreFirst('Don Julio 1942 750 mL', rows))[0].name, 'Don Julio 1942 Tequila - 750 ML');
  const cas = [{ name: 'Casamigos Blanco - 750 ML' }, { name: 'Casamigos Anejo - 750 ML' }];
  eq('all-core list keeps its order', quiet(() => coreFirst('Casamigos Tequila 750 mL', cas)), cas);
}

console.log('a stated size ranks first; proof labels are not an expression (Sep 29 Grey Goose)');
{
  const gg = [{ name: 'Grey Goose Vodka - 1.75 L' }, { name: 'Grey Goose L\'Orange Vodka - 1 L' }, { name: 'Grey Goose Vodka 750 ML (80 Proof)' },
    { name: 'Grey Goose Vodka - 375 ML' }, { name: 'Grey Goose Vodka - 200 ML' }];
  eq('"Grey Goose 750ml" -> the 750 first', quiet(() => coreFirst('Grey Goose 750ml', gg))[0].name, 'Grey Goose Vodka 750 ML (80 Proof)');
  eq('no size -> plain bottles before L\'Orange', quiet(() => coreFirst('Grey Goose Vodka', gg)).map(p => p.name).indexOf("Grey Goose L'Orange Vodka - 1 L"), 4);
}

console.log('size spacing for Bevvi search ("750ml" returns nothing)');
{
  eq('750ml', spaceSize('Don Julio Tequila 750ml'), 'Don Julio Tequila 750 ml');
  eq('1.75L', spaceSize("Tito's 1.75L"), "Tito's 1.75 L");
  eq('already spaced', spaceSize('Casamigos 750 mL'), 'Casamigos 750 mL');
  eq('no size', spaceSize('Knob Creek 12 Year'), 'Knob Creek 12 Year');
}

console.log('classifier reply with text after the JSON');
{
  eq('JSON then a note', quiet(() => firstJson('{"intent":"change_instructions","confidence":0.8}\n\nNote: several changes.')), { intent: 'change_instructions', confidence: 0.8 });
  eq('nested braces', quiet(() => firstJson('{"intent":"other","ref":{"a":1}} trailing')), { intent: 'other', ref: { a: 1 } });
  eq('clean JSON', firstJson('{"intent":"other"}'), { intent: 'other' });
}

console.log('descriptor words are not a producer (rachel.js not-found GENERICW)');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../rachel.js'), 'utf8');
  const GENERICW = eval(src.match(/const GENERICW = (\/\^\(.*?\)\$\/i);/)[1]);
  const distinctive = q => q.toLowerCase().split(/[^a-z0-9']+/).filter(w => w.length >= 3 && !/^\d/.test(w) && !GENERICW.test(w));
  eq('"high end whiskey 750 mL" is generic', distinctive('high end whiskey 750 mL'), []);
  eq('"tequila mid top shelf" is generic', distinctive('tequila mid top shelf'), []);
  eq('"Macallan Scotch 750 mL" still checked', distinctive('Macallan Scotch 750 mL'), ['macallan']);
  eq('"High West Bourbon" still checked', distinctive('High West Bourbon'), ['west']);
}

console.log(failed ? '\nsearch-routing: ' + failed + ' FAILED' : '\nsearch-routing: all passed');
process.exit(failed ? 1 : 0);
