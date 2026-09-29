// Catalog guard: hide catalog rows whose price, name or size looks wrong, and tell the QA
// Slack channel so someone fixes the listing. Real examples that reached customers:
//   "Tito'S - 750 ML" at $8.79 beside "Tito's Handmade Vodka - 750 ML" at $24.19
//   "Veuve Clicquot Yellow Label Brut Champagne - 3 L" at $71.49, cheaper than the 1.5 L at $175.99
// Deterministic rules only, each compared against the other rows of the SAME search, and
// tuned to be conservative: hiding a good product costs a sale, so a rule needs a clear signal.
const fs = require('fs');

const ALERT_FILE = '/home/ubuntu/logs/catalog-anomalies.json';   // dedup: one alert per row+reason per day
const ALERT_EVERY_MS = 24 * 3600 * 1000;

// Slack creds live in /etc/rachel.env (the shopping-agent unit does not load it).
const env = {};
try {
  for (const line of fs.readFileSync('/etc/rachel.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
  }
} catch (e) { console.error('[catalog-guard] cannot read /etc/rachel.env — Slack alerts disabled:', e.message); }
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN || '';
const SLACK_CHANNEL = process.env.QA_SLACK_CHANNEL || env.QA_SLACK_CHANNEL || '';

const price = p => Number(p.salePrice || p.price || 0);

// ── Market price (web) ──────────────────────────────────────────────────────
// When the catalog lists the same product and size twice at different prices, the one to
// show is the one closest to the MARKET price: what retailers near the customer's zip charge
// for that exact bottle. Found by Claude with the server-side web search tool; the median of
// the prices found is cached per product+size+zip for a week. Never in the request path: a
// miss is looked up in the background and applies from the next search.
const MARKET_FILE = '/home/ubuntu/logs/market-prices.json';
const MARKET_TTL_MS = 7 * 24 * 3600 * 1000;
let MARKET = {}; try { MARKET = JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8')); } catch (e) {}
const inFlight = new Map();   // key -> promise of the running lookup, shared by concurrent searches
const ZIP_LOC = { '10019': { city: 'New York', region: 'New York', timezone: 'America/New_York' }, '02110': { city: 'Boston', region: 'Massachusetts', timezone: 'America/New_York' }, '94104': { city: 'San Francisco', region: 'California', timezone: 'America/Los_Angeles' } };
let _anthropic = null;
function anthropic() {
  if (!_anthropic) {
    const sdk = require('/home/ubuntu/rachel/node_modules/@anthropic-ai/sdk');
    _anthropic = new (sdk.Anthropic || sdk)({ apiKey: process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY, timeout: 120000, maxRetries: 1 });
  }
  return _anthropic;
}
const sizeLabel = ml => ml >= 1000 ? (Math.round(ml / 10) / 100) + ' L' : Math.round(ml) + ' mL';
async function webMarketPrice(name, ml, zip) {
  const prompt = 'Find current retail shelf prices in USD (before tax and delivery) for exactly this product: "' + name + '", ' + sizeLabel(ml) + ' bottle' +
    (zip ? ', at liquor stores or retailers that serve ZIP code ' + zip + ' (or the nearest city)' : ', at US retailers') + '. Use the same product and the same bottle size only — no other sizes, gift sets or multipacks. ' +
    'Find up to 5 prices from different retailers. Answer with ONLY a JSON object, no other text: {"prices":[{"price":<number>,"store":"<retailer>","url":"<page url>"}]}. If you find none, answer {"prices":[]}.';
  const loc = ZIP_LOC[zip] || {};
  const base = {
    model: 'claude-opus-5', max_tokens: 4000, output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: Object.assign({ type: 'approximate', country: 'US' }, loc) }]
  };
  const first = { role: 'user', content: prompt };
  let messages = [first], resp = null;
  for (let k = 0; k < 3; k++) {   // a long server-tool turn can pause; resume by sending the paused turn back
    resp = await anthropic().beta.messages.create(Object.assign({}, base, { messages }));
    if (resp.stop_reason !== 'pause_turn') break;
    messages = [first, { role: 'assistant', content: resp.content }];
  }
  if (!resp || resp.stop_reason === 'refusal') { console.log('[market] no answer (' + (resp && resp.stop_reason) + ') for "' + name + '"'); return null; }
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const jm = text.match(/\{[\s\S]*"prices"[\s\S]*\}/);
  if (!jm) { console.log('[market] unparseable answer for "' + name + '": ' + text.slice(0, 120)); return null; }
  let prices = [];
  try { prices = (JSON.parse(jm[0]).prices || []).filter(x => x && Number(x.price) > 0 && Number(x.price) < 20000).map(x => ({ price: Number(x.price), store: String(x.store || ''), url: String(x.url || '') })); } catch (e) { return null; }
  if (!prices.length) return { median: null, prices: [] };
  const sorted = prices.map(x => x.price).sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { median: Math.round(median * 100) / 100, prices };
}
const marketKey = (p, zip) => identity(p.name) + '|' + Math.round(volumeMl(p)) + '|' + (zip || '');
// Stale-while-revalidate: an entry older than the TTL is still used, and refreshed in the background.
function cachedMarket(p, zip) { const e = MARKET[marketKey(p, zip)]; return e ? Object.assign({ stale: Date.now() - e.at >= MARKET_TTL_MS }, e) : null; }
function lookupMarket(p, zip) {
  const key = marketKey(p, zip);
  if (inFlight.has(key)) return inFlight.get(key);
  const t0 = Date.now();
  const pr = webMarketPrice(p.name, volumeMl(p), zip).then(m => {
    if (m) {
      MARKET[key] = Object.assign({ at: Date.now() }, m);
      try { fs.writeFileSync(MARKET_FILE, JSON.stringify(MARKET)); } catch (e) {}
      console.log('[market] "' + p.name + '" ' + sizeLabel(volumeMl(p)) + ' near ' + (zip || 'US') + ': ' + (m.median ? '$' + m.median.toFixed(2) + ' median of ' + m.prices.length + ' web price(s)' : 'no prices found') + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
    }
    return m;
  }).catch(e => { console.error('[market] lookup failed for "' + p.name + '":', e.message); return null; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pr);
  return pr;
}

// Volume in ml from a size string: "750 ML", "1.5 L", "12x12 Oz", "24 x12 Oz bottle".
function parseMl(s) {
  s = String(s || '').toLowerCase();
  const pack = s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(ml|l|oz)\b/) || s.match(/(\d+)\s*(?:pk|pack)\s+(\d+(?:\.\d+)?)\s*(ml|l|oz)\b/);
  if (pack) return Number(pack[1]) * toMl(Number(pack[2]), pack[3]);
  const one = s.match(/(\d+(?:\.\d+)?)\s*(ml|l|oz|cl)\b/);
  return one ? toMl(Number(one[1]), one[2]) : 0;
}
function toMl(n, u) { return u === 'l' ? n * 1000 : u === 'oz' ? n * 29.5735 : u === 'cl' ? n * 10 : n; }
const volumeMl = p => parseMl(p.name) || parseMl((p.size || '') + ' ' + (p.units || ''));

// Product identity without size/pack/filler words, for "same product, other size" checks.
const FILLER = new Set(['champagne', 'wine', 'the', 'bottle', 'bottles', 'can', 'cans', 'pack', 'ml', 'l', 'oz']);
function tokens(name) {
  return String(name || '').toLowerCase()
    .replace(/\d+\s*x\s*\d+(\.\d+)?\s*(ml|l|oz)\b/g, ' ').replace(/\d+(\.\d+)?\s*(ml|l|oz|cl)\b/g, ' ')
    .replace(/\(?\s*\d+(\.\d+)?\s*proof\s*\)?/g, ' ').replace(/\d+(\.\d+)?\s*%\s*(abv|alc\.?(\s*\/\s*vol)?)?/g, ' ').replace(/\babv\b/g, ' ')
    .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !FILLER.has(t));
}
// Same product = identical names once size and generic words are gone ("Tito'S" == "Tito's
// Handmade Vodka"). A token subset was too loose: it paired "Johnnie Walker Scotch" with
// "Johnnie Walker Aged 18 Years" and "Tanqueray" with "Tanqueray No. Ten" (48/1650 rows hidden
// in a dry run, mostly legitimate).
const GENERIC = new Set(['vodka', 'tequila', 'gin', 'rum', 'whiskey', 'whisky', 'bourbon', 'scotch', 'handmade', 'imported', 'liqueur']);
const identity = name => [...new Set(tokens(name).filter(t => !GENERIC.has(t)))].sort().join(' ');
const sameProduct = (a, b) => { const ia = identity(a.name); return ia.length > 0 && ia === identity(b.name); };
// Price-by-size only makes sense for single bottles of wine/spirits: packs and mixers
// ("Fever Tree 5 OZ" is a 4-pack priced as one row) break the arithmetic.
const sizeComparable = p => /^(wine|liquor|spirits)$/i.test(String(p.category || '')) && !/\d\s*x\s*\d|\b\d+\s*(pk|pack)\b/i.test(p.name || '') && volumeMl(p) >= 187;

