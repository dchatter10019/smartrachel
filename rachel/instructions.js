// A message that carries several instructions (bullets / lines) must have EVERY one handled.
// Real bug (Sep 29, Slack): "• Instead of Bacardi … higher end whiskey • Change the Rum count to 5
// • For tequila … Don Julio and Casa Migos" — the LLM did the swaps and silently dropped the rum
// count; DC had to say "missed the 5 bottles of rum change". The LLM is told the checklist, and code
// checks the reply: anything not handled is asked about, never dropped (rule 7).
const { spiritType } = require('./spirit-type.js');

const STOP = new Set(('the a an of for to and or with in on at it its is be as by me my our your their they them this that these those ' +
  'please pls instead replace replacing change changed count quantity qty make would like want need also then just can could should ' +
  'two three four five options option one both each all some more less number higher high end top shelf premium better nice good ' +
  'bottle bottles case cases pack packs ml oz liter litre have has get add remove swap keep use go do into from out up').split(' '));

// A sign-off or pleasantry is not an instruction. Real bug (Oct 1, Sean): the reply ended "I haven't done this one
// yet: • Thanks! Want me to go ahead?".
const PLEASANTRY = /^(?:(?:ok(?:ay)?|great|perfect|awesome|sounds good|thanks?(?:\s+(?:you|so much|again|a lot))?|thx|ty|cheers|best(?:\s+regards)?|regards|much appreciated|appreciate it|hi|hello|hey|rachel|rache)[\s,.!-]*)+(?:[a-z]+)?[\s.!]*$/i;
function splitInstructions(message) {
  // An email hard wrap ("send back and\nupdated PDF?") joins back into one line: no sentence end, next line lower-case.
  // Only a long line (>= 60 chars; Gmail wraps near 76) — short list lines ("remove the modelo") stay separate.
  const text = String(message || '').replace(/^([^\n]{59,}[a-z,])[ \t]*\r?\n(?=[ \t]*[a-z])/gm, '$1 ');
  const lines = text.split(/\n+/).map(l => l.replace(/^\s*(?:[-•*·–]|\d+[.)])\s*/, '').replace(/\*/g, '').trim()).filter(l => l.length >= 4 && !PLEASANTRY.test(l));
  return lines.length >= 2 && lines.length <= 12 ? lines : [];
}

