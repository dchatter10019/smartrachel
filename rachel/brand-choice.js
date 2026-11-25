// A list line that offers a CHOICE of brands is ONE line (Nov 25, DC on Slack, Bushburg 10005): "3 1L btls of Bourbon
// (Woodford / Makers Mark)", "2 1L bottles of Vodka (Ketel One / Grey Goose)", "2 1L btls of Tequila (Lalo, Don Fulano, G4)".
// The model's rebuild put EVERY brand in at the full count (3 Woodford + 3 Maker's, 2 Ketel + 2 Grey Goose, Lalo + Don Fulano
// + Don Julio) — $1,149.83 for a $570 list. Here, in code: the customer's choice lines are read from their own words; the
// named_products answering one choice line become ONE line — the first brand they listed, at the line's count — with the other
// brands as `choices` (buildPackage takes the first one the store carries, in the customer's order).
//
// choicesIn(line) -> { qty, size, type, brands: [...] } | null
// collapse(namedProducts, texts) -> log lines (namedProducts edited in place)

const nz = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const SIZE = /\b(\d+(?:\.\d+)?)\s*(ml|l|lt|liters?|litres?|oz)\b/i;
const NOT_BRAND = /^(?:or|and|any|either|etc|similar|something|anything|whatever|the|a|an|this|that|is|are|please|pls|preferred|ideally|if available|or similar)$/i;

function choicesIn(line0) {
  const line = String(line0 || '').replace(/[*_~`]/g, '').replace(/^\s*(?:[-•*·◦▪▫‣○■□►]︎?|\d+[.)])\s+/, '').trim();
  const m = line.match(/^(.*?)\(([^()]+)\)\s*(.*)$/);
  if (!m) return null;
  const inner = m[2].trim();
  if (!/[\/,]|\bor\b/i.test(inner) || /\d+\s*(?:oz|ml)\b|\?/i.test(inner)) return null;
  const brands = inner.split(/\s*(?:\/|,|\bor\b)\s*/i).map(s => s.trim()).filter(s => s && !NOT_BRAND.test(s));
  if (brands.length < 2 || brands.some(b => b.split(/\s+/).length > 4 || !/[a-z]/i.test(b))) return null;
  const head = m[1].trim();
  const qm = head.match(/^\s*(\d{1,4})\b/);
  const sm = head.match(SIZE) || m[3].match(SIZE);
  const type = head.replace(/^\s*\d{1,4}\s*(?:x\s*)?/i, '').replace(SIZE, ' ')
    .replace(/\b(?:btls?|bts?|bottles?|cans?|cases?)\.?\s*(?:of\s+)?/gi, ' ').replace(/\bof\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { qty: qm ? +qm[1] : null, size: sm ? sm[0].replace(/\s+/g, '') : '', type, brands, text: line };
}

const brandHit = (name, brand) => { const n = ' ' + nz(name) + ' ', b = nz(brand); return !!b && n.indexOf(' ' + b + ' ') >= 0; };

function collapse(namedProducts, texts) {
  const log = [];
  if (!Array.isArray(namedProducts) || !namedProducts.length) return log;
  const lines = [].concat(texts || []).filter(Boolean).join('\n').split('\n');
  const seen = new Set();
  for (const l of lines) {
    const c = choicesIn(l);
    if (!c || seen.has(nz(c.text))) continue;
    seen.add(nz(c.text));
    const idx = [];
    namedProducts.forEach((np, i) => { if (np && np.name && c.brands.some(b => brandHit(np.name, b))) idx.push(i); });
    if (!idx.length) continue;
    // keep the line of the customer's FIRST brand (else the first of them); the others are its fallbacks
    const rank = i => { const k = c.brands.findIndex(b => brandHit(namedProducts[i].name, b)); return k < 0 ? 99 : k; };
    const keepI = idx.slice().sort((a, b) => rank(a) - rank(b))[0];
    const keep = namedProducts[keepI];
    const many = c.brands.filter(b => brandHit(keep.name, b)).length > 1;   // the raw choice text as one name ("Bourbon Woodford / Makers Mark")
    const size = (String(keep.name).match(SIZE) || [''])[0] || c.size;
    const nameFor = b => (b + ' ' + c.type + (size ? ' ' + size : '')).replace(/\s+/g, ' ').trim();
    const first = c.brands[Math.min(rank(keepI), c.brands.length - 1)];
    const before = idx.map(i => namedProducts[i].qty + ' x ' + namedProducts[i].name);
    if (many) keep.name = nameFor(c.brands[0]);
    keep.choices = c.brands.filter(b => !brandHit(keep.name, b)).map(nameFor);
    if (c.qty) { keep.qty = c.qty; keep.qty_from_customer = true; delete keep.volume_ml; }
    for (const i of idx.filter(i => i !== keepI).sort((a, b) => b - a)) namedProducts.splice(i, 1);
    log.push(JSON.stringify(c.text) + ' is ONE line, a choice of ' + c.brands.join(' / ') + ': ' + JSON.stringify(before) + ' -> ' + keep.qty + ' x ' + keep.name
      + (keep.choices.length ? ' (else ' + keep.choices.join(', ') + ')' : '') + (many ? '' : ' [first brand found: ' + first + ']'));
  }
  return log;
}

module.exports = { choicesIn, collapse };