function screen(products, zip) {
  const flagged = new Map();   // index -> reason
  const quiet = new Set();     // hidden but not worth a Slack alert (identical-price duplicates)
  const flag = (i, reason) => { if (!flagged.has(i)) flagged.set(i, reason); };
  products.forEach((p, i) => {
    const n = String(p.name || '').trim(), pr = price(p);
    // Name: blank, placeholder, or a mis-cased possessive ("Tito'S") in an otherwise normal name.
    if (!n || !/[a-z]/i.test(n)) return flag(i, 'blank or non-text name');
    if (/\b(test|sample|do not use|placeholder|dummy)\b/i.test(n)) return flag(i, 'placeholder-looking name');
    if (/[a-z]'S\b/.test(n)) flag(i, 'malformed name ("' + (n.match(/\S*[a-z]'S\b/) || [''])[0] + '")');
    // Price: missing or zero.
    if (!(pr > 0)) return flag(i, 'no price');
    // Size: the size in the name disagrees with the size field (single bottles only).
    // Single bottles only: for packs the name carries the pack total and the field one unit.
    const isPack = /\d\s*x\s*\d|\b\d+\s*-?\s*(pk|pack)\b/i.test(n + ' ' + (p.units || ''));
    const nameMl = parseMl(n), fieldMl = parseMl((p.size || '') + ' ' + (p.units || ''));
    if (!isPack && nameMl && fieldMl && Math.abs(nameMl - fieldMl) / Math.max(nameMl, fieldMl) > 0.08)
      flag(i, 'name says ' + Math.round(nameMl) + ' ml but size field says ' + Math.round(fieldMl) + ' ml');
  });
  // A single bottle priced far below its known web market price, even with no other row of the
  // product to compare against. Real bug (Sep 29 smoke): Bevvi dropped the Veuve 1.5 L row, so the
  // bogus 3 L at $71.49 (market ~$651.79, cached) had no sibling and was shown again. Uses the
  // market cache only — no new web lookup in the request path — and needs < 40% of market.
  products.forEach((p, i) => {
    if (flagged.has(i) || !sizeComparable(p) || !(price(p) > 0)) return;
    const m = cachedMarket(p, zip);
    if (m && m.median && price(p) < m.median * 0.4)
      flag(i, 'priced far below market: $' + price(p).toFixed(2) + ' vs market ~$' + m.median.toFixed(2) + ' for ' + Math.round(volumeMl(p)) + ' ml near ' + (zip || 'US'));
  });
  // Same product compared across the result set. When two rows disagree, blame the one whose
  // price-per-litre is farthest from the rest of that product's rows; with no third row,
  // blame the cheaper same-size row, or the smaller bottle that costs more than a bigger one.
  const perL = x => price(x) / volumeMl(x) * 1000;
  const median = (a, b) => {
    const fam = products.filter(x => x !== a && x !== b && volumeMl(x) && price(x) > 0 && sameProduct(x, a)).map(perL).sort((x, y) => x - y);
    return fam.length ? fam[Math.floor(fam.length / 2)] : null;
  };
  const off = (x, med) => Math.abs(Math.log(perL(x) / med));
  const sizePending = [];   // bottles whose market price decides a two-row size conflict (guardAsync waits)
  for (let i = 0; i < products.length; i++) for (let j = i + 1; j < products.length; j++) {
    const a = products[i], b = products[j], va = volumeMl(a), vb = volumeMl(b), pa = price(a), pb = price(b);
    if (!va || !vb || !(pa > 0) || !(pb > 0) || !sameProduct(a, b)) continue;
    const med = median(a, b);
    const pick = (fallback) => med ? (off(a, med) >= off(b, med) ? i : j) : fallback;
    if (Math.abs(va - vb) / Math.max(va, vb) < 0.02) {
      continue;   // same product AND size: a duplicate listing, decided against the market price below
    } else if (sizeComparable(a) && sizeComparable(b) && Math.abs(va - vb) / Math.max(va, vb) > 0.2) {
      // A bigger bottle of the same product that costs less than a smaller one.
      const [big, small] = va > vb ? [i, j] : [j, i];
      if (price(products[big]) < price(products[small]) * 0.9) {
        // No third row of the product: decide on each bottle's web market price. Real bug (Sep 27
        // nightly/smoke): Bevvi added Veuve Yellow Label 1.5 L $175.99 beside the bogus 3 L $71.49;
        // with only those two rows the old fallback blamed the SMALLER bottle, hid the real 1.5 L
        // and showed the $71.49 3 L. Until the market prices are known, the under-priced bigger
        // bottle (the usual mis-listed size) is the one hidden.
        let bad, why = '';
        if (med) bad = pick(small);
        else {
          const mb = cachedMarket(products[big], zip), ms = cachedMarket(products[small], zip);
          const offM = (k, m) => (m && m.median) ? Math.abs(Math.log(price(products[k]) / m.median)) : null;
          const ob = offM(big, mb), os = offM(small, ms);
          if (ob !== null || os !== null) {
            bad = (ob === null ? 0 : ob) >= (os === null ? 0 : os) ? big : small;
            const m = bad === big ? mb : ms;
            if (m && m.median) why = ' (market ~$' + m.median.toFixed(2) + ' for this bottle)';
          } else {
            bad = big;
            why = ' (bigger bottle priced below the smaller one; market price lookup pending)';
            if (!mb) sizePending.push(products[big]);
            if (!ms) sizePending.push(products[small]);
          }
        }
        const other = products[bad === big ? small : big];
        flag(bad, Math.round(volumeMl(products[bad])) + ' ml at $' + price(products[bad]).toFixed(2) + ' is out of line with "' + other.name + '" at $' + price(other).toFixed(2) + (med ? ' (usual ~$' + med.toFixed(0) + '/L)' : why));
      }
    }
  }
  // Duplicates: the same product in the same size listed more than once (user report: two
  // "Grey Goose 750 ML" rows at $41.24 and $35.20 with slightly different names). Show ONE:
  // the row closest to the MARKET price (web prices near the customer's zip, cached). On a
  // cache miss the first row with brand data is shown for now and the market lookup runs in
  // the background (alert sent when it finishes). Prices within 2% = plain duplicate: hidden
  // and logged, no alert.
  const pending = [], refresh = [];
  const done = new Set();
  for (let i = 0; i < products.length; i++) {
    if (flagged.has(i) || done.has(i) || !volumeMl(products[i]) || !(price(products[i]) > 0)) continue;
    const grp = [i];
    for (let j = i + 1; j < products.length; j++) {
      if (flagged.has(j) || done.has(j) || !volumeMl(products[j]) || !(price(products[j]) > 0)) continue;
      if (sameProduct(products[i], products[j]) && Math.abs(volumeMl(products[i]) - volumeMl(products[j])) / volumeMl(products[i]) < 0.02) grp.push(j);
    }
    grp.forEach(k => done.add(k));
    if (grp.length < 2) continue;
    const spread = (Math.max(...grp.map(k => price(products[k]))) - Math.min(...grp.map(k => price(products[k])))) / Math.max(...grp.map(k => price(products[k])));
    const mk = spread > 0.02 ? cachedMarket(products[i], zip) : null;
    if (mk && mk.stale) refresh.push(products[i]);
    let keep, basis;
    if (mk && mk.median) {
      keep = grp.reduce((b, k) => Math.abs(price(products[k]) - mk.median) < Math.abs(price(products[b]) - mk.median) ? k : b, grp[0]);
      basis = 'market ~$' + mk.median.toFixed(2) + ' (median of ' + mk.prices.length + ' web price' + (mk.prices.length > 1 ? 's' : '') + ' near ' + (zip || 'US') + ': ' + mk.prices.slice(0, 3).map(x => x.store + ' $' + x.price.toFixed(2)).join(', ') + ')';
    } else {
      keep = grp.find(k => products[k].brandinfo) ?? grp[0];
      basis = spread <= 0.02 ? 'same price' : (mk ? 'no market price found on the web — kept the first-listed row; please check both' : 'market price lookup started — showing the first-listed row until it finishes');
      if (spread > 0.02 && !mk) pending.push({ rows: grp.map(k => products[k]), probe: products[i] });
    }
    const kp = products[keep];
    for (const k of grp) {
      if (k === keep) continue;
      const d = Math.abs(price(products[k]) - price(kp)) / Math.max(price(products[k]), price(kp));
      flagged.set(k, (d <= 0.02 ? 'duplicate listing' : 'DUPLICATE, different price') + ' of "' + kp.name + '" — showing $' + price(kp).toFixed(2) + ', hid $' + price(products[k]).toFixed(2) + ' — ' + basis);
      if (d <= 0.02 || (spread > 0.02 && !mk)) quiet.add(k);   // pending groups alert when the lookup finishes
    }
  }
  const kept = [], hidden = [];
  products.forEach((p, i) => (flagged.has(i) ? hidden.push({ product: p, reason: flagged.get(i), quiet: quiet.has(i) }) : kept.push(p)));
  return { kept, hidden, pending, refresh, sizePending };
}

function alertSlack(hidden, query, zip) {
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')); } catch (e) {}
  const now = Date.now();
  const fresh = hidden.filter(h => !h.quiet).filter(h => {
    const k = (h.product.id || h.product.upc || h.product.name) + '|' + h.reason.replace(/"[^"]*"|\$[\d.]+|\d+%/g, '');
    if (seen[k] && now - seen[k] < ALERT_EVERY_MS) return false;
    seen[k] = now; return true;
  });
  if (!fresh.length) return;
  try { fs.writeFileSync(ALERT_FILE, JSON.stringify(seen)); } catch (e) {}
  if (!SLACK_TOKEN || !SLACK_CHANNEL) { console.log('[catalog-guard] Slack not configured — alert logged only'); return; }
  const lines = fresh.map(h => '• *' + h.product.name + '* — $' + price(h.product).toFixed(2) + ' — ' + h.reason +
    '\n   id `' + (h.product.id || '?') + '` · UPC `' + (h.product.upc || '?') + '` · store `' + (h.product.establishmentId || '?') + '`');
  const text = ':warning: *Catalog listings need checking — Rachel is hiding these from customers*\nSearch "' + query + '"' + (zip ? ' in ' + zip : '') + ':\n' + lines.join('\n') +
    '\n_Hidden until the listing is fixed. Rules: store-agent/catalog-guard.js_';
  fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: SLACK_CHANNEL, text }) })
    .then(r => r.json()).then(j => { if (!j.ok) console.error('[catalog-guard] Slack post failed:', j.error); else console.log('[catalog-guard] Slack alert posted:', fresh.length, 'row(s)'); })
    .catch(e => console.error('[catalog-guard] Slack post error:', e.message));
}

