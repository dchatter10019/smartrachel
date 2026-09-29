// How well a catalog product fits what the customer asked for — decided in code, per list line.
// Real failure (Sep 29, Sean's 22-line email quote, zip 02110): the list builder took the top search
// result by loose term overlap, so "Bud Light 30 pack" became Bud Light Platinum Hard Seltzer 6-pack
// (a real Bud Light 30-pack was in stock), "Warsteiner Pilsener (ONLY PILSENER)" became a variety pack,
// "Sam Adams Octoberfest" became Boston Lager, "Sun Cruiser Lemonade" became the Iced Tea pack (twice),
// and "Pumpkin beer" became a spiked seltzer — all shown as if they were what was asked.
//
// fit(request, product) -> { missing, extra, pack, score }
//   missing: the request's distinctive words (brand + style) the product lacks
//   extra:   type-changing words on the product the request didn't ask for (seltzer, cider, tea, ...)
//   pack:    { want, got, ok } unit counts (30-pack vs 6-pack) when both are known
// verdict(request, product) -> { kind: 'exact' | 'closest', note } — the note says what differs.

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’`]/g, '').replace(/[^a-z0-9.]+/g, ' ').trim();

// Spelling variants that must count as the same word.
const SYN = { oktoberfest: 'octoberfest', pilsner: 'pilsener', pils: 'pilsener', cran: 'cranberry', margaritas: 'margarita',
  ciders: 'cider', ipas: 'ipa', budlight: 'bud light', michelop: 'michelob', pumkin: 'pumpkin', smithwick: 'smithwicks',
  tea: 'tea', iced: 'iced', ice: 'iced', seltzers: 'seltzer', lemonades: 'lemonade', cocktails: 'cocktail', vp: 'variety' };
const canon = w => SYN[w] || w;
const words = s => norm(s).split(/\s+/).map(canon).join(' ').split(/\s+/).filter(Boolean);

// Words that describe the order, not the product: never required to appear on the product. Category words
// ("hard seltzer", "cider") are here too — catalog names often leave them out ("High Noon Variety Pool Pack").
const FILLER = new Set(('a an the of and or with per case cases pack packs pk can cans bottle bottles btl btls oz ml l liter litre ' +
  'x ct count only include including please each assorted premium hard seltzer cider cocktail ' +
  'beer beers wine wines 750 12 16 24 30 15 18 4 6 8 9 10 11 20 36 48').split(' '));
// Style words: what kind of drink was asked for. Missing one costs more than a missing brand word — a
// Sun Cruiser Iced Tea is not "Sun Cruiser Lemonade"; a lemonade from another brand is closer.
const STYLE = ['seltzer', 'cider', 'tea', 'lemonade', 'margarita', 'cocktail', 'lime', 'lemon', 'grapefruit', 'mango', 'peach',
  'cherry', 'orange', 'pineapple', 'watermelon', 'berry', 'strawberry', 'cranberry', 'stout', 'porter', 'ipa', 'lager', 'pilsener',
  'ale', 'wheat', 'white', 'red', 'rose', 'sparkling', 'pumpkin', 'octoberfest', 'amber', 'esb', 'sour', 'hazy', 'blonde', 'brown',
  'cabernet', 'merlot', 'pinot', 'chardonnay', 'sauvignon', 'blanc', 'malbec', 'riesling', 'zinfandel', 'syrah', 'prosecco'];
// Words that CHANGE what a drink is. On the product but not in the request = a different product
// ("Bud Light Platinum Hard Seltzer" for "Bud Light"). Plain descriptors (lager, ale) are not here.
const CHANGERS = ['seltzer', 'hard', 'cider', 'tea', 'lemonade', 'margarita', 'cocktail', 'platinum', 'lime', 'zero', 'non',
  'alcoholic', 'na', 'shandy', 'radler', 'lemon', 'grapefruit', 'mango', 'peach', 'cherry', 'orange', 'pineapple', 'watermelon',
  'berry', 'strawberry', 'imperial', 'double', 'spiced', 'flavored', 'pumpkin',
  'octoberfest', 'winter', 'summer', 'holiday', 'rose', 'sparkling', 'stout', 'porter'];
const TYPE = STYLE;   // styleQuery uses the style words

// Unit count of a pack: "30x12 OZ", "30 pack", "(30 cans per case)", "12pk", "8 pack".
function packCount(s) {
  const t = String(s || '').toLowerCase();
  const m = t.match(/\b(\d{1,2})\s*x\s*\d/) || t.match(/\b(\d{1,2})\s*-?\s*(?:pk|pack|ct|count)\b/) || t.match(/\b(\d{1,2})\s+(?:cans?|bottles?|btls?)\b/);
  return m ? parseInt(m[1], 10) : 0;
}

function fit(request, product) {
  const req = words(request), pn = ' ' + words(product && product.name).join(' ') + ' ' + words(product && (product.sizeStr || product.size)).join(' ') + ' ';
  // A word counts when it starts a product word: "pumpkin" in "Pumpkinhead", "light" in "Light".
  const has = w => pn.includes(' ' + w + ' ') || (w.length >= 4 && pn.includes(' ' + w));
  const distinct = [...new Set(req.filter(w => !FILLER.has(w) && !/^\d/.test(w) && w.length >= 2))];
  const missing = distinct.filter(w => !has(w));
  const reqSet = new Set(req);
  const extra = CHANGERS.filter(w => pn.includes(' ' + w + ' ') && !reqSet.has(w));
  const want = packCount(request), got = packCount((product && product.name) + ' ' + (product && (product.sizeStr || product.size) || ''));
  const pack = { want, got, ok: !want || !got || want === got };
  // Missing words cost most (brand/style), then a changed drink type, then the pack size.
  // Cans asked, a bottle given (a 750 mL Skinnygirl for "margarita cans").
  const pText = String((product && product.name) || '') + ' ' + String((product && (product.sizeStr || product.size)) || '');
  const container = !(/\bcans?\b/i.test(request) && !/\bcans?\b/i.test(pText) && /\b(?:375|750|1000)\s*ml\b|\b1(?:\.75)?\s*l\b/i.test(pText));
  const soft = w => w === 'variety' || w === 'mix';
  // A brand is one thing however many words it has ("Samuel Adams"): the first missing brand word costs 6, the
  // rest 2 — so a missing STYLE (12) outweighs a missing brand: an Oktoberfest beats Sam Adams Boston Lager.
  let brandMiss = 0;
  const cost = w => soft(w) ? 2 : STYLE.includes(w) ? 12 : (brandMiss++ ? 2 : 6);
  const score = -(missing.reduce((a, w) => a + cost(w), 0) + extra.length * 4 + (pack.ok ? 0 : 2) + (container ? 0 : 6))
    + (want && got === want ? 1 : 0);
  return { missing: missing.filter(w => !soft(w)), extra, pack, container, score };
}

function verdict(request, product) {
  const f = fit(request, product);
  if (!f.missing.length && !f.extra.length && f.pack.ok && f.container) return { kind: 'exact', note: '' };
  const bits = [];
  if (f.missing.length) bits.push('no ' + f.missing.join(' ') + ' in stock');
  if (f.extra.length) bits.push('this is ' + f.extra.join(' '));
  if (!f.pack.ok) bits.push(f.pack.got + '-pack, not ' + f.pack.want);
  if (!f.container) bits.push('bottle, not cans');
  return { kind: 'closest', note: bits.join('; ') };
}

// Search terms for a recommended alternative when the named product isn't carried: the request's
// style words without its brand ("Smithwicks Red Ale" -> "red ale"; "Sam Adams Octoberfest 12 cans" ->
// "octoberfest"). Brand = the leading words the product search didn't find.
function styleQuery(request, missingWords) {
  // A brand that starts with a style word names that style too: "Ciderboys" -> cider.
  const style = words(request).filter(w => !/^\d/.test(w)).map(w => TYPE.includes(w) ? w : (TYPE.find(t => t.length >= 4 && w.startsWith(t) && w !== t) || ''))
    .filter(w => w && (!FILLER.has(w) || w === 'cider' || w === 'seltzer'));
  const miss = (missingWords || []).filter(w => TYPE.includes(w));
  const q = [...new Set([...miss, ...style])].map(w => SEARCH_FORM[w] || w);
  return q.length ? q.slice(0, 3).join(' ') + (/\bcans?\b/i.test(request) ? ' can' : '') : '';
}
// The catalog's spelling for a canonical word (the search is literal).
const SEARCH_FORM = { pilsener: 'pilsner', octoberfest: 'oktoberfest' };

// A cleaner retry query: the request's distinctive words + its pack count ("Bud Light 30 pack cans" -> "bud light 30").
function searchKey(request) {
  const d = words(request).filter(w => !FILLER.has(w) && !/^\d/.test(w)).map(w => SEARCH_FORM[w] || w);
  const pk = packCount(request);
  return d.length ? d.join(' ') + (pk ? ' ' + pk : '') : '';
}
// Brand words = distinctive words that aren't style words. A request with none ("Pumpkin beer") is generic.
const brandWords = request => words(request).filter(w => !FILLER.has(w) && !/^\d/.test(w) && w.length >= 2 && !STYLE.includes(w) && w !== 'variety' && w !== 'mix');
// "Warsteiner Premium Pilsener 24 cans" -> "Warsteiner Premium Pilsener" (for "X isn't in stock here").
const displayName = request => String(request || '').replace(/\(.*?\)/g, ' ').replace(/\b\d+\s*(?:x\s*\d+\s*oz|-?\s*(?:pk|pack|packs|cans?|bottles?|ct)\b(?:\s*per\s*case)?)/gi, ' ').replace(/\b(?:cans?|pack|per case)\b/gi, ' ').replace(/\s+/g, ' ').trim();

const isStyle = w => STYLE.includes(w);
module.exports = { isStyle, fit, verdict, packCount, styleQuery, searchKey, brandWords, displayName, words };
