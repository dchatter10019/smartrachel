// When a whole KIND of wine leaves an EVENT package, its servings go to the wine that stays (Nov 18, DC on Slack, 140
// guests / 2 h: "I don't need sparkling only red and white wines" removed the Chandon + Nicolas Feuillatte and left the
// red / white at 14 + 8; "did you adjust the wine quantity?" -> a rebuild that put the sparkling back; "How come the wine
// quantity hasn't been adjusted" -> "No adjustment needed"). Read in code, every /chat channel (server.js EDIT READER).
//
// rebalance(items, removed, { guests }) -> { items, changes: [{ name, from, to }], types: ['sparkling'], bottles } | null
//   items   = the basket AFTER the removals; removed = the removed lines.
//   Only for an event package (guests), only when EVERY line of the removed wine kind(s) is gone (removing one of two
//   reds is the customer cutting back — left alone) and some other wine stays. The removed volume (750 mL equivalents)
//   is spread over the remaining wine lines by their share of the wine, whole bottles, never less than the volume removed
//   minus half a bottle.
const DT = require('./drink-type.js');
const WINE = new Set(['red', 'white', 'rose', 'sparkling']);

function mlOf(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*(ml|l|lt|liters?|litres?)\b/i);
  if (!m) return 750;
  const v = /^m/i.test(m[2]) ? +m[1] : +m[1] * 1000;
  return v >= 50 && v <= 6000 ? v : 750;
}
const qtyOf = li => Number(li.qty || li.quantity) || 1;
const wineType = li => { const t = DT.typeOf({ name: li.name, subCategory: li.subCategory || li.subcategory }); return WINE.has(t) ? t : ''; };

function rebalance(items, removed, opts = {}) {
  if (!(Number(opts.guests) > 0)) return null;
  const gone = (removed || []).filter(li => wineType(li));
  if (!gone.length) return null;
  const types = [...new Set(gone.map(wineType))];
  const stay = (items || []).filter(li => wineType(li));
  if (stay.some(li => types.includes(wineType(li)))) return null;   // that kind is still there — the customer cut back
  if (!stay.length) return null;
  const needMl = gone.reduce((a, li) => a + qtyOf(li) * mlOf(li.name), 0);
  const W = stay.reduce((a, li) => a + qtyOf(li) * mlOf(li.name), 0);
  if (!(needMl > 0 && W > 0)) return null;
  const share = stay.map(li => { const raw = needMl * (qtyOf(li) * mlOf(li.name)) / W / mlOf(li.name); return { li, add: Math.floor(raw), frac: raw - Math.floor(raw) }; });
  let addedMl = share.reduce((a, s) => a + s.add * mlOf(s.li.name), 0);
  const order = share.slice().sort((a, b) => b.frac - a.frac);
  for (let i = 0; addedMl < needMl - 375 && i < 200; i++) { const s = order[i % order.length]; s.add++; addedMl += mlOf(s.li.name); }
  const changes = [];
  const out = (items || []).map(li => {
    const s = share.find(x => x.li === li);
    if (!s || !s.add) return li;
    const from = qtyOf(li), to = from + s.add;
    changes.push({ name: li.name, from, to });
    return Object.assign({}, li, { qty: to, quantity: to });
  });
  if (!changes.length) return null;
  return { items: out, changes, types, bottles: changes.reduce((a, c) => a + c.to - c.from, 0) };
}

// The wine kinds the customer's own words leave out of an event: "no sparkling", "don't need champagne", "only red and
// white (wines)", "skip the bubbly". -> ['sparkling', ...] (rachel.js -> menu_build no_wine_types -> buildPackage).
function noWineTypesIn(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/<rachel_system_notes>[\s\S]*?<\/rachel_system_notes>/g, ' ').replace(/[’]/g, "'") + ' ';
  const out = new Set();
  const KIND = { sparkling: /(?:sparkling(?: wine)?|champagne|prosecco|bubbly|bubbles|cava)/, rose: /(?:ros[eé](?: wine)?)/, red: /(?:red(?: wines?)?)/, white: /(?:white(?: wines?)?)/ };
  for (const [k, re] of Object.entries(KIND)) {
    const src = re.source;
    if (new RegExp("\\b(?:no|skip(?: the)?|without(?: the)?|(?:do ?n[o']?t|dont|don't) (?:need|want)(?: (?:the|any))?|leave out(?: the)?|(?:took|take|taken|taking) out(?: the)?|remove(?:d)?(?: the)?|nix(?: the)?)\\s+(?:any\\s+)?" + src + "\\b").test(t)) out.add(k);
  }
  const only = t.match(/\bonly\s+((?:red|white|ros[eé]|sparkling)(?:\s*(?:,|and|&|\+|or)\s*(?:red|white|ros[eé]|sparkling))*)\s+wines?\b/);
  if (only) { const keep = new Set((only[1].match(/red|white|ros[eé]|sparkling/g) || []).map(w => /^ros/.test(w) ? 'rose' : w)); for (const k of ['sparkling', 'rose']) if (!keep.has(k)) out.add(k); }
  return [...out];
}

module.exports = { rebalance, mlOf, noWineTypesIn };
