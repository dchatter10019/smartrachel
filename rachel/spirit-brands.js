'use strict';
// The brand the customer chose for a spirit type in an event ("use high west for bourbon", "Grey Goose for the vodka",
// "for tequila use Casamigos"). F-0288 (Nov 18, DC on Slack, Foodie For All): after "Use only 750 ml bottles… use high
// west for bourbon" a later rebuild of the event package picked Woodford Reserve again — the choice lived only in the
// basket the rebuild replaced. Read from everything the customer said (latest statement per type wins) and passed to
// menu_build as spirit_brands -> buildPackage takes that brand for the type's slot when the store carries it.

const TYPES = {
  vodka: /^vodka$/, gin: /^gin$/, rum: /^rum$/, tequila: /^tequila$/, mezcal: /^mezcal$/,
  bourbon: /^bourbon$/, whiskey: /^whiske?y$/, scotch: /^scotch$/, rye: /^rye$/, cognac: /^(?:cognac|brandy)$/,
};
const TYPE_ALT = 'vodka|gin|rum|tequila|mezcal|bourbon|whiske?y|scotch|rye|cognac|brandy';
const STOP = /^(?:the|a|an|any|all|some|only|just|it|that|this|them|more|less|one|bottles?|750|ml|instead|same|other|another|different|cheaper|better|good|regular|plain)$/i;

function typeKey(w) {
  const l = String(w || '').toLowerCase();
  for (const k of Object.keys(TYPES)) if (TYPES[k].test(l)) return k;
  return null;
}

function cleanBrand(b) {
  const words = String(b || '').replace(/[*_`"“”]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length && STOP.test(words[0])) words.shift();
  const out = words.slice(-4);
  if (!out.length || out.every(w => STOP.test(w)) || typeKey(out[out.length - 1])) return '';
  return out.join(' ');
}

// -> { bourbon: 'high west', ... } in the order stated (a later statement for a type replaces an earlier one).
function brandsIn(text) {
  const out = {};
  const s = String(text || '').replace(/[…]/g, '. ');
  const pats = [
    // "use high west for bourbon", "use Grey Goose for the vodka", "go with Casamigos for any tequila"
    new RegExp('\\b(?:use|go\\s+with|make\\s+it|pick|choose|want)\\s+([a-z0-9\'’&\\- ]{2,40}?)\\s+for\\s+(?:the\\s+|any\\s+|all\\s+(?:the\\s+)?)?(' + TYPE_ALT + ')\\b', 'gi'),
    // "for bourbon use high west", "for the vodka, use Tito's"
    new RegExp('\\bfor\\s+(?:the\\s+)?(' + TYPE_ALT + ')\\s*,?\\s+(?:use|go\\s+with|pick)\\s+([a-z0-9\'’&\\- ]{2,40}?)(?=[.,;!?\\n]|\\s+and\\b|$)', 'gi'),
  ];
  const hits = [];
  for (let i = 0; i < pats.length; i++) {
    let m;
    while ((m = pats[i].exec(s))) {
      const brand = cleanBrand(i === 0 ? m[1] : m[2]), type = typeKey(i === 0 ? m[2] : m[1]);
      if (brand && type) hits.push({ at: m.index, type, brand: brand.toLowerCase() });
    }
  }
  hits.sort((a, b) => a.at - b.at).forEach(h => { out[h.type] = h.brand; });
  return out;
}

module.exports = { brandsIn, typeKey };
