// "Use only 750 ml bottles" — ONE bottle size for the wine and spirits of a basket, read in code (Nov 18, DC on Slack,
// 140-guest package: the model's edit reading REMOVED the 1.75 L vodka / bourbon and the 1.5 L Chandon; the vodka and
// bourbon came back at 1 x 750 mL each — under half the volume — and the sparkling was simply gone). server.js SIZE ONLY:
// each wine / spirit line in another size -> the same product in that size at the same volume; none in that size = kept
// and said. The size holds for the session (state.bottleSizeOnly: alternatives and searches ask for it).
//
// exactSizeIn(text) -> mL | 0      remainderOf(text) -> the message without the size clause ('' = nothing else asked)
const UNIT = u => /^m/i.test(u) ? 1 : /^c/i.test(u) ? 10 : 1000;
const SIZE = '(\\d+(?:\\.\\d+)?)\\s*(ml|cl|l|lt|liters?|litres?)';
const RULES = [
  new RegExp('\\b(?:only|just|all)\\s+(?:use\\s+)?' + SIZE + '\\b(?:\\s*(?:bottles?|sizes?|btls?|s))?', 'i'),
  new RegExp('\\b(?:use|want|need|make\\s+(?:it|them|everything|all))\\s+(?:only\\s+|just\\s+)?' + SIZE + '\\s*(?:bottles?|btls?|sizes?)?\\s+only\\b', 'i'),
  new RegExp('\\b' + SIZE + '\\s*(?:bottles?|btls?|sizes?)?\\s+only\\b', 'i'),
  new RegExp('\\b(?:all|every(?:thing)?)\\b[^.?!\\n]{0,20}\\b(?:in|as)\\s+' + SIZE + '\\b', 'i'),
];
function exactSizeIn(text) {
  const t = String(text || '').replace(/<rachel_system_notes>[\s\S]*?<\/rachel_system_notes>/g, ' ');
  if (/\bor\s+(?:larger|bigger|more|above)\b|\bat\s+least\b|\bminimum\b/i.test(t)) return 0;   // a floor: bottle-size.js
  for (const re of RULES) {
    const m = t.match(re);
    if (m) { const v = Math.round(+m[1] * UNIT(m[2])); if (v >= 187 && v <= 3000) return v; }
  }
  return 0;
}
function remainderOf(text) {
  const parts = String(text || '').split(/\s*(?:\.{2,}|…|[.;!\n]|,|\band\s+(?=(?:use|add|make|swap|change|remove|take|get|switch|replace|increase|decrease|also)\b))\s*/i).map(x => x.trim()).filter(Boolean);
  return parts.filter(p => !exactSizeIn(p)).join('. ').replace(/^(?:and|also|then)\s+/i, '').trim();
}
const mlOf = t => { const m = String(t || '').match(/(\d+(?:\.\d+)?)\s*(ml|cl|l|lt|liters?|litres?)\b/i); return m ? Math.round(+m[1] * UNIT(m[2])) : 0; };
// The product's name without its size ("Belvedere Organic Vodka - 1.75 L" -> "belvedere organic vodka")
const coreOf = n => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '')
  .replace(/\b\d+(?:\.\d+)?\s*(?:ml|cl|l|lt|liters?|litres?)\b/g, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// The same product in the wanted size among search results: same core name, that size (within 5%).
function sameInSize(lineName, products, ml) {
  const want = coreOf(lineName);
  const at = (products || []).filter(p => Math.abs((mlOf(p.name) || mlOf(p.sizeStr || p.size)) - ml) <= ml * 0.05);
  return at.find(p => coreOf(p.name) === want) || null;
}
module.exports = { exactSizeIn, remainderOf, mlOf, coreOf, sameInSize };
