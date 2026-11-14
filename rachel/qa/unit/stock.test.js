// Store stock vs quantities (stock.js; DC, Nov 14): a product the customer NAMED with a quantity the store can't cover is
// kept at what the store has + similar products offered for the rest; Rachel's own picks only use products with enough.
// (precheck runs qa/unit.)
const S = require('../../stock.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };

ok('inventory read; missing = unknown', S.inv({ inventory: 41 }) === 41 && S.inv({}) === null && S.inv({ inventory: null }) === null);
ok('unknown counts as enough', S.enough({}, 50) && !S.enough({ inventory: 41 }, 50) && S.enough({ inventory: 50 }, 50));

process.env.RACHEL_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/stock-test-');
const flat = Array.from({ length: 12 }, (_, i) => ({ name: 'Tequila ' + i, inventory: 10, establishmentId: 'BOS' })).concat([{ name: 'Oyster Bay', inventory: 0, establishmentId: 'BOS' }]);
const fr = S.ignorePlaceholders(flat, 'tequila');
ok('a store whose in-stock rows all show 10 = placeholder (Boston); 0 stays out of stock', fr.slice(0, 12).every(r => r.inventory === null) && fr[12].inventory === 0);
ok('remembered for that store: a 2-row search of it reads 10 as unknown', S.ignorePlaceholders([{ name: 'Josh', inventory: 10, establishmentId: 'BOS' }, { name: 'X', inventory: 0, establishmentId: 'BOS' }], 'x').map(r => r.inventory).join() === ',0');
const real = Array.from({ length: 12 }, (_, i) => ({ name: 'V' + i, inventory: i + 1, establishmentId: 'NYC' }));
ok('real, varied counts are kept', S.ignorePlaceholders(real, 'vodka')[3].inventory === 4);
ok('another store\'s 10 is a real count', S.ignorePlaceholders([{ name: 'Y', inventory: 10, establishmentId: 'NYC' }], 'y')[0].inventory === 10);
ok('grapefruit is never "similar" to black cherry', !S.similar({ name: 'High Noon Grapefruit 4 x 12 OZ Cans', price: 10, sizeStr: '4 x 12 OZ' }, [{ name: 'High Noon Black Cherry 4 x 12 OZ Cans', price: 10, sizeStr: '4 x 12 OZ', inventory: 40 }], 5).length);
const titos = { name: "Tito's Handmade Vodka - 750 ML", price: 24.19, sizeStr: '750ML', product_id: 'T', category: 'Liquor', subCategory: 'Vodka', inventory: 41 };
const pool = [
  titos,
  { name: 'Absolut Vodka - 750 ML', price: 22.99, sizeStr: '750ML', product_id: 'A', category: 'Liquor', subCategory: 'Vodka', inventory: 60 },
  { name: 'Ketel One Vodka - 750 ML', price: 27.49, sizeStr: '750ML', product_id: 'K', category: 'Liquor', subCategory: 'Vodka', inventory: 5 },
  { name: 'Grey Goose Vodka - 1 L', price: 39.99, sizeStr: '1L', product_id: 'G', category: 'Liquor', subCategory: 'Vodka', inventory: 90 },
  { name: 'Bacardi Superior Rum - 750 ML', price: 18.58, sizeStr: '750ML', product_id: 'B', category: 'Liquor', subCategory: 'Rum', inventory: 90 },
  { name: 'Smirnoff No. 21 Vodka - 750 ML', price: 15.99, sizeStr: '750ML', product_id: 'S', category: 'Liquor', subCategory: 'Vodka' },
];
const sim = S.similar(titos, pool, 9);
ok('similar: same type + size, enough for the rest, known counts first: ' + sim.map(p => p.name).join(' | '),
  sim[0].name.startsWith('Absolut') && !sim.some(p => /Ketel|Grey Goose|Bacardi|Tito/.test(p.name)) && sim.some(p => /Smirnoff/.test(p.name)));
ok('offered as "with N in stock": known counts only', S.similar(titos, pool, 9, { knownOnly: true }).every(p => p.inventory !== null && p.inventory !== undefined));

(async () => {
  const byId = Object.fromEntries(pool.map(p => [p.product_id, p]));
  const search = async () => pool;
  // Named: 50 Tito's asked, 41 in stock.
  const generic = await S.enforce([{ label: 'Vodka', name: titos.name, qty: 50, price: 24.19, size: '750ML', product_id: 'T', match: { kind: 'exact' }, customer_qty: true }], { rowFor: l => byId[l.product_id], search: async () => pool });
  ok('"50 bottles vodka" (no brand) = Rachel\'s pick, swapped to one with enough', generic.lines[0].name.startsWith('Absolut') && !generic.short.length);
  const named = await S.enforce([{ label: "Tito's 750 ML", name: titos.name, qty: 50, price: 24.19, size: '750ML', product_id: 'T', match: { kind: 'exact' }, customer_qty: true }], { rowFor: l => byId[l.product_id], search });
  ok('named: kept at what the store has (41)', named.lines.length === 1 && named.lines[0].qty === 41 && named.lines[0].name === titos.name);
  ok('named: short reported with similar for the other 9', named.short.length === 1 && named.short[0].need === 9 && named.short[0].similar[0].name.startsWith('Absolut'));
  const note = S.noteFor(named.short);
  ok('note says the store has only 41, you asked 50, numbered similar: ' + JSON.stringify(note.slice(0, 120)), /only 41 in stock \(you asked for 50\)/.test(note) && /\n1\. Absolut/.test(note) && /add 9 of it/.test(note) && /similar ones in stock/.test(note));
  // Rachel's pick: a generic vodka slot needing 50 — swapped to one that has 50+.
  const pick = await S.enforce([{ label: 'vodka', name: titos.name, qty: 50, price: 24.19, size: '750ML', product_id: 'T' }], { rowFor: l => byId[l.product_id], search });
  ok('pick: swapped whole to a product with enough (Absolut 60)', pick.lines.length === 1 && pick.lines[0].name.startsWith('Absolut') && pick.lines[0].qty === 50 && !pick.short.length);
  // Rachel's pick, nothing big enough: split.
  const small = pool.map(p => Object.assign({}, p, { inventory: p.product_id === 'S' ? 4 : p.inventory === undefined ? 4 : Math.min(p.inventory, 30) }));
  const byId2 = Object.fromEntries(small.map(p => [p.product_id, p]));
  const split = await S.enforce([{ label: 'vodka', name: titos.name, qty: 50, price: 24.19, size: '750ML', product_id: 'T' }], { rowFor: l => byId2[l.product_id], search: async () => small });
  ok('pick: split across similar when none covers it: ' + split.lines.map(l => l.qty + 'x ' + l.name).join(' + '), split.lines.reduce((a, l) => a + l.qty, 0) >= 50 && split.lines[0].qty === 30);
  // Mi Campo is never swapped away — split instead.
  const mc = { name: 'Mi Campo Blanco Tequila - 750 ML', price: 19.99, sizeStr: '750ML', product_id: 'M', subCategory: 'Tequila', inventory: 6 };
  const mcPool = [mc, { name: 'Espolon Blanco Tequila - 750 ML', price: 22.99, sizeStr: '750ML', product_id: 'E', subCategory: 'Tequila', inventory: 40 }];
  const mcR = await S.enforce([{ label: 'tequila', name: mc.name, qty: 10, price: 19.99, size: '750ML', product_id: 'M' }], { rowFor: l => mcPool.find(p => p.product_id === l.product_id), search: async () => mcPool });
  ok('Mi Campo kept at 6 + 4 Espolon (never swapped away)', mcR.lines[0].name === mc.name && mcR.lines[0].qty === 6 && mcR.lines[1] && mcR.lines[1].qty === 4);
  // Matched exactly but the quantity is Rachel's (an event / cocktail line): her pick -> swapped, never a "you asked for" note.
  const rp = await S.enforce([{ name: titos.name, qty: 50, price: 24.19, size: '750ML', product_id: 'T', match: { kind: 'exact' } }], { rowFor: l => byId[l.product_id], search });
  ok('exact match without the customer\'s quantity = Rachel\'s pick (swapped, no note)', rp.lines[0].name.startsWith('Absolut') && !rp.short.length);
  const pn = { name: 'Joseph Phelps Pinot Noir - 750 ML', price: 60, sizeStr: '750ML', subCategory: 'Red Wine', inventory: 0 };
  ok('a Cabernet is never similar to a Pinot Noir', !S.similar(pn, [{ name: "Stags' Leap Cabernet Sauvignon - 750 ML", price: 60, sizeStr: '750ML', subCategory: 'Red Wine', inventory: 40 }], 3).length
    && !S.similar(pn, [{ name: 'La Rioja Alta Viña Ardanza Reserva Rioja - 750 ML', price: 60, sizeStr: '750ML', subCategory: 'Red Wine', inventory: 11 }], 3).length
    && S.similar(pn, [{ name: 'Belle Glos Pinot Noir - 750 ML', price: 55, sizeStr: '750ML', subCategory: 'Red Wine', inventory: 40 }], 3).length === 1);
  // Enough / unknown: untouched.
  const fine = await S.enforce([{ name: titos.name, qty: 10, product_id: 'T', match: { kind: 'exact' } }, { name: 'X', qty: 99, product_id: 'none' }], { rowFor: l => byId[l.product_id], search });
  ok('enough or unknown stock: lines untouched', fine.lines.length === 2 && fine.lines[0].qty === 10 && fine.lines[1].qty === 99 && !fine.short.length);
  if (failed) { console.log(failed + ' failed'); process.exit(1); }
  console.log('all passed');
})();
