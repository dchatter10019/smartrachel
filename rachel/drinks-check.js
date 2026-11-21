// "How many drinks is this?" / "Is this enough for 35-40 people?" — answered IN CODE from the live basket (package-facts.js
// servings: a 750 mL wine = 5 glasses, a beer pack = its cans/bottles, a 750 mL spirit = 16 pours) against Rachel's rule of
// thumb (2 drinks the first hour + 1 an hour after, functions.js). When it is short, the top-up is concrete (more packs /
// bottles of lines already in the basket) and held as state.pendingDrinksTopUp: a yes applies exactly that (server.js).
// Nov 21 (DC, Slack, Bellevue, 35-40 guests / 3 h): "how many total drinks?" and "can you check again to ensure there is
// enough bottles to cover for all the drinks?" were routed show_basket (basket only); the model then counted by hand three
// times, once for 20 guests, while the code's sentence said "about 120 drinks total".

const PF = require('./package-facts.js');

const ASK = /\bhow many (?:total |in total )?(?:drinks|servings|glasses|pours|cans|beers)\b|\b(?:total|number of) (?:drinks|servings)\b|\b(?:is|will|would|does|do)\s+(?:this|that|it|these|the (?:basket|order|menu|package|cart))\s+(?:be\s+)?(?:enough|sufficient|cover|last)\b|\benough (?:drinks|bottles|beers?|wine|alcohol|for (?:the |our |all )?(?:\d|guests|people|everyone))\b|\b(?:cover|last)\s+(?:for\s+)?(?:all (?:the )?(?:drinks|guests|people)|(?:the |our )?\d+\s*(?:[-–]|to)?\s*\d*\s*(?:guests|people|ppl))/i;
// A change in the same message is not a question (the edit / build paths read it).
const CHANGE = /\b(?:add|remove|take out|swap|replace|change|make it|increase|decrease|bump|lower|raise|drop|delete|instead|rebuild|build|create|proposal|quote|place|order it)\b/i;

function asks(message) {
  const m = String(message || '');
  return ASK.test(m) && !CHANGE.test(m.replace(/\bthe rule is\b[^.?!\n]*/i, ''));
}

