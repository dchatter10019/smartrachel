// Beer styles named in a request -> one catalog search per style, rows kept only when their NAME carries the style word
// and they are beer. Nov 21 (DC, Slack, Bellevue 98004): "recommend a few beer and NA beverage options ... a mix of
// lagers/pilsners, IPAs, wheat beers or Kölsches, and a stout or porter option" — the recommendation searched the single
// word "beer" (Natural Ice, Bud Light, PBR, two meads) and Rachel said there were no IPAs, Kölsches, stouts, porters or NA
// beers at that store; it carries all of them (Bell's Two Hearted, Gaffel Kölsch, Old Rasputin, Black Butte, Athletic...).
// Used by the shopping-agent recommendation intent and buildPackage's beer style lines (functions.js).

const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '');

// name: a word the product NAME must carry (prefix-safe: "wheat" never matches "Wheatley").
const STYLES = [
  { key: 'na', re: /\b(non[- ]?alcoholic|alcohol[- ]free|zero[- ]proof|n\/?a (?:beers?|beverages?|options?|drinks?)|na beers?|0\.0)\b/, label: 'non-alcoholic', terms: ['Non-Alcoholic', 'Athletic'], name: /\b(non[- ]?alcoholic|alcohol[- ]free|athletic|0\.0|zero)\b/ },
  { key: 'pilsner', re: /\b(pilsners?|pilsener|pils)\b/, label: 'pilsner', terms: ['Pilsner', 'Pils'], name: /\b(pilsners?|pilsener|pils)\b/ },
  { key: 'lager', re: /\blagers?\b/, label: 'lager', terms: ['Lager'], name: /\b(lagers?|helles|hell|clara|especial)\b/ },
  { key: 'ipa', re: /\b(ipas?|india pale ales?)\b/, label: 'IPA', terms: ['IPA'], name: /\bipas?\b/ },
  { key: 'pale', re: /\bpale ales?\b/, label: 'pale ale', terms: ['Pale Ale'], name: /\bpale ale\b/ },
  { key: 'wheat', re: /\b(wheat(?: beers?| ales?)?|hefeweizen|hefe|witbier|weiss(?:bier)?|belgian white)\b/, label: 'wheat beer', terms: ['Hefeweizen', 'Wheat', 'Belgian White', 'Weiss'], name: /\b(wheat|hefeweizen|hefe|witbier|weiss(?:bier)?|weissbier|belgian white)\b/ },
  { key: 'kolsch', re: /\b(kolsch(?:es)?|koelsch)\b/, label: 'Kölsch', terms: ['Kolsch'], name: /\b(kolsch|koelsch)\b/ },
  { key: 'stout', re: /\bstouts?\b/, label: 'stout', terms: ['Stout'], name: /\bstouts?\b/ },
  { key: 'porter', re: /\bporters?\b/, label: 'porter', terms: ['Porter'], name: /\bporters?\b/ },
  { key: 'sour', re: /\b(sours?|gose)\b(?! mix)/, label: 'sour', terms: ['Sour', 'Gose'], name: /\b(sour|gose)\b/ },
  { key: 'amber', re: /\b(amber|red ale)\b/, label: 'amber', terms: ['Amber'], name: /\b(amber|red ale)\b/ },
];

// Styles named in the text, in the order written.
function stylesIn(text) {
  const t = fold(text);
  return STYLES.map(s => { const m = t.match(s.re); return m ? Object.assign({ at: m.index }, s) : null; }).filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

const NOT_BEER = /\b(vodka|gin|rum|tequila|whiske?y|bourbon|scotch|mead|wine|martini|margarita|spritz|seltzer|cocktail|liqueur|cider|cidre|sake|soju|kombucha)\b/;
const FLAVOR = /\b(lime|lemon|limon|mango|grapefruit|pineapple|peach|berry|cherry|raspberry|strawberry|orange|chelada|chili|chile|clamato|tropical|vanilla|chocolate|coffee|pumpkin|watermelon|guava|passion ?fruit|cola|maple|honey)\b/;
const isBeerRow = p => {
  const n = fold(p && p.name), c = fold((p && (p.category || '')) + ' ' + (p && (p.subCategory || p.subcategory || '')));
  if (NOT_BEER.test(n)) return false;
  return !c.trim() || /beer|ale|lager|stout|malt/.test(c) || /\d+\s*x\s*\d+(?:\.\d+)?\s*oz|\boz (?:can|bottle)/.test(n);
};

// Rows of that style (name word + beer), flavoured ones after the plain ones unless the request names the flavour.
function rowsFor(style, rows, requestText) {
  const req = fold(requestText), seen = new Set();
  const hit = (rows || []).filter(p => {
    const n = fold(p && p.name); if (!n || seen.has(n)) return false;
    if (!style.name.test(n) || !isBeerRow(p)) return false;
    if (style.key !== 'na' && /\b(non[- ]?alcoholic|alcohol[- ]free|0\.0)\b/.test(n)) return false;   // an NA row is not the style
    seen.add(n); return true;
  });
  const flav = p => { const m = fold(p.name).match(FLAVOR); return m && req.indexOf(m[1]) < 0; };
  return hit.filter(p => !flav(p)).concat(hit.filter(flav));
}

module.exports = { STYLES, stylesIn, rowsFor, isBeerRow, FLAVOR };
