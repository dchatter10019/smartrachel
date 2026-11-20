// Does an add-item ("add X", "let's go with X for vodka") REPLACE a basket line, or go in as a new line? (DC, Nov 20)
// Replace ONLY when all three hold:
//   a. the message has a switch phrase ("go with", "instead", "switch to", "swap", "replace", "change to", "make it the")
//      and no add word ("add", "also", "too", "as well", "plus", "another") — an add word always means a new line;
//   b. the type comes from the PRODUCT's own name + category, never from the customer's words;
//   c. exactly one basket line has that type (two or more: Rachel asks which one).
// Before all three: a line the message NAMES to take out is replaced even with an add word (not in the basket: a new line,
// and Rachel says she didn't find it). "Add = new line" applies only when the line would have to be inferred by type.
// Real cases: Nov 17 (DC, Slack, Gen2Fund) "can you add Oyster Bay Sauvignon Blanc" replaced 2x Josh Cellars Sauvignon Blanc
// with an Oyster Bay Rosé ("sauvignon blanc" was read from the message); Nov 20 staging "add Casamigos Blanco Tequila 750ml"
// replaced the 4x Patrón. Before: server.js add-item "replace-in-varietal" (Sep 24) + applyBasketSubstitute's
// "only other line of its spirit type" (Sep 29) — the add-item route now adds with opts.add, so only this module decides.

const ADD_RE = /\b(add|adding|also|too|as\s+well|plus|another)\b/i;
const SWITCH_RE = /\b(go(?:ing)?\s+with|instead|switch(?:\s+(?:it|that|this))?\s+to|swap(?:ping)?|replac(?:e|ing)|change(?:\s+(?:it|that|this))?\s+to|make\s+it\s+the)\b/i;

// A basket line the message NAMES as the one to take out ("instead of the Grey Goose", "in place of the Patron", "replace the
// Josh", "swap out the Bacardi", "swap the Bacardi for ..."): replaced even when the message also says "add" (DC, Nov 20).
// "switch to X" / "swap in X" name the new product, not a line. The text after the cue stops at punctuation or with / for / to / and.
const NAMED_RE = /\b(?:instead\s+of|in\s+place\s+of|rather\s+than|replace|swap(?:\s+out)?|switch\s+out)\s+(?!(?:to|in|it|that|this|them|one)\b)([^.,;!?\n]+)/gi;
const PRONOUN = /^(?:it|that|this|them|those|these|one|ones)$/;
function namedLine(message, items, basketLineFor) {
  for (const m of String(message || '').matchAll(NAMED_RE)) {
    const seg = m[1].split(/\s+(?:with|for|to|and|by)\s+/i)[0].replace(/^(?:the|my|our|those|these|that|this)\s+/i, '').trim();
    const words = seg.split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length || PRONOUN.test(words[0].toLowerCase())) continue;
    for (let n = words.length; n >= 1; n--) {   // the longest start of the text that names a basket line ("the Bacardi I'd like ..." -> "Bacardi")
      const i = basketLineFor(items || [], words.slice(0, n).join(' '));
      if (i >= 0) return { line: items[i], named: words.slice(0, n).join(' ') };
    }
    return { line: null, named: words.slice(0, 4).join(' ') };
  }
  return null;
}

// Type keys. Two-word grapes are one type (Sauvignon Blanc is not Chenin Blanc; Pinot Noir is not Pinot Grigio).
const TYPES = [
  ['sauvignon blanc', /\bsauvignon\s+blanc\b/], ['cabernet sauvignon', /\bcabernet(?!\s+franc)\b/], ['cabernet franc', /\bcabernet\s+franc\b/],
  ['pinot noir', /\bpinot\s+noir\b/], ['pinot grigio', /\bpinot\s+gri(?:gio|s)\b/], ['chenin blanc', /\bchenin\s+blanc\b/],
  ['chardonnay', /\bchardonnay\b/], ['merlot', /\bmerlot\b/], ['rose', /\brose\b/], ['riesling', /\briesling\b/], ['malbec', /\bmalbec\b/],
  ['syrah', /\b(?:syrah|shiraz)\b/], ['zinfandel', /\bzinfandel\b/], ['champagne', /\bchampagne\b/], ['prosecco', /\bprosecco\b/],
  ['cava', /\bcava\b/], ['tequila', /\btequila\b/], ['mezcal', /\bmezcal\b/], ['vodka', /\bvodka\b/], ['gin', /\bgin\b/], ['rum', /\brum\b/],
  ['bourbon', /\bbourbon\b/], ['whiskey', /\bwhiske?y\b/], ['scotch', /\bscotch\b/], ['liqueur', /\bliqueur\b/],
];

const nrm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '');

// The product's (or a basket line's) types, from its own name + category + subcategory only.
function typesOf(row) {
  const txt = nrm([row && (row.name || row.label), row && row.category, row && (row.subCategory || row.subcategory)].filter(Boolean).join(' '));
  return TYPES.filter(([, re]) => re.test(txt)).map(([k]) => k);
}

