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

function screen(products) {
  const flagged = new Map();   // index -> reason
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
  // Same product compared across the result set. When two rows disagree, blame the one whose
  // price-per-litre is farthest from the rest of that product's rows; with no third row,
  // blame the cheaper same-size row, or the smaller bottle that costs more than a bigger one.
  const perL = x => price(x) / volumeMl(x) * 1000;
  const median = (a, b) => {
    const fam = products.filter(x => x !== a && x !== b && volumeMl(x) && price(x) > 0 && sameProduct(x, a)).map(perL).sort((x, y) => x - y);
    return fam.length ? fam[Math.floor(fam.length / 2)] : null;
  };
  const off = (x, med) => Math.abs(Math.log(perL(x) / med));
  for (let i = 0; i < products.length; i++) for (let j = i + 1; j < products.length; j++) {
    const a = products[i], b = products[j], va = volumeMl(a), vb = volumeMl(b), pa = price(a), pb = price(b);
    if (!va || !vb || !(pa > 0) || !(pb > 0) || !sameProduct(a, b)) continue;
    const med = median(a, b);
    const pick = (fallback) => med ? (off(a, med) >= off(b, med) ? i : j) : fallback;
    if (Math.abs(va - vb) / Math.max(va, vb) < 0.02 && Math.min(pa, pb) < Math.max(pa, pb) * 0.5) {
      // Same product, same size, one under half the other's price.
      const bad = pick(pa < pb ? i : j), other = products[bad === i ? j : i];
      flag(bad, 'same product and size as "' + other.name + '" but $' + price(products[bad]).toFixed(2) + ' vs $' + price(other).toFixed(2) + (med ? ' (usual ~$' + med.toFixed(0) + '/L)' : ''));
    } else if (sizeComparable(a) && sizeComparable(b) && Math.abs(va - vb) / Math.max(va, vb) > 0.2) {
      // A bigger bottle of the same product that costs less than a smaller one.
      const [big, small] = va > vb ? [i, j] : [j, i];
      if (price(products[big]) < price(products[small]) * 0.9) {
        const bad = pick(small), other = products[bad === big ? small : big];
        flag(bad, Math.round(volumeMl(products[bad])) + ' ml at $' + price(products[bad]).toFixed(2) + ' is out of line with "' + other.name + '" at $' + price(other).toFixed(2) + (med ? ' (usual ~$' + med.toFixed(0) + '/L)' : ''));
      }
    }
  }
  const kept = [], hidden = [];
  products.forEach((p, i) => (flagged.has(i) ? hidden.push({ product: p, reason: flagged.get(i) }) : kept.push(p)));
  return { kept, hidden };
}

function alertSlack(hidden, query, zip) {
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')); } catch (e) {}
  const now = Date.now();
  const fresh = hidden.filter(h => {
    const k = (h.product.id || h.product.upc || h.product.name) + '|' + h.reason.replace(/"[^"]*"|\$[\d.]+|\d+%/g, '');
    if (seen[k] && now - seen[k] < ALERT_EVERY_MS) return false;
    seen[k] = now; return true;
  });
  if (!fresh.length) return;
  try { fs.writeFileSync(ALERT_FILE, JSON.stringify(seen)); } catch (e) {}
  if (!SLACK_TOKEN || !SLACK_CHANNEL) { console.log('[catalog-guard] Slack not configured — alert logged only'); return; }
  const lines = fresh.map(h => '• *' + h.product.name + '* — $' + price(h.product).toFixed(2) + ' — ' + h.reason +
    '\n   id `' + (h.product.id || '?') + '` · UPC `' + (h.product.upc || '?') + '` · store `' + (h.product.establishmentId || '?') + '`');
  const text = ':warning: *Catalog listing looks wrong — Rachel is hiding it from customers*\nSearch "' + query + '"' + (zip ? ' in ' + zip : '') + ':\n' + lines.join('\n') +
    '\n_Hidden until the listing is fixed. Rules: store-agent/catalog-guard.js_';
  fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: SLACK_CHANNEL, text }) })
    .then(r => r.json()).then(j => { if (!j.ok) console.error('[catalog-guard] Slack post failed:', j.error); else console.log('[catalog-guard] Slack alert posted:', fresh.length, 'row(s)'); })
    .catch(e => console.error('[catalog-guard] Slack post error:', e.message));
}

// Screen a search result: log + alert every hidden row, return only the rows safe to show.
function guard(products, query, zip) {
  if (!Array.isArray(products) || !products.length) return products;
  const { kept, hidden } = screen(products);
  for (const h of hidden) console.log('[catalog-guard] HIDDEN "' + h.product.name + '" $' + price(h.product).toFixed(2) + ' — ' + h.reason + ' (search ' + JSON.stringify(query) + (zip ? ' zip ' + zip : '') + ')');
  if (hidden.length) alertSlack(hidden, query, zip);
  return kept;
}

module.exports = { guard, screen, parseMl, tokens };
