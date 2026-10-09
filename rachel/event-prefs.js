// Which spirits and which beer an EVENT customer asked for, read in code from their own words (DC, Oct 9).
// Real (Oct 7, claude.ai connector): "Oktoberfest-themed party ... beer (Oktoberfest selections), bourbon, and tequila bar"
// and the revision "only bourbon and tequila — remove the vodka, rum and gin" were never passed to menu_build: every
// rebuild was the same five-spirit full bar with Stella + Goose Island. Used by rachel.js (Slack / email / WhatsApp
// menu_build) and rachel-mcp.js (rachel_build_package); buildPackage takes spirit_types + beer_terms.

// buildPackage's spirit slots (functions.js SPIRIT_KW). Whiskey words fill the bourbon slot.
const SPIRITS = { vodka: /\bvodkas?\b/, rum: /\brums?\b/, bourbon: /\b(bourbons?|whiske?ys?|rye)\b/, gin: /\bgins?\b/, tequila: /\b(tequilas?|mezcal)\b/ };
const ALL = Object.keys(SPIRITS);
// "no vodka", "remove the vodka, rum and gin", "without gin", "skip rum", "except vodka", "not vodka" — the negation
// covers a following list ("no vodka, rum or gin").
const NEG = /\b(no|not|without|remove|drop|skip|except|exclude|minus|leave out|take out|instead of|cut)\s+(?:the\s+|any\s+)?((?:[a-z]+(?:\s*,\s*|\s+(?:and|or|&)\s+|\s+)){0,6}[a-z]+)/g;

function norm(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'"); }

function spiritTypesIn(text) {
  const t = norm(text);
  const excluded = new Set();
  let m;
  NEG.lastIndex = 0;
  while ((m = NEG.exec(t))) for (const k of ALL) if (SPIRITS[k].test(m[2])) excluded.add(k);
  // Mentions outside the negated spans count as wanted.
  const pos = t.replace(NEG, ' ');
  // "mostly whiskey drinkers" / "mainly tequila" leans the bar, it doesn't shrink it to one spirit.
  const lean = new RegExp('\\b(mostly|mainly|primarily|mostly drinking|lots of|plenty of)\\s+(?:[a-z]+\\s+)?(?:' + ALL.map(k => SPIRITS[k].source.replace(/\\b/g, '')).join('|') + ')');
  if (lean.test(pos)) return excluded.size ? { types: ALL.filter(k => !excluded.has(k)), why: 'all but ' + [...excluded].join(', ') } : null;
  const wanted = ALL.filter(k => SPIRITS[k].test(pos) && !excluded.has(k));
  if (wanted.length) return { types: wanted, why: 'named: ' + wanted.join(', ') + (excluded.size ? ' (not: ' + [...excluded].join(', ') + ')' : '') };
  if (excluded.size) { const rest = ALL.filter(k => !excluded.has(k)); return { types: rest, why: 'all but ' + [...excluded].join(', ') }; }
  return null;
}

// Beer styles -> catalog search terms, the closest family first. The catalog has no style field, so the terms are words
// that appear in product names (brands for "German").
const GERMAN = ['Paulaner', 'Spaten', 'Hacker-Pschorr', 'Weihenstephaner', 'Hofbrau', 'Ayinger', 'Warsteiner', 'Bitburger', 'Radeberger', "Beck's", 'Erdinger', 'Franziskaner', 'Krombacher', 'St. Pauli'];
const STYLES = [
  { re: /\b(oktoberfest|octoberfest|marzen|festbier|fest bier)\b/, label: 'Oktoberfest', terms: ['Oktoberfest', 'Octoberfest', 'Marzen', 'Festbier'], then: { label: 'German', terms: GERMAN } },
  { re: /\bgerman\b/, label: 'German', terms: GERMAN },
  { re: /\bmexican\b/, label: 'Mexican', terms: ['Corona', 'Modelo', 'Pacifico', 'Dos Equis', 'Tecate'] },
  { re: /\blight beers?\b/, label: 'light', terms: ['Bud Light', 'Miller Lite', 'Coors Light', 'Michelob Ultra'] },
  { re: /\bipas?\b/, label: 'IPA', terms: ['IPA'] },
  { re: /\b(pilsners?|pils)\b/, label: 'pilsner', terms: ['Pilsner'] },
  { re: /\blagers?\b/, label: 'lager', terms: ['Lager'] },
  { re: /\b(stouts?|porters?)\b/, label: 'stout', terms: ['Stout', 'Porter'] },
  { re: /\b(hefeweizen|wheat beers?|witbier|weiss)\b/, label: 'wheat', terms: ['Hefeweizen', 'Wheat', 'Witbier', 'Weiss'] },
];
// Only a style the customer ties to BEER counts: "Oktoberfest-themed party" alone is a theme; "beer (Oktoberfest
// selections)" / "German beers" / "Oktoberfest beer" is the beer. Within ~60 characters of "beer"/"bier"/"lager".
function beerStyleIn(text) {
  const t = norm(text);
  for (const s of STYLES) {
    const re = new RegExp(s.re.source, 'g'); let m;
    while ((m = re.exec(t))) {
      const near = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      if (/\b(beers?|biers?|lagers?|ales?|ipas?|pilsners?|brews?)\b/.test(near)) return s;
    }
  }
  return null;
}

// A list line that IS a style ("Oktoberfest Beer", "German beers", "IPA - 2 cases") — nothing left once the style word,
// beer words, counts and sizes are removed. A named product that only CONTAINS a style word is not: Oct 9 (staging
// nightly scenario 78, right after the style handling shipped) "Stella Artois Premium Lager Beer 24 x 12 oz Cans" was read
// as "any lager" and became Busch Light.
function isStyleLine(name) {
  const s = beerStyleIn(name);
  if (!s) return null;
  const rest = norm(name).replace(new RegExp(s.re.source, 'g'), ' ')
    .replace(/\b(beers?|biers?|selections?|styles?|ales?|brews?|cans?|bottles?|btls?|cases?|packs?|pk|oz|ml|l|x|of|a|an|the|some|any|assorted|variety|mix|or|and|like|similar)\b/g, ' ')
    .replace(/[\d.,()\/&+-]+/g, ' ').trim();
  return rest ? null : s;
}

module.exports = { spiritTypesIn, beerStyleIn, isStyleLine, ALL_SPIRITS: ALL };
