// Alternatives for products the store doesn't carry ("Paul Hobbs Richard Dinner Chardonnay" ->
// what here is closest?). Deterministic ranking — the LLM only narrates it.
//
// Real complaint (DC, Sep 27): asked for Paul Hobbs Richard Dinner Vineyard (~$85, Sonoma
// Mountain) and Ramey Russian River (~$45) Chardonnay; neither stocked. Rachel's "alternatives"
// went through the recommendation intent (customer's own price profile, no anchor to the
// originals) and led with La Crema at $21 as "a solid stand-in for the Ramey" — while Flowers
// Sonoma Coast ($55), Far Niente ($79), Rombauer ($47) and Frank Family Carneros ($42) were in
// stock. Now: anchor each original to its web market price, keep candidates of the same varietal
// and style, rank in-tier (±30%) first, then region closeness, then price closeness, and label
// every alternative with the original it replaces and its honest tier.

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Varietals / types, most specific first.
const VARIETALS = [
  'cabernet sauvignon', 'sauvignon blanc', 'pinot noir', 'pinot grigio', 'pinot gris', 'chenin blanc', 'gruner veltliner',
  'chardonnay', 'merlot', 'zinfandel', 'syrah', 'shiraz', 'malbec', 'riesling', 'grenache', 'tempranillo', 'sangiovese',
  'nebbiolo', 'barolo', 'chianti', 'albarino', 'viognier', 'moscato', 'red blend', 'rose', 'champagne', 'prosecco', 'cava',
  'bourbon', 'rye', 'scotch', 'tequila', 'mezcal', 'vodka', 'gin', 'rum', 'cognac', 'brandy',
];
const ALIASES = { 'cabernet': 'cabernet sauvignon', 'cab': 'cabernet sauvignon', 'sauv blanc': 'sauvignon blanc', 'chard': 'chardonnay', 'rosé': 'rose' };

// Regions: [name words, family, state/country]. A sub-appellation belongs to a family.
const REGIONS = [
  ['sonoma mountain', 'sonoma', 'california'], ['sonoma coast', 'sonoma', 'california'], ['russian river', 'sonoma', 'california'],
  ['alexander valley', 'sonoma', 'california'], ['dry creek', 'sonoma', 'california'], ['carneros', 'sonoma|napa', 'california'],
  ['sonoma', 'sonoma', 'california'],
  ['oakville', 'napa', 'california'], ['rutherford', 'napa', 'california'], ['stags leap district', 'napa', 'california'], ['napa', 'napa', 'california'],
  ['santa rita hills', 'central coast', 'california'], ['santa barbara', 'central coast', 'california'], ['santa lucia', 'central coast', 'california'],
  ['paso robles', 'central coast', 'california'], ['monterey', 'central coast', 'california'], ['central coast', 'central coast', 'california'],
  ['anderson valley', 'mendocino', 'california'], ['mendocino', 'mendocino', 'california'], ['california', '', 'california'],
  ['willamette', 'willamette', 'oregon'], ['oregon', '', 'oregon'], ['washington', '', 'washington'], ['columbia valley', 'columbia', 'washington'],
  ['chablis', 'burgundy', 'france'], ['meursault', 'burgundy', 'france'], ['puligny', 'burgundy', 'france'], ['pouilly', 'burgundy', 'france'],
  ['macon', 'burgundy', 'france'], ['bourgogne', 'burgundy', 'france'], ['burgundy', 'burgundy', 'france'], ['bordeaux', 'bordeaux', 'france'],
  ['sancerre', 'loire', 'france'], ['touraine', 'loire', 'france'], ['loire', 'loire', 'france'], ['champagne', 'champagne', 'france'],
  ['provence', 'provence', 'france'], ['rhone', 'rhone', 'france'], ['france', '', 'france'],
  ['marlborough', 'marlborough', 'new zealand'], ['new zealand', '', 'new zealand'], ['barossa', 'barossa', 'australia'],
  ['mendoza', 'mendoza', 'argentina'], ['tuscany', 'tuscany', 'italy'], ['toscana', 'tuscany', 'italy'], ['piedmont', 'piedmont', 'italy'],
];
// Well-known producers whose names carry no region word (their home region), so an in-tier wine
// isn't ranked "unknown region". Only unambiguous single-region houses.
const PRODUCER_REGION = {
  'far niente': 'napa', 'cakebread': 'napa', 'rombauer': 'carneros', 'frank family': 'napa', 'duckhorn': 'napa', 'stags leap': 'napa',
  "stags' leap": 'napa', 'silver oak': 'napa', 'caymus': 'napa', 'jordan': 'alexander valley', 'flowers': 'sonoma coast',
  'kistler': 'sonoma', 'dumol': 'russian river', 'gary farrell': 'russian river', 'sonoma-cutrer': 'sonoma', 'la crema': 'sonoma coast',
  'kendall-jackson': 'california', 'kendall jackson': 'california', 'paul hobbs': 'sonoma', 'ramey': 'sonoma',
  'the prisoner': 'napa', 'penfolds': 'barossa', 'cloudy bay': 'marlborough', 'kim crawford': 'marlborough', 'louis jadot': 'burgundy',
  'jadot': 'burgundy', 'catena': 'mendoza', 'whispering angel': 'provence',
};