// Screen a search result: log + alert every hidden row, return only the rows safe to show.
function guard(products, query, zip) {
  if (!Array.isArray(products) || !products.length) return products;
  const { kept, hidden, pending, refresh } = screen(products, zip);
  for (const r of refresh) lookupMarket(r, zip);   // quiet background refresh of a stale market price
  for (const h of hidden) console.log('[catalog-guard] HIDDEN "' + h.product.name + '" $' + price(h.product).toFixed(2) + ' — ' + h.reason + ' (search ' + JSON.stringify(query) + (zip ? ' zip ' + zip : '') + ')');
  if (hidden.some(h => !h.quiet)) alertSlack(hidden, query, zip);
  for (const g of pending) {
    lookupMarket(g.probe, zip).then(m => {
      if (!m) return;
      const best = m.median ? g.rows.reduce((b, r) => Math.abs(price(r) - m.median) < Math.abs(price(b) - m.median) ? r : b, g.rows[0]) : null;
      const note = best
        ? 'showing "' + best.name + '" $' + price(best).toFixed(2) + ' from now on — market ~$' + m.median.toFixed(2) + ' (median of ' + m.prices.length + ' web price' + (m.prices.length > 1 ? 's' : '') + ' near ' + (zip || 'US') + ': ' + m.prices.slice(0, 3).map(x => x.store + ' $' + x.price.toFixed(2)).join(', ') + ')'
        : 'no market price found on the web — please check which price is right';
      alertSlack(g.rows.filter(r => r !== best).map(r => ({ product: r, reason: 'DUPLICATE, different price: ' + g.rows.map(x => '$' + price(x).toFixed(2)).join(' vs ') + ' — ' + note })), query, zip);
    });
  }
  return kept;
}

