// Search-text normalization before every product search (DC, Nov 20). Deterministic, no LLM. Three layers, in order:
//   1. abbreviations (rachel/data/search-abbreviations.json): whole words only, longest first ("chard" -> "chardonnay")
//   2. aliases (rachel/data/search-aliases.json): the WHOLE customer message, normalized, equals a key ("vueve" -> "Veuve
//      Clicquot"); never inside a longer message
//   3. zero-result spell check: ONLY after a search found nothing, each typed word is compared to the fixed CATEGORY words
//      (rachel/data/search-category-words.json) and the search retried ONCE with the closest one ("proseco" -> "prosecco")
// An expanded abbreviation that finds nothing is retried with the text as typed first (expansionMissed; "Chard Farm").
// Each layer can be turned off in rachel/data/search-normalize-config.json (read at service start).
// Every rewrite is logged: [search-normalize] "<before>" -> "<after>" (<layer>). Only search text changes — never the
// customer's text shown in replies. The alias / abbreviation files are generated from the Voiceflow export (rachel/data/README.md).
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
function load(name, key) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'))[key]; }
  catch (e) { console.log('[search-normalize] ' + name + ' not loaded: ' + e.message + ' — that layer is off'); return null; }
}
// Off switch (DC, Nov 20): rachel/data/search-normalize-config.json, one flag per layer, read once at service start.
// A missing file / flag = on. Turn a layer off: set it false and restart (precheck.sh --deploy) — no code change.
const ON = (() => {
  let c = {}; try { c = JSON.parse(fs.readFileSync(path.join(DATA, 'search-normalize-config.json'), 'utf8')); }
  catch (e) { console.log('[search-normalize] search-normalize-config.json not read (' + e.message + ') — every layer on'); }
  const on = { abbreviations: c.abbreviations !== false, aliases: c.aliases !== false, spellcheck: c.spellcheck !== false };
  console.log('[search-normalize] layers: abbreviations ' + (on.abbreviations ? 'on' : 'OFF') + ', aliases ' + (on.aliases ? 'on' : 'OFF') + ', spellcheck ' + (on.spellcheck ? 'on' : 'OFF'));
  return on;
})();
const ALIASES = load('search-aliases.json', 'aliases') || {};
const ABBR = (load('search-abbreviations.json', 'abbreviations') || [])
  .slice().sort((a, b) => b.typed.split(' ').length - a.typed.split(' ').length || b.typed.length - a.typed.length);

