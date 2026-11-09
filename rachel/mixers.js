// Mixers the customer names for an event (DC, Oct 7). "mostly spirits ... mixed with coke and oj" built a package with no
// Coke or OJ and ultra-premium sipping bottles; Claude then listed what to change and asked the customer to rebuild. Read in
// code (rule 6) from the customer's own words on every channel: the connector's rachel_build_package (serving_mix + request
// text) and Slack / email / WhatsApp menu_build (rachel.js, everything the customer said). shopping-agent menu_build adds
// the lines sized to the spirit drinks and keeps the spirits at mixing quality (event price ceilings).
const MIXERS = [
  { key: 'cola',        re: /\b(coke|coca[\s-]?cola|cola|pepsi)\b(?!\s*zero|\s*diet)/i, search: 'Coca Cola 2 L', label: 'Coke' },
  { key: 'diet_cola',   re: /\b(diet\s+(coke|pepsi|cola)|coke\s+zero|pepsi\s+zero)\b/i, search: 'Diet Coke 2 L', label: 'Diet Coke' },
  { key: 'orange',      re: /\b(oj|orange\s+juice)\b/i, search: 'Orange Juice', label: 'Orange juice' },
  { key: 'cranberry',   re: /\bcran(berry)?(\s+juice)?\b/i, search: 'Cranberry Juice', label: 'Cranberry juice' },
  { key: 'pineapple',   re: /\bpineapple\s+juice\b/i, search: 'Pineapple Juice', label: 'Pineapple juice' },
  { key: 'grapefruit',  re: /\bgrapefruit\s+(juice|soda)\b/i, search: 'Grapefruit Juice', label: 'Grapefruit juice' },
  { key: 'tonic',       re: /\btonics?(\s+water)?\b/i, search: 'Tonic Water', label: 'Tonic water' },
  { key: 'soda_water',  re: /\b(club\s+soda|soda\s+water|seltzer\s+water|sparkling\s+water|(vodka|whiske?y|scotch|bourbon|tequila)\s+sodas?)\b/i, search: 'Club Soda', label: 'Club soda' },
  { key: 'ginger_ale',  re: /\bginger\s+ale\b/i, search: 'Ginger Ale', label: 'Ginger ale' },
  { key: 'ginger_beer', re: /\bginger\s+beer\b/i, search: 'Ginger Beer', label: 'Ginger beer' },
  { key: 'lemon_lime',  re: /\b(sprite|7[\s-]?up|lemon[\s-]lime\s+soda)\b/i, search: 'Sprite 2 L', label: 'Sprite' },
  { key: 'lemonade',    re: /\blemonade\b/i, search: 'Lemonade', label: 'Lemonade' },
];

const clean = t => String(t || '').replace(/<rachel_system_notes>[\s\S]*?<\/rachel_system_notes>/g, ' ');

// The mixers named in the text, in the order of the table (each once).
function mixersIn(text) {
  const t = clean(text);
  if (!t.trim()) return [];
  const out = MIXERS.filter(m => m.re.test(t));
  // "diet coke" names Diet Coke, not Coke too
  if (out.some(m => m.key === 'diet_cola') && !/\b(?<!diet\s)(coke|coca[\s-]?cola|pepsi)\b(?!\s*zero)/i.test(t.replace(/\bdiet\s+(coke|pepsi|cola)\b/gi, ''))) return out.filter(m => m.key !== 'cola');
  return out;
}

// Spirits served in mixed drinks (a mixer named, or "mixed drinks" / "highballs" / "with coke"): mixing quality, not sipping.
function mixedDrinks(text) {
  const t = clean(text);
  return mixersIn(t).length > 0 || /\b(mixed\s+drinks?|mixers?|highballs?|rum\s+and|vodka\s+(sodas?|tonics?|cran)|gin\s+and\s+tonics?)\b/i.test(t);
}

// "Mixers" / "mixed drinks" asked for without naming any ("open bar with mixed drinks (spirits + mixers)") -> a standard set, none of them a
// soft drink the customer didn't name (mixer-guard.js): tonic, club soda, cranberry and orange juice. Nov 9 (DC, Claude
// Code): the package had no mixers at all and the reply never said so. "no mixers" / "we have mixers" -> none.
const DEFAULT_MIXERS = ['tonic', 'soda_water', 'cranberry', 'orange'];
function mixersFor(text) {
  const named = mixersIn(text).map(m => m.key);
  if (named.length) return { keys: named, defaulted: false };
  const t = clean(text).toLowerCase();
  if (!/\bmixers?\b|\bmixed\s+drinks?\b/.test(t)) return { keys: [], defaulted: false };   // mixed drinks need mixers too (Nov 9)
  if (/\b(no|without|skip|not|don'?t need|(?:we|i)\s+(?:have|already have|bring|will bring|'ll bring))\s+(?:any\s+|the\s+|our\s+own\s+)?mixers?\b|\bmixers?\s+(?:on hand|covered|taken care of)\b/.test(t)) return { keys: [], defaulted: false };
  return { keys: DEFAULT_MIXERS.slice(), defaulted: true };
}
function defaultMixersNote(added) {
  const labels = MIXERS.filter(m => (added || DEFAULT_MIXERS).includes(m.key)).map(m => m.label.toLowerCase());
  if (!labels.length) return '';
  const list = labels.length > 1 ? labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1] : labels[0];
  return 'You asked for mixers without naming them, so I added ' + list + ' — tell me if you would like different ones.';
}

module.exports = { mixersIn, mixedDrinks, mixersFor, defaultMixersNote, DEFAULT_MIXERS, MIXERS };
