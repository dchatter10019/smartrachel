// The basket line a pick replaces, read from Rachel's own last question (Nov 10, DC on Claude Code, Foodie For All):
//   "Which one would you like to swap in for The Prisoner?"  -> "Robert Mondavi ... this one" ADDED the Mondavi, The
//   Prisoner stayed on the proposal; "Shall I swap that in for the Bread & Butter Pinot Grigio?" -> "yes" added the KJ;
//   "Which one would you like as your second red (replacing one of the Prisoner bottles)?" -> the La Crema was added and
//   2x Prisoner kept. Every pick path (yes to an offer, numbered pick, pick by name) goes through applyBasketSubstitute,
//   which asks this when no original was given.
// -> { index, name, oneOf } or null. oneOf = "one of the X bottles": that line drops by one, the pick comes in at 1.
const basketLineFor = require('./basket-line.js');

const nz = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function swapPhrase(text) {
  const t = String(text || '').replace(/\*/g, '');
  // the question is the last sentence that asks (Rachel closes with it)
  const qs = t.split(/\n+/).filter(l => /\?/.test(l));
  const q = qs.length ? qs[qs.length - 1] : '';
  if (!q) return null;
  const pats = [
    /\b(?:replacing|in place of|instead of)\s+(one of\s+)?(?:the\s+|your\s+)?(.{3,100}?)(?:\s+bottles?)?\s*(?:\)|\?|,|$)/i,
    /\b(?:swap|switch|exchange|trade)\b.{0,80}?\b(?:in\s+)?for\s+(one of\s+)?(?:the\s+|your\s+)?(.{3,100}?)(?:\s+bottles?)?\s*(?:\)|\?|,|$)/i,
    /\breplace\s+(one of\s+)?(?:the\s+|your\s+)?(.{3,100}?)(?:\s+bottles?)?\s+(?:with|by)\b/i,
  ];
  for (const re of pats) { const m = q.match(re); if (m) return { oneOf: !!m[1], what: m[2].trim() }; }
  return null;
}

function swapTarget(lastReply, items, pickName) {
  const ph = swapPhrase(lastReply);
  if (!ph) return null;
  const idx = basketLineFor(items || [], ph.what);
  if (idx < 0) return { index: -1, name: '', what: ph.what, oneOf: ph.oneOf };
  if (pickName && nz(items[idx].name) === nz(pickName)) return null;   // the pick IS that line
  return { index: idx, name: items[idx].name || items[idx].label, what: ph.what, oneOf: ph.oneOf };
}

module.exports = { swapTarget, swapPhrase };
