// One line per product in an order. Used where the customer approves the order summary
// (server.js renderOrderSummary) and again at placement (shopping-agent place_order), so what
// the customer approved and what Bevvi receives are the same merged list.
//
// DC (Sep 27): "ensure that when you are creating the order it's not duplicating the products".
// A basket could carry the same product twice — a re-pick, a substitute that matched an
// existing line, a rebuild — and createCorpOrder would get two lines for one product.
//
// Same product = same catalog product_id, else same UPC, else the same name identity AND bottle
// size (so "Grey Goose - 750 ML" and "Grey Goose Vodka 750 ML" merge, but 750 mL and 1 L never
// do). Quantities are summed onto the first line, which keeps its listing, price and ids.

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const FILLER = new Set(['the', 'bottle', 'bottles', 'can', 'cans', 'pack', 'ml', 'l', 'oz', 'vodka', 'wine', 'champagne']);

function mlOf(t) {
  const x = norm(t);
  const pk = x.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(oz|ml)/); if (pk) return pk[1] + 'x' + pk[2] + pk[3];
  const m = x.match(/(\d+(?:\.\d+)?)\s*(ml|l|cl)\b/); if (!m) return '';
  return String(Math.round(m[2] === 'l' ? +m[1] * 1000 : m[2] === 'cl' ? +m[1] * 10 : +m[1]));
}
function identity(name) {
  return norm(name)
    .replace(/\d+\s*x\s*\d+(\.\d+)?\s*(ml|l|oz)\b/g, ' ').replace(/\d+(\.\d+)?\s*(ml|l|oz|cl)\b/g, ' ')
    .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(w => w && !FILLER.has(w) && !/^\d+$/.test(w)).join(' ');
}
const qtyOf = it => parseInt(it.qty || it.quantity || 1, 10) || 1;
const idOf = it => String(it.product_id || it.productId || '').trim();

// Returns { items, merged: [{kept, dropped, qty, reason}] }. Input order is preserved.
function mergeOrderLines(items) {
  const out = [], merged = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !(it.name || it.label)) { out.push(it); continue; }
    const nm = it.name || it.label, size = mlOf(nm) || mlOf(it.size);
    const hit = out.find(o => {
      if (!o || !(o.name || o.label)) return false;
      if (idOf(o) && idOf(o) === idOf(it)) return true;
      if (o.upc && it.upc && String(o.upc) === String(it.upc)) return true;
      // Different listings of the same bottle (two "Grey Goose 750 ML" rows) are one product too.
      const osize = mlOf(o.name || o.label) || mlOf(o.size);
      return identity(o.name || o.label) === identity(nm) && identity(nm) !== '' && osize === size;
    });
    if (!hit) { out.push(Object.assign({}, it)); continue; }
    const before = qtyOf(hit), add = qtyOf(it);
    const why = idOf(hit) && idOf(hit) === idOf(it) ? 'same product_id' : (hit.upc && hit.upc === it.upc) ? 'same UPC' : 'same product and size' + (idOf(hit) && idOf(it) ? ', different catalog listings' : '');
    if ('quantity' in hit && !('qty' in hit)) hit.quantity = before + add; else hit.qty = before + add;
    merged.push({ kept: hit.name || hit.label, dropped: nm, qty: before + add, reason: why + (parseFloat(hit.price) !== parseFloat(it.price) ? ' (prices $' + (parseFloat(hit.price) || 0).toFixed(2) + ' vs $' + (parseFloat(it.price) || 0).toFixed(2) + ' — kept the first line\'s price)' : '') });
  }
  return { items: out, merged };
}

module.exports = { mergeOrderLines, identity, mlOf };
