// Tequila in any Bevvi package or proposal is Mi Campo (DC standing rule; Voiceflow BuildPackage v2.7.10-14 /
// SearchProducts v2.5-2.6, Oct 21). A GENERIC tequila line ("Tequila", "blanco tequila", the full bar's tequila slot,
// a margarita's base) is Mi Campo when the store carries it — whatever the derived price floor; only the customer's own
// spirit caps can rule it out — and the budget upgrade never swaps it. A branded request ("Patron") is left alone.
function deaccent(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }
const isMiCampo = name => /\bmi[ -]?campo\b/i.test(String(name || ''));

function isGenericTequila(term) {
  const t = deaccent(term).toLowerCase();
  if (t.indexOf('tequila') < 0) return false;
  const rest = t.replace(/\b(tequila|tequilas|blanco|silver|plata|white|reposado|anejo|extra|cristalino|joven|premium|top|shelf|good|best|nice|great|a|an|the|some|recommend|recommendation|me|for|of|and|or|bottle|bottles|base|spirit|\d+(?:\.\d+)?\s*(?:ml|l|oz))\b/g, ' ').replace(/[^a-z]+/g, ' ').trim();
  return rest === '';
}

const isMini = p => /(^|[^0-9])(50|100|200)\s?ml\b|\bmini(ature)?s?\b|\bnip\b/i.test(String((p && p.name) || '') + ' ' + String((p && (p.sizeStr || p.size)) || ''));
const is750 = p => /\b750\s*ml\b/i.test(String(p.name || '') + ' ' + String(p.sizeStr || p.size || ''));

// The Mi Campo bottle for a tequila line: Blanco 750 mL, then any 750 mL Mi Campo (NYC carries Reposado 750 + Blanco 1 L),
// then Blanco in another size, then any. `caps` = the customer's own {min, max} per bottle (0 = none).
function bestMiCampo(rows, caps) {
  const min = (caps && +caps.min) || 0, max = (caps && +caps.max) || 0;
  const c = (rows || []).filter(p => p && isMiCampo(p.name) && /tequila/i.test(p.name) && !isMini(p) && (+p.price || 0) > 0
    && (!min || +p.price >= min) && (!max || +p.price <= max));
  const rank = p => (/blanco|silver|plata/i.test(p.name) ? 0 : 1) + (is750(p) ? 0 : 2);
  c.sort((a, b) => rank(a) - rank(b) || a.price - b.price);
  return c[0] || null;
}

module.exports = { isMiCampo, isGenericTequila, bestMiCampo };
