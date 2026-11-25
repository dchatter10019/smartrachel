// Stock the customer says they already have is NOT ordered (DC, Oct 2). Real case (Oct 1, DC's Goody quote):
// "**Wine** we have the below inventory from last time if you can please adjust the proposal accordingly" +
// 2 La Crema / 1 Prisoner / 2 Conundrum — Rachel's reply said "existing inventory, not ordered" yet every PDF
// charged $178.45 for those 5 bottles.
//
// parseOnHand(text) -> [{ name, qty }]  the listed lines under an "we have ... (inventory / from last time / on hand)" intro
// isOnHand(productName, onHand) -> the on-hand entry it matches, or null

const INTRO = /\b(?:we|i)\s+already\s+have\b|\b(?:we|i)\s+(?:already\s+|still\s+)?have\b[^\n]{0,80}?\b(?:inventory|left\s*over|leftover|from\s+(?:last|the\s+last|our\s+last|previous)|on\s+hand|in\s+stock|already)\b|\b(?:existing|current|leftover|left-over)\s+(?:inventory|stock)\b|\bon\s+hand\b/i;
const ITEM = /^\s*(?:[-•*·]|\d+[.)])\s+(.+?)\s*$/;              // a bullet / numbered line
const HEADER = /^\s*(?:\*\*[^*]+\*\*|[A-Z][A-Za-z /&]{2,30}:)/;   // "**Mixers & N/A**", "Spirits:"

function cleanName(s) {
  return String(s || '').replace(/^\s*(\d+)\s*(?:x|×)?\s*/i, '')
    .replace(/^(?:bottles?|cans?|cases?|packs?)\s+(?:of\s+)?/i, '')
    .replace(/\b(?:bottles?|cans?)\s+(?:of\s+)?/i, '').trim();
}

function parseOnHand(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!INTRO.test(lines[i]) || ITEM.test(lines[i])) continue;
    // the intro may wrap over 2-3 lines before the list starts
    let j = i + 1;
    while (j < lines.length && !ITEM.test(lines[j]) && !HEADER.test(lines[j]) && j <= i + 4) j++;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const m = l.match(ITEM);
      if (!m) break;                                  // the list ended (next section / prose)
      const q = m[1].match(/^\s*(\d+)\b/);
      const name = cleanName(m[1]);
      if (name) out.push({ name, qty: q ? +q[1] : null });
    }
    i = j - 1;
  }
  return out;
}

const STOP = new Set(['the', 'a', 'of', 'and', 'bottle', 'bottles', 'can', 'cans', 'case', 'cases', 'pack', 'ml', 'l', 'oz', 'wine', 'white', 'red']);
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w) && !/^\d+$/.test(w));

function isOnHand(productName, onHand) {
  const pw = new Set(words(productName));
  for (const o of onHand || []) {
    const ow = words(o.name);
    if (ow.length && ow.every(w => pw.has(w))) return o;
  }
  return null;
}

// On-hand products the customer CHOSE in a later message — ordered on top of what they have. Real case (Oct 2, DC's
// Goody thread): "4x Conundrum White -> This is good" and "so 4 The Prisoner Red Blend" were dropped the next turn as
// on-hand (he had 2 Conundrum / 1 Prisoner from last time) — the PDF would have gone out with only the vodka.
// A line that names the product counts, unless it removes it or says they have it ("remove", "we have", "on hand").
// The message itself must not be an on-hand statement (parseOnHand finds nothing in it).
const NOT_A_CHOICE = /\b(?:remove|delete|drop|take\s+(?:it\s+)?(?:out|off)|no\s+more|don'?t|do\s+not|without|skip|we\s+(?:already\s+)?have|i\s+(?:already\s+)?have|already\s+have|on\s+hand|left\s*over|leftover|from\s+last\s+time|inventory)\b/i;
function releasedBy(message, onHand) {
  const m = String(message || '');
  if (!m.trim() || !(onHand || []).length || parseOnHand(m).length) return [];
  const out = [];
  for (const line of m.replace(/\r/g, '').split('\n')) {
    if (!line.trim() || NOT_A_CHOICE.test(line)) continue;
    const lw = new Set(words(line));
    for (const o of onHand) {
      const ow = words(o.name);
      if (ow.length && ow.every(w => lw.has(w)) && !out.includes(o.name)) out.push(o.name);
    }
  }
  return out;
}

// Stock the customer HAS, said inline (Nov 25, DC on Slack, Compass Group): "they confirmed they already have 7 cases of White
// Claw + 15 cases of Yuengling, so remove these" — neither was in the basket; the edit reader and the model both removed ALL
// four beer lines (Michelob, Stella, Bold City, Fish Camp). inlineOnHand reads the products named after "already / still have";
// removalAllowed lets a removal through only for a line that IS one of them or that the message names by its own words.
function inlineOnHand(text) {
  const out = [];
  const t = String(text || '').replace(/[*_~`]/g, '');
  const re = /\b(?:already|still)\s+(?:have|has|got)\s+([^.?!\n]+)/gi;
  let m;
  while ((m = re.exec(t))) {
    const clause = m[1].split(/,\s*(?:so|and so|which|can|could|please|but)\b|\s+so\s+|\s+(?:which|that)\s+(?:is|are)\b/i)[0];
    for (const piece of clause.split(/\s*(?:\+|,|&|\band\b|\bplus\b)\s*/i)) {
      const q = piece.match(/^\s*(\d+)\b/);
      const name = cleanName(piece.replace(/^\s*\d+\s*(?:cases?|packs?|bottles?|cans?|btls?)?\s*(?:of\s+)?/i, '')).replace(/^(?:the|some)\s+/i, '').trim();
      if (name && /[a-z]{3}/i.test(name) && name.split(/\s+/).length <= 6) out.push({ name, qty: q ? +q[1] : null });
    }
  }
  return out;
}
const GENERIC = new Set(['beer', 'beers', 'lager', 'ale', 'ipa', 'pils', 'pilsner', 'seltzer', 'seltzers', 'wine', 'wines', 'red', 'white', 'rose',
  'sparkling', 'prosecco', 'spirits', 'cans', 'can', 'bottles', 'bottle', 'pack', 'brut', 'reserve', 'classic', 'original', 'premium', 'light', 'ultra', 'brown']);
// modelOnHand: the fact reader's on_hand (the model's reading, primary since Nov 25); the pattern only when it has none
function removalAllowed(message, lineName, modelOnHand) {
  const oh = Array.isArray(modelOnHand) && modelOnHand.length ? modelOnHand.filter(o => o && o.name).map(o => ({ name: String(o.name), qty: +o.qty || null })) : inlineOnHand(message);
  if (!oh.length) return { ok: true };
  if (isOnHand(lineName, oh)) return { ok: true, why: 'the line is stock the customer has' };
  const msgW = new Set(words(String(message || '').replace(/[*_~`]/g, '')));
  const own = words(lineName).filter(w => w.length >= 4 && !GENERIC.has(w) && !/^\d/.test(w));
  if (own.some(w => msgW.has(w))) return { ok: true, why: 'the message names the line' };
  return { ok: false, why: 'the message says the customer already has ' + oh.map(o => o.name).join(' + ') + ' — "' + lineName + '" is not one of them and is not named' };
}

module.exports = { parseOnHand, isOnHand, releasedBy, inlineOnHand, removalAllowed };