const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function keywords(instr) { return [...new Set(norm(instr).split(/[^a-z0-9']+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))]; }
const has = (text, w) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\']/g, '.?') + '\\b').test(text);

// before/after: basket line arrays. A quantity instruction ("… count to 5") counts as handled only if
// a matching line now has that quantity, or the reply names the item/type AND the number; any other
// instruction is handled when the reply or a changed line mentions one of its keywords.
function unaddressed(instrs, reply, before, after) {
  const r = norm(reply);
  const key = it => norm(it.name || it.label);
  const q = it => Number(it.qty || it.quantity || 1);
  const b = new Map((before || []).map(it => [key(it), q(it)]));
  const changed = (after || []).filter(it => b.get(key(it)) !== q(it));
  // An approval of a line is not a request to do something: "12x Fort Point KSA Kolsch -> good" (Sep 30, DC) got
  // "I haven't done this one yet ... Want me to go ahead?".
  const APPROVAL = /(?:->|→|:|=|-|—|\bis\b|\bare\b)\s*(?:good|ok(?:ay)?|fine|great|perfect|keep(?: it)?|approved|looks good|that'?s (?:good|fine)|yes|👍)\s*[.!]*\s*$/i;
  return instrs.filter(instr => {
    if (APPROVAL.test(String(instr))) return false;
    const kw = keywords(instr);
    if (!kw.length) return false;
    const num = (norm(instr).match(/\bto\s+(\d{1,3})\b|\b(\d{1,3})\s*(?:bottles?|x\b)/) || []).slice(1).find(Boolean);
    const matches = it => kw.some(w => has(key(it), w) || spiritType(it.name || it.label) === w || (w === 'whisky' && spiritType(it.name) === 'whiskey'));
    if (num) {
      if ((after || []).some(it => matches(it) && q(it) === Number(num) && b.get(key(it)) !== q(it))) return false;
      return !(kw.some(w => has(r, w)) && has(r, num));
    }
    // A swap ("X -> Y") is done when the basket changed, or asked about — a reply that only SAYS "replacing X"
    // is not done. Real bug (Oct 1, DC): "✅ Cointreau — replacing the Remy Martin 1738" with the basket untouched;
    // the mention of "cointreau" counted as handled and the proposal went out with the Remy Martin.
    if (ARROW.test(String(instr)) && !APPROVAL_TO.test((String(instr).match(ARROW) || [])[2] || '')) {
      if (changed.some(matches)) return false;
      // Sentence by sentence: "Cointreau is swapped in. Just let me know which Whispering Angel size …!" claims the one
      // and asks about the other (a QA reply, Oct 1).
      const sents = String(reply || '').split(/\n+|(?<=[.!?])\s+/).filter(l => kw.some(w => has(norm(l), w)));
      const claimed = sents.some(l => /\b(replac\w*|swapp?\w*|switched|updated|added|in your (?:order|basket))\b|✅|:white_check_mark:/i.test(l));
      const asks = sents.some(l => /\?|\b(which|let me know|would you like|do you want|prefer)\b/i.test(l));
      if (claimed && !asks) return true;   // said it was done, basket untouched: not done
    }
    if (kw.some(w => has(r, w))) return false;
    return !changed.some(matches);
  });
}

// "Change the Rum count to 5": set in code when exactly one basket line fits. The type/brand words pick
// the lines (spirit-type.js); a line that another instruction in the same message replaces ("Instead of
// Bacardi …") is not a target. Real bug (Sep 29): the LLM read "Rum" as the Bacardi being swapped out
// ("stays at 5x, no change needed") while Mount Gay Black Barrel stayed at 4.
// Returns [{ instr, name, from, to }] and mutates items; several fits -> left to the LLM (logged).
function applyCountInstructions(instrs, items, log = console.log) {
  const out = [];
  const replacedWords = instrs.filter(x => /\b(instead of|replace|swap)\b/i.test(x))
    .map(x => (norm(x).match(/\b(?:instead of|replace|swap)\s+(?:the\s+)?([a-z0-9' ]+?)(?:\s+(?:with|for|to|by)\b|[,.–-]|$)/) || [])[1]).filter(Boolean)
    .flatMap(p => keywords(p));
  for (const instr of instrs) {
    const m = norm(instr).match(/\b(?:count|quantity|qty|amount|number|bottles?)?\s*(?:to|=)\s*(\d{1,3})\s*(?:bottles?)?\s*\.?$/);
    if (!m || !/\b(change|make|set|update|increase|decrease|bump|reduce)\b|\bcount\b|\bquantity\b/i.test(instr)) continue;
    const to = Number(m[1]);
    const kw = keywords(instr);
    if (!kw.length || !(to > 0)) continue;
    const fits = items.filter(it => {
      const n = norm(it.name || it.label);
      if (replacedWords.some(w => has(n, w))) return false;
      return kw.some(w => has(n, w) || spiritType(it.name || it.label) === w);
    });
    if (fits.length !== 1) { log('[instructions] count instruction ' + JSON.stringify(instr) + ' fits ' + fits.length + ' basket lines ' + JSON.stringify(fits.map(f => f.name)) + ' — left to the LLM'); continue; }
    const it = fits[0], from = Number(it.qty || it.quantity || 1);
    it.qty = to; it.quantity = to; it.qty_confirmed = true;
    out.push({ instr, name: it.name, from, to });
    log('[instructions] APPLIED in code: ' + JSON.stringify(instr) + ' -> ' + it.name + ' ' + from + ' -> ' + to + (replacedWords.length ? ' (not ' + JSON.stringify(replacedWords) + ': replaced in the same message)' : ''));
  }
  return out;
}

// "Remy Cointreau -> Cointreau 750 ML": one line per swap, the basket item on the left, what the customer wants on
// the right. Slack sends the arrow HTML-escaped ("-&gt;"). An approval ("-> good") is not a swap. -> [{ from, to, line }]
const ARROW = /^\s*(.+?)\s*(?:->|-&gt;|→|=>|=&gt;)\s*(.+?)\s*$/;
const APPROVAL_TO = /^(?:good|ok(?:ay)?|fine|great|perfect|keep(?: it)?|approved|looks good|that'?s (?:good|fine)|yes|👍)\s*[.!]*$/i;
function arrowSwaps(message) {
  return String(message || '').split(/\n+/).map(l => l.replace(/^\s*(?:[-•*·–]|\d+[.)])\s*/, '').replace(/\*/g, '').trim())
    .map(l => { const m = l.match(ARROW); return m && !APPROVAL_TO.test(m[2]) && m[1].length >= 3 && m[2].length >= 3 ? { from: m[1], to: m[2], line: l } : null; })
    .filter(Boolean);
}
// The ONE product just shown that is what the right side names: every distinctive word of it on the product
// (product-match fit), and its size when one is stated. Several fit (sizes to choose) or none -> null: the LLM asks.
function uniqueProductFor(want, shown) {
  const PM = require('./product-match.js');
  const sz = x => { const m = String(x || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|l|oz|liter|litre)\b/); return m ? (+m[1]) + (m[2][0] === 'l' ? 'l' : m[2]) : ''; };
  const wantSize = sz(want), wantName = want.replace(/(\d+(?:\.\d+)?)\s*(ml|l|oz|liter|litre)\b/ig, ' ');
  const seen = new Set();
  const fits = (shown || []).filter(p => {
    const k = p.product_id || p.name; if (seen.has(k)) return false; seen.add(k);
    if (PM.fit(wantName, { name: p.name }).missing.length) return false;
    return !wantSize || sz(p.size || p.sizeStr || p.name) === wantSize || sz(p.name) === wantSize;
  });
  return fits.length === 1 ? fits[0] : null;
}

module.exports = { splitInstructions, unaddressed, keywords, applyCountInstructions, arrowSwaps, uniqueProductFor };
