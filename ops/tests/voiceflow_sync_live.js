#!/usr/bin/env node
// Live check that Rachel's event builder (store-agent menu_build / custom_list -> rachel/functions.js) behaves like the
// Voiceflow agent after the Oct 21 change set (DC: every channel the same). Read-only catalog searches; QA identity.
//   SA_URL=http://127.0.0.1:8301/mcp node ops/tests/voiceflow_sync_live.js     (staging shopping-agent from the working tree)
// Default is production's :8300.
const SA = process.env.SA_URL || 'http://127.0.0.1:8300/mcp';
const EMAIL = 'qa-voiceflow-sync@getbevvi.com';
let failed = 0, passed = 0;

async function call(intent, args) {
  const res = await fetch(SA, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: intent, arguments: Object.assign({ email: EMAIL }, args) } }) });
  const line = (await res.text()).split('\n').find(l => l.startsWith('data:'));
  if (!line) throw new Error('no response from ' + SA);
  return JSON.parse(JSON.parse(line.slice(5)).result.content[0].text);
}
const items = r => typeof r.line_items === 'string' ? JSON.parse(r.line_items || '[]') : (r.line_items || []);
const sum = (ls, f) => ls.filter(f).reduce((s, l) => s + (+l.qty || 0), 0);
const spirits = ls => ls.filter(l => l.category === 'spirits');
async function check(id, fn) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log('  ✓ ' + id + ' (' + Math.round((Date.now() - t0) / 1000) + 's)'); }
  catch (e) { failed++; console.log('  ✗ ' + id + ': ' + e.message); }
}
function ok(c, what) { if (!c) throw new Error(what); }
const STMT = (g, h) => new RegExp('^This package delivers about (\\d+) drinks per person for your ' + g + ' guests' + (h ? ' over ' + h + ' hours?' : '') + ' \\(about (\\d+) drinks total\\)\\.$');
function stmtOk(r, g, h) {
  const m = String(r.drinks_statement || '').match(STMT(g, h));
  ok(m, 'drinks_statement: ' + JSON.stringify(r.drinks_statement));
  ok(+m[2] === +m[1] * g, 'total is not N x guests: ' + r.drinks_statement);
  ok(r.why_drinks_statement, 'no why_drinks_statement');
}
function headingOk(r) {
  const ls = items(r), w = sum(ls, l => l.category === 'wine');
  if (!w) return;
  ok(new RegExp('^WINE — ' + w + ' bottles? \\(').test(r.wine_heading || ''), 'wine_heading ' + JSON.stringify(r.wine_heading) + ' vs ' + w + ' wine bottles');
}
const ALL = ['wine', 'beer', 'spirits'];

