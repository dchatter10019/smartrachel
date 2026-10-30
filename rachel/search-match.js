// Does a catalog result actually match what was searched for? Shared by rachel.js ([not-found]) and the shopping-agent's
// product_query, so every channel — Slack, WhatsApp, email AND the MCP connector, which calls product_query directly —
// gets the same answer (rule 8). The catalog search returns loose word matches ("Green Chartreuse" -> Johnnie Walker
// Green, "creme de cassis" -> Hall Napa Cabernet) and product_query sorted them by price only, so on the connector they
// came back as found, first (DC, Oct 6, claude.ai).

// Words that don't name a producer: types, grapes, descriptors, company suffixes (moved from rachel.js, Sep 29 - Oct 2).
const GENERICW = /^(the|and|of|de|du|la|le|wine|wines|red|white|rose|rosé|sparkling|vineyard|vineyards|valley|estate|reserve|bottle|bottles|ml|l|oz|pack|case|chardonnay|cabernet|sauvignon|blanc|pinot|noir|grigio|gris|merlot|malbec|zinfandel|syrah|shiraz|riesling|champagne|prosecco|brut|vodka|gin|rum|tequila|whiskey|whisky|bourbon|scotch|beer|lager|ipa|seltzer|blanco|reposado|anejo|añejo|high|higher|end|top|shelf|premium|luxury|upscale|fancy|nice|good|best|great|cheap|budget|affordable|mid|quality|expensive|smooth|popular|regular|standard|classic|something|some|any|brewing|brewery|breweries|brewers|brewer|company|winery|wineries|cellars|cellar|distillery|distillers|distilling|non|alcoholic|nonalcoholic)$/i;

// Filler and other-language type words aren't producer words either (Oct 7 nightly, F-0022: "Conundrum White 750 ML too"
// dropped Conundrum White for lacking "too"; "vino tinto" dropped every red wine; "Modelo can" dropped every Modelo).
const FILLERW = /^(too|also|please|pls|thanks|more|another|extra|additional|few|couple|bottled|can|cans|canned|btl|btls|keg|kegs|vino|vinos|tinto|tintos|blanca|rosado|espumoso|cerveza|cervezas|french|italian|spanish|american|californian)$/i;

const normW = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9' ]+/g, ' ');

// The query's distinctive words ("Green Chartreuse" -> green, chartreuse; "red wine" -> none: nothing to verify).
function distinctiveWords(query) {
  return normW(query).split(/\s+/).filter(w => w.length >= 3 && !/^\d/.test(w) && !GENERICW.test(w) && !FILLERW.test(w));
}

// A word is in a product name as a whole word, without apostrophes ("titos" = "Tito's"), or — 5+ letters — run
// together ("budlight" = "Bud Light").
function carries(productName, word) {
  const pn = ' ' + normW(productName) + ' ', pn0 = pn.replace(/'/g, ''), w0 = word.replace(/'/g, '');
  if (pn.includes(' ' + word + ' ') || pn0.includes(' ' + w0 + ' ')) return true;
  return w0.length >= 5 && pn0.replace(/\s+/g, '').includes(w0);
}

// A grape named next to a producer is checked too (F-0091, Oct 27 connector: "Hess Cabernet" came back as Hess Select
// Treo Red Blend, the only Hess at the store): a product without that grape that names ANOTHER grape or "blend" is not
// it. A name with no grape at all ("Opus One Napa Valley Red Wine") still counts. Same grape: syrah/shiraz, grigio/gris.
const GRAPEW = /^(cabernet|sauvignon|chardonnay|pinot|noir|grigio|gris|merlot|malbec|zinfandel|syrah|shiraz|riesling|tempranillo|sangiovese|moscato|chenin|viognier|gewurztraminer|blend)$/;
const GRAPE_ALT = { syrah: 'shiraz', shiraz: 'syrah', grigio: 'gris', gris: 'grigio' };
function grapesOf(text) { return normW(text).split(/\s+/).filter(w => GRAPEW.test(w)); }
function carriesGrapes(query, productName) {
  const asked = grapesOf(query);
  if (!asked.length) return true;
  const has = g => carries(productName, g) || !!(GRAPE_ALT[g] && carries(productName, GRAPE_ALT[g]));
  if (asked.every(has)) return true;
  return !grapesOf(productName).some(g => !asked.includes(g) && !asked.includes(GRAPE_ALT[g]));
}

