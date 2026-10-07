// catalog-api.js — both catalog APIs give callers the same rows (DC, Oct 7: move to getProducts, staging first).
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const load = m => { process.env.CATALOG_API = m; delete require.cache[require.resolve('../../catalog-api.js')]; return require('../../catalog-api.js'); };
const L = load('legacy');
eq('legacy: zip url keeps client + searchBy', /searchCorpProducts\?zipcode=10019&searchBy=Tito's&limit=100&client=bevvibot/.test(decodeURIComponent(L.catalogUrl({ zip: '10019', q: "Tito's" }).url)), true);
eq('legacy: rows are the array as is', L.rowsFrom([{ name: 'A' }], 'legacy', {}), [{ name: 'A' }]);
const N = load('getproducts');
const u = N.catalogUrl({ zip: '94104', q: 'Stella Artois', limit: 50 });
eq('getProducts: zip url (name=, page, limit)', [u.mode, /getProducts\?zipcode=94104&name=Stella%20Artois&page=1&limit=50$/.test(u.url)], ['getproducts', true]);
eq('getProducts: a location= search stays on legacy', N.catalogUrl({ location: 'Celonis - NYC', q: 'x' }).mode, 'legacy');
const body = { success: true, count: 3, products: [
  { name: 'Cheap', salePrice: 5, url: 'https://nuveen.getbevvi.com/productdetail/a' },
  { name: 'Mid', price: 20, url: 'https://airculinaire.getbevvi.com/productdetail/b' },
  { name: 'Dear', salePrice: 90 }] };
eq('getProducts: unwrapped, links on bevvibot like legacy', N.rowsFrom(body, 'getproducts', {}).map(p => p.url || ''), ['https://bevvibot.getbevvi.com/productdetail/a', 'https://bevvibot.getbevvi.com/productdetail/b', '']);
eq('getProducts: min/max applied here (the API has none)', N.rowsFrom(body, 'getproducts', { min: 10, max: 50 }).map(p => p.name), ['Mid']);
eq('getProducts: no store = no rows', N.rowsFrom({ message: 'no store found for zipcode: 02210' }, 'getproducts', { zip: '02210' }), []);
eq('getProducts: a broken body = no rows', N.rowsFrom(null, 'getproducts', {}), []);
delete process.env.CATALOG_API;
console.log(failed ? '\ncatalog-api: ' + failed + ' FAILED' : '\ncatalog-api: all passed');
if (failed) process.exit(1);