// Guests / hours the message states ("for 35-40 people" -> 40, "for 20 people", "3 to 6 pm" -> 3 h, "3 hour event").
function statedIn(message) {
  const m = String(message || '').toLowerCase(), out = {};
  const g = m.match(/\b(\d{1,4})\s*(?:[-–]|to)\s*(\d{1,4})\s*(?:guests|people|ppl|persons|attendees|pax)\b/) || m.match(/\b(\d{1,4})\s*(?:guests|people|ppl|persons|attendees|pax)\b/);
  if (g) out.guests = +(g[2] || g[1]);
  const h = m.match(/\b(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(?:hours?|hrs?|h)\b/);
  if (h) out.hours = +h[1];
  else {
    const r = m.match(/\b(\d{1,2})(?::\d\d)?\s*(am|pm)?\s*(?:[-–]|to|until|till)\s*(\d{1,2})(?::\d\d)?\s*(am|pm)\b/);
    if (r) { let a = +r[1], b = +r[3]; const ap = r[2] || r[4]; if (ap === 'pm' && a < 12 && (r[2] === 'pm' || a < b)) a += 12; if (r[4] === 'pm' && b < 12) b += 12; if (b > a) out.hours = b - a; }
  }
  return out;
}

const targetPer = hours => (hours > 0 ? (hours <= 1 ? 2 : 2 + (hours - 1)) : 4);
const CAT_LABEL = { wine: 'Wine', beer: 'Beer', spirits: 'Spirits' };
const glassWord = c => (c === 'wine' ? 'glasses' : c === 'spirits' ? 'pours' : 'cans/bottles');
const isNA = li => /\b(non[- ]?alcoholic|alcohol[- ]free|0\.0)\b/i.test(String(li.name || ''));

// -> { text, topUp: [{name, from, to}] | null, delivered, target }
function check(items, o) {
  const guests = +o.guests || 0, hours = +o.hours || 0;
  const rows = (items || []).map(li => ({ li, s: Math.round(PF.servings(li)) })).filter(r => r.s > 0);
  const by = {}; rows.forEach(r => { const c = String(r.li.category || '').toLowerCase(); (by[c] = by[c] || []).push(r); });
  const delivered = rows.reduce((a, r) => a + r.s, 0);
  const lines = Object.keys(CAT_LABEL).filter(c => by[c]).map(c => {
    const n = by[c].reduce((a, r) => a + r.s, 0), units = by[c].reduce((a, r) => a + (+r.li.qty || 0), 0);
    return '• ' + CAT_LABEL[c] + ': ' + units + (c === 'beer' ? ' pack' + (units === 1 ? '' : 's') : ' bottle' + (units === 1 ? '' : 's')) + ' ≈ ' + n + ' ' + glassWord(c);
  });
  let text = 'Your basket has about *' + delivered + ' drinks*:\n' + lines.join('\n');
  if (!guests) return { text: text + '\n\nHow many guests is it for, and for how long? I\'ll check it against that.', topUp: null, delivered, target: 0 };
  const per = targetPer(hours), target = Math.round(guests * per), dpp = Math.round((delivered / guests) * 10) / 10;
  text += '\n\nFor ' + guests + ' guests' + (hours ? ' over ' + hours + ' hour' + (hours === 1 ? '' : 's') : '') + ' that is about ' + dpp + ' drinks per person. ' +
    'I plan on ' + (hours ? '2 drinks the first hour and 1 an hour after — about ' + per + ' a person' : 'about ' + per + ' drinks a person') + ', so about ' + target + ' drinks.';
  if (delivered >= target * 0.95) return { text: text + ' You\'re covered' + (delivered > target * 1.3 ? ' with room to spare' : '') + '.', topUp: null, delivered, target };
  // Short: top up the lines of the categories the customer did NOT fix ("the rule is 3 bottles of wine per type" -> wine
  // fixed), beer first (packs), never an NA line, never a line the customer fixed.
  const fixed = new Set(o.fixedCategories || []);
  const cand = ['beer', 'wine', 'spirits'].filter(c => by[c] && !fixed.has(c)).flatMap(c => by[c].filter(r => !isNA(r.li)));
  let short = target - delivered;
  const add = new Map();
  if (cand.length) {
    // round-robin from the cheapest drink: each pass adds one unit to every line in turn, until covered
    const ppd = r => (+r.li.price || 0) / Math.max(1, r.s / (+r.li.qty || 1));
    cand.sort((a, b) => ppd(a) - ppd(b));
    for (let guard = 0; short > 0 && guard < 200; guard++) {
      const r = cand[guard % cand.length];
      add.set(r, (add.get(r) || 0) + 1); short -= r.s / (+r.li.qty || 1);
    }
  }
  const topUp = [...add.entries()].map(([r, n]) => ({ name: r.li.name, from: +r.li.qty || 0, to: (+r.li.qty || 0) + n, servings: Math.round(n * r.s / (+r.li.qty || 1)) }));
  if (!topUp.length) return { text: text + ' That\'s about ' + (target - delivered) + ' drinks short — tell me what you\'d like to add.', topUp: null, delivered, target };
  const after = delivered + topUp.reduce((a, t) => a + t.servings, 0);
  text += ' That\'s about ' + (target - delivered) + ' drinks short. To cover it' + (fixed.size ? ' (keeping your ' + [...fixed].join(' and ') + ' as is)' : '') + ', I\'d add:\n' +
    topUp.map(t => '• ' + t.name + ': ' + t.from + ' → ' + t.to).join('\n') + '\n\nThat brings it to about ' + after + ' drinks. Want me to make these changes?';
  return { text, topUp, delivered, target };
}

// Categories the customer's words fix ("the rule is 3 bottles of wine per type", "keep the wine at 3 bottles").
function fixedIn(texts) {
  const out = new Set();
  for (const t of texts || []) {
    const m = String(t || '').toLowerCase();
    if (/\b(?:keep|rule is|only|exactly|stay at|stays? at|fixed at)\b[^.?!\n]{0,40}\bwines?\b|\b\d+\s+bottles? (?:of wine )?per (?:type|kind|selection|wine)\b|\bwines?\b[^.?!\n]{0,30}\b(?:\d+\s+bottles?\s+(?:each|per|a)\b)/.test(m)) out.add('wine');
    if (/\b(?:keep|only|exactly)\b[^.?!\n]{0,40}\bbeers?\b/.test(m)) out.add('beer');
  }
  return [...out];
}

// A yes to the held top-up.
const YES = /^\s*(?:yes|yep|yeah|yup|sure|ok(?:ay)?|please|please do|do it|do that|go ahead|sounds good|perfect|great)\b[^?]{0,40}$/i;

module.exports = { asks, statedIn, check, fixedIn, targetPer, YES };
