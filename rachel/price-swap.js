// A per-bottle price limit stated against a basket that already has dearer bottles = SWAP them, in code (DC, Nov 14:
// "if a customer is asking for the swaps, don't add as options but make the swap"). Real (Nov 13, DC's two Eterra Kitchen
// email quotes): "The bottles should not exceed $15 for wine" / "Price of wine cannot exceed $15" / "Yes do that" — the
// model listed cheaper bottles and asked "Shall I go with ...?", then the proposal printed them as OPTIONS while the basket
// kept Cloudy Bay $37.39, Joseph Phelps $71.49 and Kim Crawford $17.04. Four emails, no swap.
//
// bottle-price.js reads the limit (state.bottlePrice); server.js PRICE SWAPS finds, per over-limit line of that category,
// a same-type bottle (drink-type.js) of the same size within the limit (the dearest one under it — closest to what the
// customer allowed) and replaces the line at its qty. A line with nothing within the limit is kept and said.
//
// overLimit(items, bp) -> [index]      queryFor(line) -> catalog search words      pick(rows, line, bp) -> row | null

const DT = require('./drink-type.js');

const priceOf = it => parseFloat(it && (it.price != null ? it.price : it.salePrice)) || 0;
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const sizeKey = s => { const m = fold(s).replace(/\s+/g, '').match(/(\d+(?:\.\d+)?)(ml|l|oz)/); if (!m) return ''; const v = parseFloat(m[1]) * (m[2] === 'l' ? 1000 : m[2] === 'oz' ? 29.5735 : 1); return String(Math.round(v / 5) * 5); };
const lineSize = it => sizeKey(it.size) || sizeKey(it.name);

function inCategory(it, bp) {
  const t = DT.typeOf(it), cat = fold(it.category);
  if (/beer|seltzer|mixer|water|soda|juice|non/.test(cat) && !t) return false;
  if (bp.category === 'spirits') return t.startsWith('spirit:') || /liquor|spirit/.test(cat);
  return (!!t && !t.startsWith('spirit:')) || (/wine|champagne|sparkling/.test(cat) && !t.startsWith('spirit:'));
}

function overLimit(items, bp) {
  if (!bp || !(bp.max > 0)) return [];
  return (items || []).map((it, i) => (inCategory(it, bp) && priceOf(it) > bp.max + 0.005 ? i : -1)).filter(i => i >= 0);
}

// What the line was asked as ("Pinot Noir", "Sauvignon Blanc") when the label is a generic request; else the wine's grape /
// appellation ("Cloudy Bay Sauvignon Blanc" -> "sauvignon blanc"); else its type ("white wine").
function queryFor(line) {
  const label = String(line.label || '').trim();
  if (label && fold(label) !== fold(line.name) && label.split(/\s+/).length <= 4 && DT.typeOf({ name: label })) return label;
  return DT.styleWordOf(line) || DT.searchTerm(DT.typeOf(line)) || label || '';
}

function pick(rows, line, bp) {
  const type = DT.typeOf(line), size = lineSize(line), na = DT.isNA(line);
  const q = fold(queryFor(line)).split(/\s+/).filter(w => w.length > 2 && !/^(wine|wines|the|and)$/.test(w));
  const ok = (rows || []).filter(r => {
    const p = priceOf(r);
    if (!(p > 0) || p > bp.max + 0.005 || (bp.min && p < bp.min - 0.005)) return false;
    if ((r.product_id && r.product_id === line.product_id) || fold(r.name) === fold(line.name)) return false;
    if (type && DT.typeOf(r) !== type) return false;
    if (DT.isNA(r) !== na) return false;
    if (size && lineSize(r) && lineSize(r) !== size) return false;
    const n = fold(r.name);
    return !q.length || q.every(w => n.includes(w));
  });
  ok.sort((a, b) => priceOf(b) - priceOf(a));
  return ok[0] || null;
}

// The new line: the catalog row at the old line's qty, keeping what the customer asked for (label).
function swapLine(line, row) {
  return Object.assign({}, line, {
    name: row.name, price: priceOf(row), size: row.size || line.size, url: row.url || '', product_id: row.product_id || row.productId || '',
    upc: row.upc || '', establishmentId: row.establishmentId || line.establishmentId, category: row.category ? String(row.category).toLowerCase() : line.category,
    label: line.label || queryFor(line), match: { kind: 'price-swap' },
  });
}

const money = n => '$' + (Math.round(n * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function basketText(items) {
  const lines = items.map(it => (it.qty || 1) + 'x ' + it.name + ' — ' + money(priceOf(it)) + ' ea = ' + money(priceOf(it) * (it.qty || 1)));
  const tot = items.reduce((s, it) => s + priceOf(it) * (it.qty || 1), 0);
  return lines.join('\n') + '\n\nProduct total: ' + money(tot);
}

function describe(swaps, kept, bp) {
  const what = bp.category === 'spirits' ? 'spirit' : 'wine';
  const out = [];
  if (swaps.length) out.push('Done — every ' + what + ' is now ' + money(bp.max) + ' a bottle or less. Swapped:\n'
    + swaps.map(s => '• ' + s.from.name + ' (' + money(priceOf(s.from)) + ') → ' + s.qty + 'x ' + s.to.name + ' (' + money(priceOf(s.to)) + ')').join('\n'));
  if (kept.length) out.push((swaps.length ? 'Kept' : 'This store has nothing at ' + money(bp.max) + ' or less for these, so I kept them') + ':\n'
    + kept.map(k => '• ' + k.name + ' (' + money(priceOf(k)) + ')' + (swaps.length ? ' — nothing of that kind at ' + money(bp.max) + ' or less here' : '')).join('\n'));
  return out.join('\n\n');
}

// The message is only the price limit (+ a proposal ask / pleasantries)? Anything else goes to the model after the swaps.
const OTHER = /\b(?:add|remove|take out|drop|delete|swap|replace|change|instead|deliver(?:y)?|address|date|tip|tax|service|place|order|cases?|beer|spirits?|vodka|tequila|whiske?y|bourbon|rum|gin|\d+\s*(?:x|bottles?|btls?|cans?|packs?))\b/i;
function onlyPriceAsk(message, bp) {
  const said = fold(bp && bp.said).slice(0, 40);
  const sents = String(message || '').replace(/\r/g, '').replace(/([^\n])\n(?=[^\n])/g, '$1 ').split(/\n+|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  return sents.every(s => (said && fold(s).includes(said.slice(0, 25))) || /\$\s?\d/.test(s) || !OTHER.test(s.replace(/\b(?:proposal|pdf|quote|options?|alternatives?)\b/gi, '')));
}

// Asking to SEE choices ("find alternative wines around $20", "show me options under $15", "what do you have under $15?")
// is not a swap — the model lists them (reprice-multipick). A negated one ("do not show any options") is not that ask.
function asksForOptions(message) {
  const t = String(message || '').replace(/\r/g, '');
  const re = /\b(?:find|show|suggest|see|list|give|send|recommend|what are|any)\b[^.?!\n]{0,30}?\b(?:alternatives?|options?|choices?|suggestions?|recommendations?)\b/gi;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 25), m.index + m[0].length);
    if (!/\b(?:not|n't|no|never|without|stop)\b/i.test(before)) return true;
  }
  return /\b(?:what|which|do you have|is there|are there|anything)\b[^.!\n]{0,40}\b(?:under|below|less than|around|cheaper)\b[^.!\n]*\?/i.test(t);
}

module.exports = { asksForOptions, overLimit, queryFor, pick, swapLine, describe, basketText, onlyPriceAsk, inCategory, priceOf };
