// Category subtotals on a package reply ("Wine total: $329.81"), in code.
// Real bug (Sep 28): prompt.md asks the LLM for a subtotal after each section; it wrote
// them in about half the QA runs and skipped them in the rest. DC: they always show.
// The LLM's own subtotal lines are removed and replaced by ones computed from the build's
// line_items, placed at the end of each section (or before Product total if the section
// header can't be found).

const CATS = [
  { key: 'wine', label: 'Wine', header: /^[*_\s]*(?:red\s+|white\s+|sparkling\s+)?wines?\b/i },
  { key: 'beer', label: 'Beer', header: /^[*_\s]*(?:beers?|seltzers?|hard\s+seltzers?)\b/i },
  { key: 'spirits', label: 'Spirits', header: /^[*_\s]*(?:spirits|liquor)\b/i },
  { key: 'other', label: 'Mixers & extras', header: /^[*_\s]*(?:mixers?|extras|non-alcoholic|cocktail\s+ingredients|other)\b/i },
];

function catKey(category) {
  const c = String(category || '').toLowerCase();
  if (/wine|champagne|sparkling|ros[eé]/.test(c)) return 'wine';
  if (/beer|seltzer|cider/.test(c)) return 'beer';
  if (/spirit|liquor|vodka|rum|gin|tequila|whisk|bourbon|scotch|mezcal|brandy|cognac|liqueur/.test(c)) return 'spirits';
  return 'other';
}

// line_items (array or JSON string) -> [{ key, label, total }] in display order, or
// { skip: reason } when the lines don't add up to the build's product total.
function categorySubtotals(lineItems, productTotal) {
  const items = typeof lineItems === 'string' ? JSON.parse(lineItems || '[]') : (lineItems || []);
  const sums = {};
  for (const p of items) {
    const qty = parseFloat(p.qty) || 0;
    const line = p.line_total != null ? parseFloat(p.line_total) : qty * (parseFloat(p.price != null ? p.price : p.unit_price) || 0);
    if (!qty || !isFinite(line)) continue;
    const k = catKey(p.category || p.cat);
    sums[k] = (sums[k] || 0) + line;
  }
  const out = CATS.filter(c => sums[c.key]).map(c => ({ key: c.key, label: c.label, total: Math.round(sums[c.key] * 100) / 100 }));
  const sum = Math.round(out.reduce((s, c) => s + c.total, 0) * 100) / 100;
  const pt = parseFloat(productTotal);
  if (isFinite(pt) && Math.abs(sum - pt) > 0.02) return { skip: 'subtotals $' + sum.toFixed(2) + ' != product total $' + pt.toFixed(2) };
  return out;
}

const SUBTOTAL_LINE = /^[*_\s]*(?:wine|beer|spirits?|liquor|mixers?(?:\s*&\s*extras)?|extras|other)\s+(?:sub)?total\s*:.*$/i;
const PRODUCT_TOTAL = /^[*_\s]*product\s+total\b/i;

// Replace whatever subtotal lines the LLM wrote with the computed ones.
// Returns { text, placed: [label...], fallback: [label...] }.
function applySubtotals(text, subtotals, bold) {
  const b = bold ? '*' : '';
  const lines = text.split('\n').filter(l => !SUBTOTAL_LINE.test(l.trim()));
  const fmt = c => b + c.label + ' total: $' + c.total.toFixed(2) + b;
  const headerIdx = c => lines.findIndex(l => c.header.test(l) && /—|-|:|\d/.test(l) && !/\$\d/.test(l));
  const placed = [], fallback = [];
  // Work bottom-up so earlier indices stay valid.
  const found = subtotals.map(s => ({ s, cat: CATS.find(c => c.key === s.key) })).map(x => ({ ...x, at: headerIdx(x.cat) }));
  const headers = found.filter(x => x.at >= 0).map(x => x.at).concat(CATS.map(c => headerIdx(c)).filter(i => i >= 0));
  const ptIdx = lines.findIndex(l => PRODUCT_TOTAL.test(l));
  for (const x of found.filter(f => f.at >= 0).sort((a, b2) => b2.at - a.at)) {
    // Section ends at the next category header or Product total, whichever comes first.
    const nexts = headers.filter(i => i > x.at).concat(ptIdx > x.at ? [ptIdx] : []);
    let end = nexts.length ? Math.min(...nexts) : lines.length;
    while (end > x.at + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, '', fmt(x.s));
    placed.unshift(x.s.label);
  }
  const missing = found.filter(x => x.at < 0);
  if (missing.length) {
    const block = missing.map(x => fmt(x.s));
    const pt = lines.findIndex(l => PRODUCT_TOTAL.test(l));
    if (pt >= 0) lines.splice(pt, 0, ...block, ''); else lines.push('', ...block);
    missing.forEach(x => fallback.push(x.s.label));
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n'), placed, fallback };
}

module.exports = { categorySubtotals, applySubtotals, catKey };