(async () => {
  console.log('Rachel event builder vs the Voiceflow change set — ' + SA);
  await check('SF 20 guests / 2 h / $500: 4 spirit types (60 drinks), Mi Campo tequila, statement + heading', async () => {
    const r = await call('menu_build', { guests: 20, hours: 2, budget: 500, categories: ALL, zip: '94104' });
    const sp = spirits(items(r));
    ok(sp.map(l => l.label).sort().join(',') === 'Bourbon,Gin,Tequila,Vodka', 'spirit types ' + sp.map(l => l.label).join(','));
    ok(/mi campo/i.test((sp.find(l => l.label === 'Tequila') || {}).name), 'tequila ' + (sp.find(l => l.label === 'Tequila') || {}).name);
    ok(!r.full_bar_note, 'full-bar note on a 4-type bar: ' + r.full_bar_note);
    stmtOk(r, 20, 2); headingOk(r);
  });
  await check('SF 10 guests / 2 h / $400: 3 spirit types (tequila, vodka, bourbon)', async () => {
    const r = await call('menu_build', { guests: 10, hours: 2, budget: 400, categories: ALL, zip: '94104' });
    ok(spirits(items(r)).map(l => l.label).sort().join(',') === 'Bourbon,Tequila,Vodka', 'spirit types ' + spirits(items(r)).map(l => l.label).join(','));
    stmtOk(r, 10, 2);
  });
  await check('SF 40 guests / 3 h / $2500: full bar of 5, Mi Campo, wine heading', async () => {
    const r = await call('menu_build', { guests: 40, hours: 3, budget: 2500, categories: ALL, zip: '94104' });
    const sp = spirits(items(r));
    ok(sp.length === 5, 'spirit types ' + sp.length);
    ok(/mi campo/i.test((sp.find(l => l.label === 'Tequila') || {}).name), 'tequila');
    // Oct 21 live: the gin slot took "Disaronno Originale Amaretto" ("gin" inside a word), the vodka slot "Grey Goose La Poire".
    const gin = (sp.find(l => l.label === 'Gin') || {}).name || '', vodka = (sp.find(l => l.label === 'Vodka') || {}).name || '';
    ok(/\bgin\b/i.test(gin) && !/amaretto|liqueur/i.test(gin), 'gin ' + gin);
    ok(!/poire|pear|flavou?r|citron|vanilla|peach|berry/i.test(vodka), 'vodka ' + vodka);
    stmtOk(r, 40, 3); headingOk(r);
  });
  await check('SF 50 guests / 2 h / $1500, wine_lean white: white > red', async () => {
    const ls = items(await call('menu_build', { guests: 50, hours: 2, budget: 1500, categories: ALL, zip: '94104', wine_lean: 'white' }));
    const red = sum(ls, l => l.label === 'Red Wine'), white = sum(ls, l => l.label === 'White Wine');
    ok(white > red, 'red ' + red + ' / white ' + white);
  });
  await check('SF 40 guests / 3 h / $2500, mix_bias spirits: 5 types x 2', async () => {
    const ls = items(await call('menu_build', { guests: 40, hours: 3, budget: 2500, categories: ALL, zip: '94104', mix_bias: 'spirits' }));
    const sp = spirits(ls);
    // 2 bottles' worth of each type (a 1.75 L counts as 2.3 x 750 mL — the builder sizes by volume)
    const ml = l => { const m = String(l.name + ' ' + (l.size || '')).toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|l)\b/); return m ? (m[2] === 'l' ? +m[1] * 1000 : +m[1]) : 750; };
    ok(sp.length === 5 && sp.every(l => l.qty * ml(l) >= 1400), 'spirits ' + sp.map(l => l.qty + 'x ' + l.label + ' (' + ml(l) + ' mL)').join(', '));
    ok(sum(ls, l => l.category === 'wine') > 0 && sum(ls, l => l.category === 'beer') > 0, 'wine/beer missing');
  });
  await check('SF 40 guests / 3 h / $2500, mix_bias beer>wine: beer servings > wine servings', async () => {
    const ls = items(await call('menu_build', { guests: 40, hours: 3, budget: 2500, categories: ALL, zip: '94104', mix_bias: 'beer>wine' }));
    const beer = ls.filter(l => l.category === 'beer').reduce((s, l) => s + l.qty * (+(String(l.size || l.name).match(/(\d+)\s*x/i) || [0, 12])[1]), 0);
    const wine = sum(ls, l => l.category === 'wine') * 5;
    ok(beer > wine, 'beer ' + beer + ' vs wine ' + wine + ' servings');
  });
  await check('NYC 30 guests / 3 h / $1500: tequila is Mi Campo (Reposado 750 — no Blanco 750 there)', async () => {
    const sp = spirits(items(await call('menu_build', { guests: 30, hours: 3, budget: 1500, categories: ALL, zip: '10019' })));
    ok(/mi campo/i.test((sp.find(l => l.label === 'Tequila') || {}).name), 'tequila ' + (sp.find(l => l.label === 'Tequila') || {}).name);
  });
  await check('Boston margaritas + mojitos (custom_list): Mi Campo, soda water not tonic, mint not food', async () => {
    const r = await call('custom_list', { guests: 30, hours: 3, budget: 1500, zip: '02110', named_products: [
      { name: 'Tequila', category: 'spirits' }, { name: 'Triple Sec', category: 'spirits' }, { name: 'White Rum', category: 'spirits' },
      { name: 'Lime Juice', category: 'mixer' }, { name: 'Soda Water', category: 'mixer' }, { name: 'Mint', category: 'mixer' }] });
    const ls = items(r);
    ok(/mi campo/i.test((ls.find(l => l.label === 'Tequila') || {}).name), 'tequila ' + (ls.find(l => l.label === 'Tequila') || {}).name);
    const soda = ls.find(l => l.label === 'Soda Water');
    ok(!soda || !/tonic/i.test(soda.name), 'Soda Water -> ' + (soda && soda.name));
    const mint = ls.find(l => l.label === 'Mint');
    ok(!mint || !/cookie|oreo|candy|chocolate|gum/i.test(mint.name), 'Mint -> ' + (mint && mint.name));
    ok(!ls.some(l => /^mixer/i.test(l.category) && /coca|coke|pepsi|sprite/i.test(l.name)), 'soft drink in a mixer line');
    stmtOk(r, 30, 3);
  });
  console.log('\n' + passed + '/' + (passed + failed) + ' passed');
  process.exit(failed ? 1 : 0);
})();
