// Event serving mix: which drink types an event request names, and the customer's answer to "what will your guests
// drink most?" as category shares. Shared by server.js (Slack / email / WhatsApp / web chat) and rachel-mcp.js
// (rachel_build_package) so every client asks the same question and reads the answer the same way (DC, Oct 3).
const MIX_SYN = {
  wine: /\b(wines?|vino|reds?|whites?|ros[eé]|champagne|prosecco|bubbly|sparkling)\b/i,
  beer: /\b(beers?|brews?|lagers?|ipas?|seltzers?|hard seltzers?|ciders?)\b/i,
  spirits: /\b(cocktails?|mixed drinks?|liquor|spirits|hard liquor|booze|vodka|tequila|whiske?y|bourbon|rum|gin|shots?|full bar)\b/i
};
function eventDrinkCats(msg) {
  const m = String(msg || '');
  if (!/\b(\d+\s*(people|guests|persons|ppl|attendees|folks|pax)|party|event|wedding|reception|happy hour|gathering|celebration|offsite|off-site|mixer|bar package|open bar)\b/i.test(m)) return null;
  const cats = Object.keys(MIX_SYN).filter(k => MIX_SYN[k].test(m));
  if (/\bfull bar\b/i.test(m)) { for (const k of ['wine', 'beer', 'spirits']) if (!cats.includes(k)) cats.push(k); }
  return cats.length >= 2 ? cats : null;
}
// requireCue: in the ORIGINAL request the categories are just listed, so only a preference
// word ("mostly wine") counts; in the ANSWER to our question, naming a category is enough.
// "just / only beer + wine" and "no liquor" leave the other categories OUT (0%). Real case (Sep 30, DC):
// "the guests just want beer + wine, more beer than wine" was read as wine 30 / beer 50 / liquor 20.
const MIX_SRC = k => MIX_SYN[k].source.replace(/^\\b|\\b$/g, '');
function parseServingMix(msg, cats, requireCue) {
  const r = parseServingMix0(msg, cats, requireCue);
  if (!r) return r;
  const m = String(msg || '').toLowerCase();
  const none = cats.filter(k => new RegExp('\\b(?:no|without|skip(?:ping)?|minus|not any|none of the)\\s+(?:\\w+\\s+)?' + MIX_SRC(k)).test(m));
  const excl = /\b(?:just|only|nothing but|stick(?:ing)? (?:to|with)|strictly|exclusively)\b/.exec(m);
  const named = excl ? cats.filter(k => !none.includes(k) && MIX_SYN[k].test(m.slice(excl.index))) : [];
  const out = cats.filter(k => none.includes(k) || (named.length && !named.includes(k)));
  if (!out.length || out.length === cats.length) return r;
  out.forEach(k => { r.mix[k] = 0; });
  const tot = cats.reduce((a, k) => a + r.mix[k], 0);
  if (!tot) cats.filter(k => !out.includes(k)).forEach(k => { r.mix[k] = 1 / (cats.length - out.length); });
  else cats.forEach(k => { r.mix[k] = r.mix[k] / tot; });
  return { mix: r.mix, why: r.why + '; left out: ' + out.join('/'), excluded: out };
}
function parseServingMix0(msg, cats, requireCue) {
  const m = String(msg || '').toLowerCase();
  const out = {}; cats.forEach(k => { out[k] = 0; });
  // explicit percentages: "50% wine", "wine 50%"
  let pctFound = 0;
  for (const k of cats) {
    const src = MIX_SYN[k].source.replace(/^\\b|\\b$/g, '');
    const a = m.match(new RegExp('(\\d{1,3})\\s*%\\s*(?:of\\s+)?(?:\\w+\\s+)?' + src)) || m.match(new RegExp(src + '\\s*(?:at\\s+|:)?\\s*(\\d{1,3})\\s*%'));
    if (a) { out[k] = Number(a[1] || a[a.length - 1]); pctFound++; }
  }
  if (pctFound >= 1) { const sum = Object.values(out).reduce((x, y) => x + y, 0); const rest = cats.filter(k => !out[k]); const left = Math.max(0, 100 - sum); rest.forEach(k => { out[k] = left / rest.length; }); const tot = Object.values(out).reduce((x, y) => x + y, 0) || 1; cats.forEach(k => { out[k] = out[k] / tot; }); return { mix: out, why: 'percentages' }; }
  const cue = /\b(most|mostly|mainly|primarily|majority|more|heavier|heavy on|lean(?:ing)?|bigger preference|prefer|preference|favorite|love|big on)\b/.test(m);
  if (/\b(even|evenly|equal|equally|balanced|no preference|doesn'?t matter|don'?t care|all the same|a bit of everything|mix of everything|split it)\b/.test(m)) { cats.forEach(k => { out[k] = 1 / cats.length; }); return { mix: out, why: 'even' }; }
  if (requireCue && !cue) return null;
  // "less beer", "not much beer", "no beer" pull a category down
  const low = cats.filter(k => new RegExp('\\b(no|not much|not a lot of|less|light on|little|hardly any|few|minimal)\\s+(?:\\w+\\s+)?' + MIX_SYN[k].source.replace(/^\\b|\\b$/g, '')).test(m));
  // With a preference word, the category right after it ranks first ("some wine, but mostly
  // beer" -> beer > wine); otherwise the order they were named in.
  const cueIdx = cue ? m.search(/\b(most|mostly|mainly|primarily|majority|more|heavier|heavy on|lean(?:ing)?|bigger preference|prefer|preference|favorite|love|big on)\b/) : -1;
  const rank = k => { const i = m.search(MIX_SYN[k]); return cueIdx >= 0 ? (i >= cueIdx ? i - cueIdx : 10000 + i) : i; };
  const named = cats.filter(k => !low.includes(k) && MIX_SYN[k].test(m)).sort((a, b) => rank(a) - rank(b));
  if (!named.length && !low.length) return null;
  if (!named.length) { const others = cats.filter(k => !low.includes(k)); low.forEach(k => { out[k] = 0.1; }); others.forEach(k => { out[k] = (1 - 0.1 * low.length) / others.length; }); return { mix: out, why: 'less ' + low.join('/') }; }
  const ranked = cue || /\b(then|followed by|than|after that|next)\b|>/.test(m);
  const W3 = { 1: [0.5], 2: ranked ? [0.5, 0.3] : [0.4, 0.4], 3: ranked ? [0.5, 0.3, 0.2] : null };
  const W2 = { 1: [0.65], 2: ranked ? [0.65, 0.35] : null };
  const w = (cats.length >= 3 ? W3 : W2)[Math.min(named.length, cats.length)];
  if (!w) { cats.forEach(k => { out[k] = 1 / cats.length; }); return { mix: out, why: 'all named, no order: even' }; }
  named.forEach((k, i) => { out[k] = w[i]; });
  const restK = cats.filter(k => !named.includes(k)); const left = 1 - w.reduce((x, y) => x + y, 0);
  restK.forEach(k => { out[k] = low.includes(k) ? Math.min(0.1, left) : left / restK.length; });
  const tot = Object.values(out).reduce((x, y) => x + y, 0) || 1; cats.forEach(k => { out[k] = out[k] / tot; });
  return { mix: out, why: 'most: ' + named.join(' > ') };
}
const mixText = mx => Object.entries(mx).map(([k, v]) => (k === 'spirits' ? 'liquor/cocktails' : k) + ' ' + Math.round(v * 100) + '%').join(' / ');

module.exports = { MIX_SYN, eventDrinkCats, parseServingMix, mixText };
