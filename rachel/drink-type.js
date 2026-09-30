// The TYPE of a drink — what a stand-in must match before price or name words count.
// Real complaint (DC, Sep 30): "Lillet Blanc 750 mL -> Ruinart Blanc de Blancs Brut" — an aperitif replaced by a
// $138 champagne because both names contain "blanc". An aperitif is replaced by an aperitif, a sparkling wine by
// a sparkling wine, a red by a red; a spirit by the same spirit type.
//
// typeOf(product) -> 'aperitif' | 'fortified' | 'sparkling' | 'rose' | 'red' | 'white' | 'spirit:<type>' | ''
//   product: { name, category?, subCategory? } — Bevvi's subCategory ("Aperitif", "Sparkling") decides first.
// searchTerm(type) -> a catalog search for that type ("aperitif", "champagne", ...).

const { spiritType } = require('./spirit-type.js');
const norm = s => ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
const has = (t, re) => re.test(t);

// Most specific first: an aperitif or a sparkling wine often carries a grape or "blanc"/"rose" in its name.
const RULES = [
  ['aperitif', / (lillet|dubonnet|cocchi|aperitif|aperitivo|kina|byrrh|vermouth|aperol|campari|pineau|suze|salers|americano) /],
  ['fortified', / (sherry|port|porto|madeira|marsala|tawny|oloroso|fino|amontillado|manzanilla) /],
  ['sparkling', / (champagne|brut|prosecco|cava|cremant|sparkling|spumante|franciacorta|lambrusco|sekt|pet nat|blanc de blancs|blanc de noirs|moscato d'asti|asti|mumm|veuve|moet|chandon|ruinart|dom perignon|taittinger|bollinger|krug|perrier jouet|laurent perrier|piper heidsieck|la marca|ruffino prosecco|segura viudas|freixenet|korbel|schramsberg|roederer) /],
  ['rose', / (rose|rosado|rosato|blush|whispering angel|miraval|minuty) /],
  ['red', / (cabernet|merlot|pinot noir|zinfandel|syrah|shiraz|malbec|tempranillo|sangiovese|nebbiolo|barolo|barbaresco|chianti|grenache|garnacha|red blend|red wine|bordeaux|rioja|beaujolais|petite sirah|carmenere|montepulciano|primitivo|amarone|brunello|cotes du rhone|chateauneuf|the prisoner|meiomi pinot|red) /],
  ['white', / (sauvignon blanc|chardonnay|pinot grigio|pinot gris|riesling|chenin|gruner|albarino|viognier|moscato|white wine|sancerre|chablis|vinho verde|gewurztraminer|semillon|torrontes|verdejo|vermentino|soave|white|conundrum) /],
];
const SUB = [   // Bevvi subCategory / category words
  ['aperitif', /aperiti|vermouth/], ['fortified', /fortified|sherry|port|dessert/], ['sparkling', /sparkling|champagne|prosecco/],
  ['rose', /\bros[eé]\b/], ['red', /\bred\b/], ['white', /\bwhite\b/],
];

function typeOf(p) {
  const sub = String((p && (p.subCategory || p.subcategory)) || '').toLowerCase();
  for (const [t, re] of SUB) if (re.test(sub)) return t;
  const t = norm(p && p.name);
  for (const [ty, re] of RULES) if (has(t, re)) return ty;
  const s = spiritType(p && p.name);
  return s ? 'spirit:' + s : '';
}

// Non-alcoholic ("Ritual Zero Proof Aperitif Alt", "KSA Kolsch Non-Alcoholic"): a stand-in only for a non-alcoholic
// original, and never the reverse (QA, Sep 30: Ritual Zero Proof was the first alternative for Lillet Blanc).
const isNA = p => / (zero proof|non alcoholic|nonalcoholic|alcohol free|alcohol removed|dealcoholized|0 0|n a|na beer|mocktail|spirit free) /.test(norm(p && p.name)) || /non.?alcoholic/i.test(String((p && (p.subCategory || p.subcategory)) || ''));

const TERMS = { aperitif: 'aperitif', fortified: 'port', sparkling: 'champagne', rose: 'rose', red: 'red wine', white: 'white wine' };
function searchTerm(type) { return TERMS[type] || (String(type).startsWith('spirit:') ? type.slice(7) : ''); }

module.exports = { typeOf, searchTerm, isNA };