// A bottling number is part of the name (F-0090, Oct 27 connector: "Penfolds Bin 407" came back as Bin 389 / 600 / 311 —
// numbers were never checked). Read: "bin|no|lot|cask|batch|# N", and a bare number right after a word that ends the
// query or is followed by year(s)/yr/old ("Macallan 18", "Glenlivet 12 year"). Never a size (750, 1.75), a count before
// the name ("3 Tito's"), a pack ("12 pack", "24 x"), or a vintage year (19xx/20xx).
const SIZEN = /^(50|100|187|200|355|375|500|700|720|750|1000|1500|1750|3000)$/;
function modelNumbers(query) {
  const t = normW(query).split(/\s+/).filter(Boolean), out = [];
  for (let i = 1; i < t.length; i++) {
    const n = t[i];
    if (!/^\d{1,4}$/.test(n) || SIZEN.test(n) || /^(19|20)\d\d$/.test(n)) continue;
    const prev = t[i - 1], next = t[i + 1] || '';
    if (/^(bin|no|lot|cask|batch|number|cuvee)$/.test(prev)) { out.push(n); continue; }
    if (/^\d/.test(prev) || !distinctiveWords(prev).length) continue;
    if (!next || /^(year|years|yr|yrs|yo|old)$/.test(next)) out.push(n);
  }
  return out;
}
function carriesNumber(productName, n) { return new RegExp('(^|[^0-9])' + n + '(?![0-9])').test(normW(productName)); }

// The producer key = the first two distinctive words. A result counts as the product only if it carries both, plus the
// grapes and bottling numbers the query names.
function keyOf(query) { return distinctiveWords(query).slice(0, 2); }
function fits(query, productName) { return carriesGrapes(query, productName) && modelNumbers(query).every(n => carriesNumber(productName, n)); }
function isMatch(query, productName) { const key = keyOf(query); return !key.length || (key.every(k => carries(productName, k)) && fits(query, productName)); }

// Order products by how many of the query's distinctive words they carry (stable: price / core order kept within a tie).
// found = some product carries the key, or the query has no distinctive word to check.
function rankByMatch(query, products) {
  const words = distinctiveWords(query), key = words.slice(0, 2);
  const list = Array.isArray(products) ? products : [];
  if (!words.length) return { products: list, found: list.length > 0, key };
  const scored = list.map((p, i) => ({ p, i, s: words.filter(w => carries(p && p.name, w)).length, m: key.every(k => carries(p && p.name, k)) && fits(query, p && p.name) }));
  scored.sort((a, b) => (b.m - a.m) || (b.s - a.s) || (a.i - b.i));
  const matched = scored.filter(x => x.m);
  // key (logged by product_query's dropped / NOT FOUND lines) names the grapes + numbers too, so the log says why.
  return { products: matched.map(x => x.p), unrelated: scored.filter(x => !x.m).map(x => x.p), found: matched.length > 0, key: key.concat(grapesOf(query), modelNumbers(query)) };
}

// Place words aren't the wine's own name: a producer's bottle missing "Napa" is still that producer's wine.
const REGIONW = /^(napa|sonoma|paso|robles|carneros|russian|river|coast|county|district|central|north|south|california|oregon|washington|willamette|mendocino|monterey|santa|barbara|lucia|highlands|alexander|knights|dry|creek|columbia|lodi|livermore|howell|mountain|oakville|rutherford|stags|leap|bordeaux|burgundy|tuscany|toscana|rioja|mendoza|marlborough|barossa|provence|loire|rhone|chianti|classico)$/i;

// The query's distinctive words AFTER the producer key that none of the matched products carries — the wine's own name
// ("Orin Swift Prisoner" -> prisoner when only Orin Swift Abstract / Sign of the Times matched). F-0089 (Oct 27,
// connector): the 2-word key let any Orin Swift wine count as "The Prisoner". Place words are never counted.
// Descriptors a store's name often leaves out ("Grey Goose Vodka Original", "Johnnie Walker Black Label") aren't counted.
const DESCW = /^(original|label|year|years|old|aged|edition|limited|select|selection|single|barrel|straight|small|batch|proof|imported|import|bottle|bottles|bottled|liter|litre|liters)$/i;
function missingNameWords(query, matched) {
  const extra = distinctiveWords(query).slice(2).filter(w => !REGIONW.test(w) && !DESCW.test(w));
  const list = Array.isArray(matched) ? matched : [];
  if (!list.length) return [];
  return extra.filter(w => !list.some(p => carries(p && p.name, w)));
}

module.exports = { GENERICW, normW, distinctiveWords, carries, keyOf, isMatch, rankByMatch, missingNameWords, grapesOf, carriesGrapes, modelNumbers, carriesNumber };
