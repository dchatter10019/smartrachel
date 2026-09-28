// Multi-pick resolution: turn Rachel's last option list + the customer's selection message
// ("Sauvignon Blanc 1, Pinot Noir 1, rosé 1") into concrete picks, and choose which basket
// line each pick replaces. Pure functions (no server state) so they are unit-tested against
// real replies: qa/unit/multipick.test.js, run by precheck.sh on every lint/deploy.
//
// Real bug (reprice-multipick, intermittent): the option list's group headings carried a
// price ("*Sauvignon Blanc alternatives (white wine ~$20):*"), the old parser rejected any
// heading containing "$", so three groups read as one flat list — "Sauvignon Blanc 1" and
// "Pinot Noir 1" both took global option #1 (a Chardonnay, added as a NEW line instead of
// replacing the 5x Sauvignon Blanc) and "rosé 1" grabbed it again.

const normP = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const wordsOf = x => normP(x).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
const VAR = ['sauvignon', 'blanc', 'pinot', 'noir', 'grigio', 'gris', 'chardonnay', 'cabernet', 'merlot', 'rose', 'riesling', 'malbec', 'syrah', 'shiraz', 'zinfandel', 'champagne', 'prosecco', 'cava', 'tequila', 'vodka', 'gin', 'rum', 'bourbon', 'whiskey', 'whisky', 'scotch', 'mezcal', 'beer', 'ipa', 'lager', 'cider', 'sparkling', 'red', 'white'];
const varOf = x => new Set(wordsOf(x).filter(w => VAR.includes(w)));
// An option line: "1. Name — 750 mL — $17.59" (number optional for bullets; text may follow the price).
// The name has no "$": real bug (reprice-multipick, Sep 27 nightly) — "No rosé found in the
// $15–$25 range" split on the en dash of the price range and became rosé option "No rosé found
// in the $15" at $25, so "rosé 1" added nothing and replied "could not resolve".
const OPTION_RE = /^\s*(?:[-•*]\s*|(\d{1,2})[.)]\s*)?([^$\n]+?)\s*(?:—|–|-)\s*(?:(\d+(?:\.\d+)?\s*(?:ml|l|oz)\b[^$\n]*?)\s*(?:—|–|-)\s*)?\$\s*([\d.,]+)(?:\s.*)?$/i;

// Group headings + their options, in order. A heading is a short line that isn't an option,
// a question or a bullet; a price inside parentheses ("(~$20)") no longer disqualifies it.
function parseOptionGroups(text) {
  const groups = []; let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\*/g, '').trim(); if (!line) continue;
    // Basket line ("5x Name — $x ea = $y"), not an option. A NUMBERED line is always an option,
    // even with a line total ("1. Justin Sauvignon Blanc — $18.69 ea = $93.45") — real bug: those
    // were skipped as basket lines and the customer was told no alternatives were listed.
    if (/^\s*\d{1,3}x\s/i.test(line) || (/\bea\s*=\s*\$/.test(line) && !/^\s*\d{1,2}[.)]\s/.test(line))) continue;
    const lm = line.match(OPTION_RE);
    if (lm) {
      if (!cur) { cur = { heading: '', options: [] }; groups.push(cur); }
      cur.options.push({ n: lm[1] ? parseInt(lm[1]) : cur.options.length + 1, name: lm[2].trim(), size: (lm[3] || '').trim(), price: parseFloat(lm[4].replace(/,/g, '')) });
      continue;
    }
    // Heading = the NAME PART (before " — " or ":") of a short non-option line, with no price
    // in it. Prices elsewhere in the line are fine: "Sauvignon Blanc alternatives (~$20):",
    // "PINOT NOIR — ~$20", "ROSÉ — none found in $15–25 range". A sentence like "Here's what
    // IS available around $20:" is not a heading (the price is in its name part).
    const namePart = line.split(/\s+(?:—|–)\s+|:/)[0].replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (namePart && !/\$/.test(namePart) && namePart.split(' ').length <= 8 && !/^\d{1,2}[.)]/.test(line) && !/^[-•]/.test(line) && !/\?$/.test(line) && line.length <= 160 && /^[A-Za-zÀ-ÿ]/.test(line)) {
      cur = { heading: namePart, options: [] }; groups.push(cur);
    }
  }
  return groups;
}

