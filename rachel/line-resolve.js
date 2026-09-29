// A basket line with no catalog link (no product_id/upc/establishmentId) -> the catalog product it is, or not.
// Real case (Sep 29, Gen II Fund): the quote the customer approved was built by hand; its lines came back into
// Rachel's session from the PDF with names and prices only, so "create the order" could not place any of them.
// Before an order, each unlinked line is searched in the store's catalog and linked ONLY on a confident match:
// the same price AND the name fits (every distinctive word, typo-tolerant). Anything else is not guessed —
// the customer is asked (with the closest options).
//
// needsLink(item) -> bool
// choose(item, candidates) -> { pick, reason } | { pick: null, reason, options: [names] }

const QE = require('./quote-edits.js');
const PM = require('./product-match.js');
const needsLink = it => !((it.product_id || it.productId || it.upc) && it.establishmentId);
const clean = n => String(n || '').replace(/\s*\*\s*$/, '').trim();
const nameOnly = n => clean(n).replace(/\b\d+(?:\.\d+)?\s*(?:x\s*\d+(?:\.\d+)?\s*)?(?:pk|pack|oz|ml|l|ct)?\b\.?/gi, ' ').replace(/\b(?:oz|cans?|bottles?|pk|ml)\b/gi, ' ').replace(/[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
const priceOf = p => Number(p.salePrice || p.price || 0);

function choose(item, candidates) {
  const want = Number(item.price) || 0;
  const scored = (candidates || []).filter(c => (c.product_id || c.upc) && c.establishmentId)
    .map(c => ({ c, fit: QE.score(clean(item.name), c), rev: QE.score(clean(c.name), { name: clean(item.name) }), same: Math.abs(priceOf(c) - want) < 0.005 }))
    .sort((a, b) => (b.same - a.same) || (b.fit + b.rev) - (a.fit + a.rev));
  const options = scored.slice(0, 3).map(x => x.c.name + ' $' + priceOf(x.c).toFixed(2));
  const good = scored.filter(x => x.same && x.fit >= 0.99 && x.rev >= 0.6);
  if (good.length === 1 || (good.length > 1 && good[0].fit + good[0].rev > good[1].fit + good[1].rev))
    return { pick: good[0].c, reason: 'same price $' + want.toFixed(2) + ', name fits' };
  if (good.length > 1) return { pick: null, reason: good.length + ' products at the same price fit equally', options };
  if (!scored.length) return { pick: null, reason: 'not found in this store\'s catalog', options: [] };
  const byName = scored.find(x => x.fit >= 0.99 && x.rev >= 0.6);
  return { pick: null, reason: byName ? 'the catalog price is now $' + priceOf(byName.c).toFixed(2) + ' (quoted $' + want.toFixed(2) + ')' : 'no product with this name and price', options };
}

// Link every unlinked line: search(name, category) -> candidates. Returns { items, linked: [..], unresolved: [..] }.
async function resolveLines(items, search, log = console.log) {
  const out = [], linked = [], unresolved = [];
  for (const it of items || []) {
    if (!needsLink(it)) { out.push(it); continue; }
    let cands = [];
    try { cands = await search(clean(it.name), it.category || ''); } catch (e) { log('[line-resolve] search failed for ' + JSON.stringify(it.name) + ': ' + e.message); }
    let r = choose(it, cands);
    // Not in the first page: search again with just the distinctive words + pack count ("michelob ultra 30"),
    // the same retry buildPackage uses (a brand's other sizes crowd the full-name search).
    const key = PM.searchKey(clean(it.name));
    if (!r.pick && key && key !== clean(it.name).toLowerCase()) {
      try { cands = cands.concat(await search(key, it.category || '')); r = choose(it, cands); } catch (e) {}
    }
    // Still not found: the name without its size words ("High Noon Variety Pool Pack 8x12 oz Cans" returns
    // nothing like it; "High Noon Variety Pool Pack" returns the 8-pack).
    const bare = nameOnly(it.name);
    if (!r.pick && bare && bare !== clean(it.name)) {
      try { cands = cands.concat(await search(bare, it.category || '')); r = choose(it, cands); } catch (e) {}
    }
    if (r.pick) {
      const p = r.pick;
      out.push(Object.assign({}, it, { product_id: p.product_id || p.productId || '', upc: p.upc || '', establishmentId: p.establishmentId, url: p.url || it.url || '', catalog_name: p.name }));
      linked.push({ name: clean(it.name), to: p.name, reason: r.reason });
      log('[line-resolve] LINKED ' + JSON.stringify(clean(it.name)) + ' -> ' + p.name + ' (' + (p.product_id || p.upc) + ') — ' + r.reason);
    } else {
      out.push(it);
      unresolved.push({ name: clean(it.name), reason: r.reason, options: r.options });
      log('[line-resolve] NOT LINKED ' + JSON.stringify(clean(it.name)) + ' — ' + r.reason + (r.options.length ? ' | closest: ' + r.options.join(' / ') : ''));
    }
  }
  return { items: out, linked, unresolved };
}

module.exports = { needsLink, choose, resolveLines, nameOnly };
