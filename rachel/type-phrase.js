// Generic drink TYPE phrases whose first word is not a brand (Nov 20, DC on Slack, Coral Springs: the fuzzy fallback
// broad-searched "Triple" for "Triple Sec" and offered Alizé Triple Melon Liqueur, "no sec in stock").
// acceptFor(term) -> a RegExp a fallback product's name must match to stand in for that phrase, or null (not a type phrase).
const PHRASES = [
  [/\btriple\s+sec\b/i, /\b(?:triple\s+sec|cointreau|grand\s+marnier|cura[cç]ao|orange\s+liqueur)\b/i],
  [/\bsimple\s+syrup\b/i, /\bsimple\s+syrup\b/i],
  [/\blemon\s+juice\b/i, /\blemon\s+juice\b/i],
  [/\blime\s+juice\b/i, /\blime\s+juice\b/i],
  [/\b(?:sour\s+mix|sweet\s+(?:and|&|n)\s+sour)\b/i, /\b(?:sour\s+mix|sweet\s+(?:and|&|n)\s+sour|margarita\s+mix)\b/i],
  [/\bclub\s+soda\b/i, /\b(?:club\s+soda|soda\s+water|seltzer\s+water)\b/i],
  [/\btonic\s+water\b/i, /\btonic\b/i],
  [/\birish\s+cream\b/i, /\birish\s+cream\b|\bbaileys\b/i],
];
function acceptFor(term) {
  const t = String(term || '');
  for (const [is, ok] of PHRASES) if (is.test(t)) return ok;
  return null;
}
module.exports = { acceptFor };