// The customer's selection split into parts ("give me decoy, louis jadot and wolffer").
function splitSelection(message) {
  return String(message || '').replace(/^\s*(ok(ay)?[,.!\s]*)?(please\s+)?(give me|i'?ll (take|have|go with)|let'?s (go with|do)|go with|add|i want|i'd like|the)\s+/i, '')
    .split(/\s*(?:,|;|\n|\band\b|\bplus\b|&)\s*/i).map(x => x.trim()).filter(Boolean);
}

// Resolve each part to an option. "<category> <n>" is looked up in the group whose heading
// names that category: first by the number shown, then by position within the group (lists
// numbered continuously across groups: "Pinot Noir 1" = the first Pinot option, shown as 2).
// A category with no group of its own is reported, never mapped to a global number, unless
// the list has no headings at all.
function resolvePicks(message, groups) {
  const realGroups = groups.filter(g => g.options.length);
  const allOpts = realGroups.flatMap(g => g.options.map(o => Object.assign({ heading: g.heading }, o)));
  const headed = groups.some(g => g.heading);
  const partsRaw = splitSelection(message);
  const picks = [], bareNums = [], notes = [], resolved = new Set();
  const headingFor = cat => {
    const cw = wordsOf(cat);
    const hits = groups.filter(g => { const hw = wordsOf(g.heading); return cw.length && cw.every(c => hw.some(h => h.startsWith(c) || c.startsWith(h))); });
    return hits.sort((a, b) => (b.options.length > 0) - (a.options.length > 0) || a.heading.length - b.heading.length)[0];   // one with options, else the shortest
  };
  for (const part of partsRaw) {
    const cm = part.match(/^(.*?[a-z].*?)\s*#?\s*(\d{1,2})\s*$/i);
    if (cm) {
      const n = parseInt(cm[2]);
      const g = headingFor(cm[1]);
      if (g && g.options.length) {
        const o = g.options.find(x => x.n === n) || g.options[n - 1];
        if (o) { picks.push(Object.assign({ heading: g.heading }, o)); resolved.add(part); continue; }
        notes.push(g.heading + ' has no option ' + n + ' — nothing changed there'); resolved.add(part); continue;
      }
      if (g || (headed && varOf(cm[1]).size)) {   // named category, but nothing offered for it
        notes.push('no alternatives were listed for ' + (g ? g.heading : cm[1].trim()) + ' — nothing changed there'); resolved.add(part); continue;
      }
      const glob = allOpts.find(x => x.n === n);   // no headings: continuous numbering
      if (glob) { picks.push(glob); resolved.add(part); continue; }
    }
    if (/^\d{1,2}$/.test(part)) { bareNums.push(parseInt(part)); resolved.add(part); continue; }
    const pw = wordsOf(part.replace(/^the\s+/i, '')); if (!pw.length) continue;
    let best = null, bestScore = 0;
    for (const o of allOpts) { const ow = wordsOf(o.name + ' ' + o.heading); const hit = pw.filter(w => ow.some(x => x === w || (w.length >= 4 && x.startsWith(w)) || (x.length >= 4 && w.startsWith(x)))).length; const sc = hit / pw.length; if (sc > bestScore) { bestScore = sc; best = o; } }
    if (best && bestScore >= 0.5) { picks.push(best); resolved.add(part); }
  }
  if (bareNums.length) {
    if (realGroups.length === 1) bareNums.forEach(n => { const o = realGroups[0].options.find(x => x.n === n) || realGroups[0].options[n - 1]; if (o) picks.push(Object.assign({ heading: realGroups[0].heading }, o)); });
    else if (bareNums.length === realGroups.length) bareNums.forEach((n, i) => { const g = realGroups[i]; const o = g.options.find(x => x.n === n) || g.options[n - 1]; if (o) picks.push(Object.assign({ heading: g.heading }, o)); });
  }
  const seen = new Set();
  const uniq = picks.filter(pk => { const k = normP(pk.name); if (seen.has(k)) return false; seen.add(k); return true; });
  return { partsRaw, picks: uniq, notes, unmatched: partsRaw.filter(p => !resolved.has(p)), grouped: realGroups.length >= 2, allOpts };
}

// Which basket line a pick replaces. The GROUP HEADING names what is being replaced
// ("Sauvignon Blanc alternatives" -> the Sauvignon Blanc line), even when the pick itself is
// another varietal (a Chardonnay offered as the alternative). Without a heading, the pick's
// own varietal decides. null = the pick is added as a new line.
function replacementTarget(pick, items) {
  const others = items.filter(it => normP(it.name) !== normP(pick.name));
  const hv = varOf(pick.heading || '');
  if (hv.size) { const t = others.find(it => { const iv = varOf(it.name); return [...hv].some(v => iv.has(v)); }); if (t) return t; }
  const pv = varOf(pick.name);
  return pv.size ? (others.find(it => { const iv = varOf(it.name); return [...pv].some(v => iv.has(v)); }) || null) : null;
}

// A product named by a few of its words ("Kendall Pinot") from the option list Rachel sent in
// one of her last few replies. Real bug (Sep 28, WhatsApp): Rachel listed 8 reds, then asked
// "Which one would you like to add?" (no list in THAT reply); the customer said "Kendall Pinot"
// — only #4 fits — but add_item searched the catalog and asked again with two other Pinots.
// Every word of the ref must match a word of the option (exact, or a prefix of 3+ letters:
// "cab" -> "cabernet"). Only the NEWEST list counts (older lists are stale). Returns null if no
// recent reply has a list; else { matches } — one = that product, several = ask among them,
// none = the customer named something not listed.
const REF_FILLER = new Set(['the', 'please', 'bottle', 'bottles', 'wine', 'one', 'add', 'cart', 'that', 'this', 'with', 'and']);
function matchListedByName(ref, replies) {
  const rw = wordsOf(ref).filter(w => !REF_FILLER.has(w) && !/^\d+$/.test(w));
  if (!rw.length) return null;
  for (const text of (replies || []).slice().reverse()) {
    const opts = parseOptionGroups(text).flatMap(g => g.options.map(o => Object.assign({ heading: g.heading }, o)));
    if (opts.length < 2) continue;
    const matches = opts.filter(o => { const ow = wordsOf(o.name); return rw.every(w => ow.some(x => x === w || (w.length >= 3 && x.startsWith(w)))); });
    return { matches, listSize: opts.length };
  }
  return null;
}

module.exports = { parseOptionGroups, splitSelection, resolvePicks, replacementTarget, matchListedByName, normP, wordsOf };
