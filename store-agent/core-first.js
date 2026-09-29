// Search ranking: a brand's core expressions before its specialty bottles (see shopping-agent searches).
const CORE_EXPR = new Set(['blanco', 'silver', 'plata', 'reposado', 'anejo', 'añejo', 'white', 'gold', 'original', 'classic']);
const SEARCH_NOISE = new Set(['ml', 'l', 'oz', 'tequila', 'vodka', 'whiskey', 'whisky', 'bourbon', 'rum', 'gin', 'scotch', 'mezcal', 'cognac', 'brandy', 'wine', 'beer', 'the', 'of', 'and', 'straight', 'kentucky']);
function coreFirst(query, rows) {
  const words = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b\d+(\.\d+)?\s*(ml|l|oz)\b/g, ' ')
    .replace(/\(?\b\d+(\.\d+)?\s*proof\b\)?/g, ' ')   // "750 ML (80 Proof)" is the plain bottle   // sizes only: "1942" and "70" are expressions
    .split(/[^a-z0-9']+/).filter(w => w && !SEARCH_NOISE.has(w));
  const qw = new Set(words(query));
  const isCore = p => words(p.name).filter(w => !qw.has(w)).every(w => CORE_EXPR.has(w));
  // A size the customer stated sorts first (then core within it). Real bug (Sep 29 smoke): the
  // $35.20 "Grey Goose Vodka 750 ML (80 Proof)" ranked below 200 mL / 375 mL / 1.75 L and was cut.
  const ml = x => { const m = String(x || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|l|oz)\b/); return m ? Math.round(parseFloat(m[1]) * (m[2] === 'l' ? 1000 : m[2] === 'oz' ? 29.57 : 1)) : 0; };
  const want = ml(query);
  if (want) {
    const sized = rows.filter(p => Math.abs(ml(p.name || p.size) - want) <= want * 0.03);
    const bare = query.replace(/(\d+(?:\.\d+)?)\s*(ml|l|oz)\b/i, ' ');
    if (sized.length && sized.length < rows.length) return coreFirst(bare, sized).concat(coreFirst(bare, rows.filter(p => sized.indexOf(p) < 0)));
  }
  const core = rows.filter(isCore), rest = rows.filter(p => !isCore(p));
  if (core.length && rest.length && rows.indexOf(core[0]) > 0)
    console.log('[search] "' + query + '" — core expressions first: ' + core.map(p => p.name).join(' | ') + ' (before ' + rest.length + ' specialty row(s))');
  return core.concat(rest);
}

// Bevvi's search needs a space between a size and its unit: "Don Julio Tequila 750ml" returns 0 rows,
// "750 ml" returns 9 (checked Sep 29, zip 33409). The size-stripped fallback then fetched the brand
// in every size and the 750 mL Blanco / Reposado never came back.
function spaceSize(q) { return String(q || '').replace(/(\d)(ml|cl|l|oz)\b/gi, '$1 $2'); }

module.exports = { coreFirst, spaceSize };