// DC: "for the first call it's ok to wait, accurate price is more important". A duplicate with
// no market price yet waits for the web lookup (up to FIRST_LOOKUP_WAIT_MS, lookups in
// parallel) and is then decided on the market price, in this same search. Past the cap the
// search goes ahead with the interim row and the lookup completes in the background.
const FIRST_LOOKUP_WAIT_MS = 35000;
async function guardAsync(products, query, zip) {
  if (!Array.isArray(products) || !products.length) return products;
  const { pending, sizePending } = screen(products, zip);
  const probes = pending.map(g => g.probe).concat(sizePending || []);
  if (probes.length) {
    const t0 = Date.now();
    console.log('[catalog-guard] ' + probes.length + ' unpriced row(s) (duplicates / size conflicts) in search ' + JSON.stringify(query) + ' — waiting for the market price (max ' + FIRST_LOOKUP_WAIT_MS / 1000 + 's): ' + probes.map(p => p.name).join(', '));
    let timer;
    const done = await Promise.race([
      Promise.all(probes.map(p => lookupMarket(p, zip))).then(() => true),
      new Promise(r => { timer = setTimeout(() => r(false), FIRST_LOOKUP_WAIT_MS); })
    ]);
    clearTimeout(timer);
    console.log('[catalog-guard] market wait ' + (done ? 'finished' : 'hit the ' + FIRST_LOOKUP_WAIT_MS / 1000 + 's cap — interim row shown, lookup continues in the background') + ' after ' + Math.round((Date.now() - t0) / 1000) + 's');
  }
  return guard(products, query, zip);   // re-screens with whatever market prices are now cached
}

module.exports = { guard, guardAsync, screen, parseMl, tokens, identity, webMarketPrice, lookupMarket, cachedMarket };
