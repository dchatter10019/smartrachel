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

function splitInstructions(message) {
  const lines = String(message || '').split(/\n+/).map(l => l.replace(/^\s*(?:[-•*·–]|\d+[.)])\s*/, '').replace(/\*/g, '').trim()).filter(l => l.length >= 4);
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

module.exports = { splitInstructions, unaddressed, keywords, applyCountInstructions };
