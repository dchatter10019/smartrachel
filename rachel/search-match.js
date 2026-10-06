// Does a catalog result actually match what was searched for? Shared by rachel.js ([not-found]) and the shopping-agent's
// product_query, so every channel — Slack, WhatsApp, email AND the MCP connector, which calls product_query directly —
// gets the same answer (rule 8). The catalog search returns loose word matches ("Green Chartreuse" -> Johnnie Walker
// Green, "creme de cassis" -> Hall Napa Cabernet) and product_query sorted them by price only, so on the connector they
// came back as found, first (DC, Oct 6, claude.ai).

// Words that don't name a producer: types, grapes, descriptors, company suffixes (moved from rachel.js, Sep 29 - Oct 2).
const GENERICW = /^(the|and|of|de|du|la|le|wine|wines|red|white|rose|rosé|sparkling|vineyard|vineyards|valley|estate|reserve|bottle|bottles|ml|l|oz|pack|case|chardonnay|cabernet|sauvignon|blanc|pinot|noir|grigio|gris|merlot|malbec|zinfandel|syrah|shiraz|riesling|champagne|prosecco|brut|vodka|gin|rum|tequila|whiskey|whisky|bourbon|scotch|beer|lager|ipa|seltzer|blanco|reposado|anejo|añejo|high|higher|end|top|shelf|premium|luxury|upscale|fancy|nice|good|best|great|cheap|budget|affordable|mid|quality|expensive|smooth|popular|regular|standard|classic|something|some|any|brewing|brewery|breweries|brewers|brewer|company|winery|wineries|cellars|cellar|distillery|distillers|distilling|non|alcoholic|nonalcoholic)$/i;

const normW = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9' ]+/g, ' ');

// The query's distinctive words ("Green Chartreuse" -> green, chartreuse; "red wine" -> none: nothing to verify).
function distinctiveWords(query) {
  return normW(query).split(/\s+/).filter(w => w.length >= 3 && !/^\d/.test(w) && !GENERICW.test(w));
}

// A word is in a product name as a whole word, without apostrophes ("titos" = "Tito's"), or — 5+ letters — run
// together ("budlight" = "Bud Light").
function carries(productName, word) {
  const pn = ' ' + normW(productName) + ' ', pn0 = pn.replace(/'/g, ''), w0 = word.replace(/'/g, '');
  if (pn.includes(' ' + word + ' ') || pn0.includes(' ' + w0 + ' ')) return true;
  return w0.length >= 5 && pn0.replace(/\s+/g, '').includes(w0);
}

// The producer key = the first two distinctive words. A result counts as the product only if it carries both.
function keyOf(query) { return distinctiveWords(query).slice(0, 2); }
function isMatch(query, productName) { const key = keyOf(query); return !key.length || key.every(k => carries(productName, k)); }

// Order products by how many of the query's distinctive words they carry (stable: price / core order kept within a tie).
// found = some product carries the key, or the query has no distinctive word to check.
function rankByMatch(query, products) {
  const words = distinctiveWords(query), key = words.slice(0, 2);
  const list = Array.isArray(products) ? products : [];
  if (!words.length) return { products: list, found: list.length > 0, key };
  const scored = list.map((p, i) => ({ p, i, s: words.filter(w => carries(p && p.name, w)).length, m: key.every(k => carries(p && p.name, k)) }));
  scored.sort((a, b) => (b.m - a.m) || (b.s - a.s) || (a.i - b.i));
  const matched = scored.filter(x => x.m);
  return { products: matched.map(x => x.p), unrelated: scored.filter(x => !x.m).map(x => x.p), found: matched.length > 0, key };
}

module.exports = { GENERICW, normW, distinctiveWords, carries, keyOf, isMatch, rankByMatch };