// The README's rule (same as data/voiceflow-export-tools/alias_candidates.py norm).
function norm(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’'`]/g, '').replace(/[^\w\s]|_/g, ' ').replace(/\s+/g, ' ').trim();
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const log = (from, to, layer) => console.log('[search-normalize] ' + JSON.stringify(from) + ' -> ' + JSON.stringify(to) + ' (' + layer + ')');

// ── Layer 1: abbreviations ────────────────────────────────────────────────────────────────────────────────────────────
// Code-level guards the generated file can't express (each is a real ambiguity, not a preference):
//  - "cab franc" is Cabernet Franc: "cab" before "franc" is never expanded
//  - "cab sav" / "cab sauv" / "cabernet sav(v)" is Cabernet Sauvignon: never "cabernet sauvignon blanc"
//  - an expansion whose tail the customer already typed ("sav blanc" -> "sauvignon blanc") takes that tail, never doubles it
const COMPOUND = [[/(?<![\w'])(?:cab|cabernet)\s+(?:sav|sauv|savvy)(?![\w'])/gi, 'cabernet sauvignon']];
const UNLESS_NEXT = { cab: /^\s+franc\b/i };
function expandAbbreviations(term) {
  const before = String(term || '');
  if (!ON.abbreviations) return before;
  let out = before;
  for (const [rx, to] of COMPOUND) out = out.replace(rx, to);
  for (const a of ABBR) {
    const tail = a.expands_to.split(' ').slice(1).join('\\s+');   // "sauvignon blanc" -> optional "\s+blanc" after "sav"
    const rx = new RegExp('(?<![\\w\'])' + a.typed.split(' ').map(esc).join('\\s+') + (tail ? '(?:\\s+' + tail + ')?' : '') + '(?![\\w\'])', 'gi');
    out = out.replace(rx, (m, off, s) => {
      const guard = UNLESS_NEXT[a.typed];
      if (guard && guard.test(s.slice(off + m.length))) return m;
      if (norm(m) === norm(a.expands_to)) return m;   // already the full word(s)
      return a.expands_to;
    });
  }
  if (out !== before) log(before, out, 'abbreviation');
  return out;
}

// ── Layer 2: aliases (whole message only) ─────────────────────────────────────────────────────────────────────────────
// -> { key, to } when the whole customer message, normalized, is an alias key; else null.
function aliasFor(message) {
  if (!ON.aliases) return null;
  const k = norm(message);
  return k && Object.prototype.hasOwnProperty.call(ALIASES, k) ? { key: k, to: ALIASES[k] } : null;
}
// A search text the model / the add-item route built from that same message: rewritten only when the customer's whole
// message is the alias AND the search text is that same message (never a part of a longer request).
function aliasTerm(term, customerMessage) {
  const al = aliasFor(customerMessage);
  if (!al || norm(term) !== al.key) return term;
  log(term, al.to, 'alias');
  return al.to;
}

// ── Layer 3: zero-result spell check, CATEGORY WORDS ONLY ─────────────────────────────────────────────────────────────
// The only correction targets are the fixed words in rachel/data/search-category-words.json (prosecco, chardonnay,
// tequila...). No store vocabulary, nothing learned from searches (DC, Nov 20: brand spell check is a later item).
const CATEGORY = new Set(((load('search-category-words.json', 'words')) || []).map(norm).filter(w => /^[a-z]{5,}$/.test(w)));
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(Array(b.length).fill(0)));
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
// -> the term with each unknown word (4+ letters) replaced by its ONE closest category word (same first letter; distance 1
// up to 6 letters, 2 from 7), or null when nothing changed. A tie (two words equally close) is left alone and logged.
// words = a test-only target list (default: the category file).
function spellFix(term, words) {
  if (!ON.spellcheck) return null;
  const vocab = words ? new Set(words) : CATEGORY;
  const changes = [];
  const out = String(term || '').replace(/[A-Za-zÀ-ÿ']+/g, w => {
    const n = norm(w);
    if (n.length < 4 || vocab.has(n)) return w;
    const lim = n.length >= 7 ? 2 : 1;
    let best = null, bestD = 99, tie = false;
    for (const v of vocab) {
      if (v[0] !== n[0] || Math.abs(v.length - n.length) > lim) continue;
      const d = osa(n, v);
      if (d < bestD) { best = v; bestD = d; tie = false; } else if (d === bestD) tie = true;
    }
    if (!best || bestD > lim) return w;
    if (tie) { console.log('[search-normalize] spell check skipped ' + JSON.stringify(w) + ' — two category words equally close'); return w; }
    changes.push([w, best]); return best;
  });
  if (!changes.length) return null;
  return { from: String(term || ''), term: out, changes };   // logged by acceptFix once the retry is KEPT
}

// The retry's rows count only when one of them names every word of the corrected search (the fixed word and the rest):
// "domaine bouquet malbec" returning some other "Bouquet" bottle is not the customer's wine. -> the rows kept ([] = rejected)
function acceptFix(fx, rows) {
  const need = norm(fx && fx.term).split(' ').filter(w => w.length >= 3 && /^[a-z]+$/.test(w));
  const ok = (rows || []).filter(r => { const n = ' ' + norm(r && r.name) + ' '; return need.every(w => n.indexOf(' ' + w + ' ') >= 0 || n.indexOf(' ' + w) >= 0); });
  if (ok.length) log(fx.from, fx.term, 'spell check, zero results');
  else console.log('[search-normalize] spell-check retry NOT used for ' + JSON.stringify(fx.from) + ' — ' + ((rows || []).length ? 'no result names ' + JSON.stringify(fx.term) + ' (' + rows.length + ' other row(s))' : 'it found nothing either') + '; the search text stays as typed');
  return ok;
}

// Abbreviation safety (DC, Nov 20): a search whose expanded text found nothing is retried ONCE with the text as typed, before
// any other fallback — a real name can hold an abbreviation ("Chard Farm" is a winery). -> true when that retry should run.
function expansionMissed(typed, expanded, rowsFound) {
  if (rowsFound || String(typed) === String(expanded)) return false;
  console.log('[search-normalize] expansion found nothing - retried original: ' + JSON.stringify(expanded) + ' -> ' + JSON.stringify(typed));
  return true;
}

// The text the relevance filter should judge rows by: what was actually searched when a layer changed it, else null
// (= judge by what was typed). shopping-agent searchWithFallbacks -> rows.searchedAs -> product_query rankByMatch.
function searchedText(typed, searchedAs) {
  return searchedAs && norm(searchedAs) !== norm(typed) ? String(searchedAs) : null;
}

module.exports = { norm, searchedText, acceptFix, expandAbbreviations, expansionMissed, aliasFor, aliasTerm, spellFix, osa, enabled: () => Object.assign({}, ON), CATEGORY };
