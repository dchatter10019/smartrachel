// The Bevvi catalog search, one place for every caller (DC, Oct 7: move to the getProducts API, staging first).
//   legacy      — api-client.getbevvi.com/api/corpproducts/searchCorpProducts (zipcode= | location=, searchBy=, client=)
//   getproducts — dev-api-lb4.getbevvi.com/api/corpproducts/getProducts (zipcode=, name=, page=, limit=; a production
//                 server despite the name). Fuzzy matching ("Titos", "chardonay"), subCategory/varietal filled, rows wrapped
//                 in {success, count, products}; no client param; no min/max (filtered here); zip only — a location=
//                 search (old kitchen fallbacks) stays on legacy.
// CATALOG_API picks one (default legacy); CATALOG_API_URL overrides the getProducts host. Rows come back in the legacy
// shape (a plain array) so callers don't change: product links rewritten to bevvibot.getbevvi.com like the legacy API.
const LEGACY = 'https://api-client.getbevvi.com';
const mode = () => String(process.env.CATALOG_API || 'legacy').toLowerCase() === 'getproducts' ? 'getproducts' : 'legacy';
const newBase = () => process.env.CATALOG_API_URL || 'https://dev-api-lb4.getbevvi.com';

// { zip | location, q, limit, client, min, max } -> { url, mode }
function catalogUrl(o) {
  const limit = o.limit || 100, q = String(o.q || '');
  if (mode() === 'getproducts' && o.zip) {
    return { mode: 'getproducts', url: newBase() + '/api/corpproducts/getProducts?zipcode=' + encodeURIComponent(o.zip) + '&name=' + encodeURIComponent(q) + '&page=1&limit=' + limit };
  }
  const where = o.zip ? 'zipcode=' + encodeURIComponent(o.zip) : 'location=' + encodeURIComponent(o.location || '');
  return { mode: 'legacy', url: LEGACY + '/api/corpproducts/searchCorpProducts?' + where + '&searchBy=' + encodeURIComponent(q) + '&limit=' + limit +
    '&client=' + encodeURIComponent(o.client || 'bevvibot') + (o.min > 0 ? '&min=' + o.min : '') + (o.max > 0 && o.max < 9999 ? '&max=' + o.max : '') };
}

// The response body -> legacy-shaped rows (array). getProducts: unwrap, rewrite links, price window applied here.
function rowsFrom(body, m, o) {
  if (m === 'legacy') return Array.isArray(body) ? body : [];
  if (!body || body.success === false || !Array.isArray(body.products)) {
    if (body && body.message) console.log('[catalog-api] getProducts: ' + String(body.message).slice(0, 120) + ' (' + (o.zip || '') + ' ' + JSON.stringify(String(o.q || '')).slice(0, 60) + ')');
    return [];
  }
  const price = p => Number(p.salePrice || p.price || 0);
  return body.products
    .map(p => p.url ? Object.assign({}, p, { url: String(p.url).replace(/^https:\/\/[a-z0-9-]+\.getbevvi\.com\//i, 'https://bevvibot.getbevvi.com/') }) : p)
    .filter(p => !(o.min > 0 && price(p) < o.min) && !(o.max > 0 && o.max < 9999 && price(p) > o.max));
}

// One request: { ok, status, why, rows, url, mode }. Callers keep their own retries.
async function catalogFetch(o) {
  const { url, mode: m } = catalogUrl(o);
  let res;
  try { res = await fetch(url); } catch (e) { return { ok: false, status: 0, why: e.message, rows: [], url, mode: m }; }
  if (!res.ok) return { ok: false, status: res.status, why: 'HTTP ' + res.status, rows: [], url, mode: m };
  const body = await res.json().catch(() => null);
  return { ok: true, status: res.status, why: '', rows: rowsFrom(body, m, o), url, mode: m };
}

console.log('[catalog-api] catalog search: ' + (mode() === 'getproducts' ? 'getProducts (' + newBase() + ')' : 'legacy searchCorpProducts'));

module.exports = { catalogUrl, catalogFetch, rowsFrom, mode };