function varietalOf(name) {
  const n = ' ' + norm(name).replace(/[^a-z0-9' ]+/g, ' ') + ' ';
  for (const v of VARIETALS) if (n.includes(' ' + v + ' ')) return v;
  for (const a of Object.keys(ALIASES)) if (n.includes(' ' + norm(a) + ' ')) return ALIASES[a];
  return '';
}
function regionOf(name) {
  const n = ' ' + norm(name).replace(/[^a-z0-9' ]+/g, ' ') + ' ';
  // The region the name mentions first ("Russian River Valley, Sonoma Coast" -> russian river);
  // at the same position the longer (more specific) name wins.
  let best = null, bestAt = Infinity;
  for (const r of REGIONS) { const at = n.indexOf(' ' + r[0] + ' '); if (at >= 0 && (at < bestAt || (at === bestAt && r[0].length > best[0].length))) { best = r; bestAt = at; } }
  if (best) return { name: best[0], family: best[1], state: best[2], from: 'name' };
  for (const p of Object.keys(PRODUCER_REGION)) if (n.includes(' ' + p + ' ')) { const r = REGIONS.find(x => x[0] === PRODUCER_REGION[p]); if (r) return { name: r[0], family: r[1], state: r[2], from: 'producer' }; }
  return null;
}
// 3 same sub-region, 2 same family, 1 same state/country, 0 unknown, -1 known different place.
function regionScore(orig, cand) {
  if (!orig || !cand) return 0;
  if (orig.name === cand.name) return 3;
  const of = String(orig.family || '').split('|').filter(Boolean), cf = String(cand.family || '').split('|').filter(Boolean);
  if (of.some(f => cf.includes(f))) return 2;
  if (orig.state && orig.state === cand.state) return 1;
  return -1;
}
const REGION_LABEL = { 3: 'same sub-region', 2: 'same region', 1: 'same state/country', 0: 'region unknown', '-1': 'different region' };
// Champagne houses count as sparkling even when the name has no style word ("Dom Perignon Luminous Rose").
const isSparkling = n => /\b(champagne|brut|prosecco|cava|sparkling|spumante|cremant|blanc de blancs|blanc de noirs|dom perignon|moet|veuve clicquot|krug|ruinart|taittinger|bollinger|laurent-perrier|perrier-jouet|piper-heidsieck|nicolas feuillatte|mumm|chandon|pol roger|billecart)\b/.test(norm(n));
const notWine = n => /\b(cider|seltzer|spritz|can|cans|hard)\b|\d+\s*x\s*\d+\s*oz/.test(norm(n));
// Bottle volume in mL from the name first (catalog size fields can be wrong), else the size field.
const mlOf = t => { const m = norm(t).match(/(\d+(?:\.\d+)?)\s*(ml|l|cl)\b/); return m ? Math.round(m[2] === 'l' ? +m[1] * 1000 : m[2] === 'cl' ? +m[1] * 10 : +m[1]) : 0; };
const isOddSize = (n, size, wantMl) => /\bbox\b|\btetra\b/.test(norm(n)) || ((mlOf(n) || mlOf(size) || 750) !== (wantMl || 750));

// Rank store candidates for one original. refPrice may be null (no anchor: region then price desc).
// The candidate must be the original's TYPE (drink-type.js) — or original.type when the customer asked for another.
// Real complaint (DC, Sep 30): Lillet Blanc (an aperitif) got Malbec, Cabernet and Sauvignon Blanc here.
const { typeOf, isNA } = require('/home/ubuntu/rachel/drink-type.js');
function rankAlternatives(original, candidates, refPrice, opts) {
  const o = Object.assign({ band: 0.30, perOriginal: 3 }, opts || {});
  const otype = original.type || typeOf({ name: original.name });
  const ov = original.type ? '' : varietalOf(original.name), oreg = regionOf(original.name), ospark = otype === 'sparkling' || (!original.type && (isSparkling(original.name) || ['champagne', 'prosecco', 'cava'].includes(ov)));
  const rejected = [];
  const pool = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = norm(c.name); if (!c.name || seen.has(key)) continue; seen.add(key);
    const price = Number(c.price || c.salePrice || 0); if (!(price > 0)) continue;
    if (isNA(c) !== isNA(original)) { rejected.push([c.name, isNA(c) ? 'non-alcoholic, the original is not' : 'alcoholic, the original is non-alcoholic']); continue; }
    if (otype && typeOf(c) !== otype) { rejected.push([c.name, 'different type (' + (typeOf(c) || '?') + ', not ' + otype + ')']); continue; }
    if (ov && varietalOf(c.name) !== ov && !(ov === 'rose' && /\bros[eé]\b/i.test(c.name))) { rejected.push([c.name, 'different varietal']); continue; }
    if (isSparkling(c.name) !== ospark) { rejected.push([c.name, 'still/sparkling mismatch']); continue; }
    if (notWine(c.name) && !notWine(original.name)) { rejected.push([c.name, 'can/cider/seltzer, not a bottle of wine']); continue; }
    if (isOddSize(c.name, c.size, mlOf(original.name) || 750)) { rejected.push([c.name, 'not a ' + (mlOf(original.name) || 750) + ' mL bottle']); continue; }
    const creg = regionOf(c.name);
    const rs = regionScore(oreg, creg);
    const diff = refPrice ? (price - refPrice) / refPrice : 0;
    const tier = !refPrice ? 'unknown' : Math.abs(diff) <= o.band ? 'same tier' : diff < 0 ? 'lower tier' : 'higher tier';
    pool.push(Object.assign({}, c, { price, replaces: original.name, region: creg ? creg.name : null, region_match: REGION_LABEL[rs], _rs: rs, tier, price_vs_original_pct: refPrice ? Math.round(diff * 100) : null }));
  }
  // Without a price anchor, rank toward the middle of the pool — never the priciest first
  // (real bug: an unanchored rosé led with Dom Perignon Rosé at $659.99).
  const mid = pool.map(x => x.price).sort((x, y) => x - y)[Math.floor(pool.length / 2)] || 0;
  const anchor = refPrice || mid;
  // Order: in-tier first; then region closeness; then closeness to the original's price.
  // A lower-tier wine never outranks an in-tier one, and within out-of-tier wines the nearer
  // price wins (a $55 Sonoma beats a $21 Sonoma for an $85 original).
  pool.sort((a, b) => {
    const ta = a.tier === 'same tier' ? 0 : 1, tb = b.tier === 'same tier' ? 0 : 1; if (ta !== tb) return ta - tb;
    if (refPrice) { const fa = Math.abs(a.price - refPrice) / refPrice > 0.6 ? 1 : 0, fb = Math.abs(b.price - refPrice) / refPrice > 0.6 ? 1 : 0; if (fa !== fb) return fa - fb; }
    if (a._rs !== b._rs) return b._rs - a._rs;
    return Math.abs(a.price - anchor) - Math.abs(b.price - anchor);
  });
  const picks = pool.slice(0, o.perOriginal).map(x => { const y = Object.assign({}, x); delete y._rs; return y; });
  return { original: original.name, type: otype || null, varietal: ov || null, region: oreg ? oreg.name : null, ref_price: refPrice || null,
    alternatives: picks, no_tier_match: !!refPrice && !picks.some(p => p.tier === 'same tier'), considered: pool.length, rejected };
}

module.exports = { rankAlternatives, varietalOf, regionOf, regionScore };