// What the MESSAGE decides, before any product is known (an add-item request that showed an options list stores this for the
// pick that follows: state.pendingAddIntent). -> { kind: 'new_line' | 'replace_named' | 'replace_by_type', line?, phrase?, notFound?, reason }
function intentFor(message, items, basketLineFor) {
  const msg = String(message || '');
  const nl = basketLineFor ? namedLine(msg, items, basketLineFor) : null;
  if (nl && nl.line) return { kind: 'replace_named', line: nl.line.name || nl.line.label, reason: 'named line' };
  if (nl && !nl.line) return { kind: 'new_line', notFound: nl.named, reason: 'named line "' + nl.named + '" is not in the basket' };
  const addW = msg.match(ADD_RE);
  if (addW) return { kind: 'new_line', reason: 'the message says "' + addW[0].toLowerCase() + '"' };
  const sw = msg.match(SWITCH_RE);
  if (!sw) return { kind: 'new_line', reason: 'no switch phrase in the message' };
  return { kind: 'replace_by_type', phrase: sw[0].toLowerCase().replace(/\s+/g, ' '), reason: 'switch phrase' };
}

// A stored intent applied to the product (picked now) and the basket (as it is now).
// -> { action: 'replace', line, type?, reason } | { action: 'ask', lines, type, reason } | { action: 'add', notFound?, reason }
function applyIntent(intent, product, items) {
  const nk = s => nrm(s).replace(/[^a-z0-9]/g, '');
  const it = intent || { kind: 'new_line', reason: 'no decision' };
  if (it.kind === 'new_line') return Object.assign({ action: 'add', reason: it.reason }, it.notFound ? { notFound: it.notFound } : {});
  if (it.kind === 'replace_named') {
    const line = (items || []).find(x => nk(x.name || x.label) === nk(it.line));
    if (!line) return { action: 'add', reason: 'the named line "' + it.line + '" is no longer in the basket' };
    if (nk(line.name || line.label) === nk(product && product.name)) return { action: 'add', reason: 'the named line is the product itself' };
    return { action: 'replace', line, reason: 'named line' };
  }
  const phrase = it.phrase || 'switch phrase';
  const pt = typesOf(product);
  if (!pt.length) return { action: 'add', reason: '"' + phrase + '" but ' + (product && product.name) + ' has no type in its name or category' };
  const lines = (items || []).filter(x => nk(x.name || x.label) !== nk(product.name) && typesOf(x).some(t => pt.includes(t)));
  const type = pt.join('/');
  if (!lines.length) return { action: 'add', reason: '"' + phrase + '" but no ' + type + ' line in the basket' };
  if (lines.length > 1) return { action: 'ask', lines, type, reason: '"' + phrase + '" and ' + lines.length + ' ' + type + ' lines' };
  return { action: 'replace', line: lines[0], type, reason: phrase };
}

// The add-item route, one product found: the message's intent applied to it at once.
function decide(message, product, items, basketLineFor) {
  return applyIntent(intentFor(message, items, basketLineFor), product, items);
}

// The product to SEARCH for, when the add-item text also says which line to take out (Nov 20 staging: the add rule's ref
// "Tito's 750ml instead of the Grey Goose" searched the catalog whole -> "I couldn't find Tito's 750ml instead of the Grey Goose").
// The full message still goes to the replace rules. -> { ref, cut, form }
function searchRef(ref) {
  const r = String(ref || '').trim();
  const out = (x, form) => ({ ref: x.replace(/^(?:the|a|an|some)\s+/i, '').replace(/[\s.,;:!?]+$/, '').trim(), cut: true, form });
  let m = r.match(/^(?:replace|swap(?:\s+out)?|switch(?:\s+out)?)\s+.+?\s+(?:with|for)\s+(.+)$/i);
  if (m) return out(m[1], 'replace/swap Y with/for X');
  m = r.match(/^(?:instead\s+of|in\s+place\s+of|rather\s+than)\s+[^,]+,\s*(.+)$/i);
  if (m) return out(m[1], 'instead of Y, X');
  m = r.match(/^(.+?)\s+(?:instead\s+of|in\s+place\s+of|rather\s+than)\s+.+$/i);
  if (m) return out(m[1], 'X instead of / in place of / rather than Y');
  m = r.match(/^(.+?)\s+instead[\s.!]*$/i);
  if (m) return out(m[1], 'X instead');
  return { ref: r, cut: false };
}

// The stored intent as a label for the logs: "new_line" / "replace_named:<line>" / "replace_by_type".
function intentLabel(it) { return !it ? 'none' : it.kind === 'replace_named' ? 'replace_named:' + it.line : it.kind; }

// Rachel's question when 2+ lines fit. Bullets, never "1." (the numbered-pick resolvers would read the answer as a pick).
function askText(productName, lines, type) {
  return 'You have ' + lines.length + ' ' + type + ' lines in your basket:\n' + lines.map(l => '• ' + (l.qty || l.quantity || 1) + 'x ' + (l.name || l.label)).join('\n')
    + '\n\nShould ' + productName + ' replace one of them (which one?), or go in as a new line?';
}

// The answer to that question (the next message only). -> { action: 'replace', line } | { action: 'add' } | null (not an answer)
function answer(message, pending, items, basketLineFor) {
  if (!pending) return null;
  const msg = String(message || '');
  const live = (pending.lines || []).map(n => (items || []).find(it => nrm(it.name || it.label) === nrm(n))).filter(Boolean);
  if (live.length) {
    const i = basketLineFor(live, msg);
    if (i >= 0) return { action: 'replace', line: live[i] };
  }
  if (/\b(new\s+line|separate|both|keep\s+(?:them|both|all|it)|add\s+it|as\s+well|in\s+addition|neither|none|don'?t\s+replace)\b/i.test(msg)) return { action: 'add' };
  return null;
}

module.exports = { decide, searchRef, intentFor, applyIntent, intentLabel, answer, askText, typesOf, namedLine, ADD_RE, SWITCH_RE };
