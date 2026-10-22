// Ready-made sentences about an event package, computed in code from its FINAL line items (after the shopping agent's
// budget upgrades) — the Voiceflow BuildPackage v2.7.18-20 outputs (DC, Oct 21; every channel):
//   drinks_statement      "This package delivers about 5 drinks per person for your 20 guests over 2 hours (about 100
//                          drinks total)." — whole numbers, shown with EVERY package (appended in code, never the LLM's)
//   why_drinks_statement  the answer to "why N drinks per person?" — shown only when the customer asks
//   wine_heading          "WINE — 7 bottles (3 red, 3 white, 1 sparkling)" — the counts the reply must show
// The target (Rachel's rule of thumb, 2 drinks the first hour + 1 an hour, functions.js) decides which "why" applies.
const mlOf = t => { const m = String(t || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|l|cl)\b/); return m ? (m[2] === 'l' ? +m[1] * 1000 : m[2] === 'cl' ? +m[1] * 10 : +m[1]) : 0; };
const packOf = t => { const s = String(t || '').toLowerCase(); const m = s.match(/(\d+)\s*x\s*\d/) || s.match(/(\d+)\s*-?\s*(?:pk|pack)[cbs]?\b/); return m ? +m[1] : 0; };

function servings(li) {
  const q = +li.qty || 0, cat = String(li.category || '').toLowerCase();
  if (cat === 'wine') return q * ((mlOf(li.name) || mlOf(li.size) || 750) / 150);
  if (cat === 'spirits') return q * ((mlOf(li.name) || mlOf(li.size) || 750) / 46.875);
  if (cat === 'beer') return q * (packOf(li.size) || packOf(li.name) || 12);
  return 0;   // mixers, water, supplies
}

const SPARK = /spark|champ|prosecco|cava|brut|cr[eé]mant|spumante|franciacorta|bubbl/i;
const ROSE = /\bros[eé](?![a-z])|blush|white zinfandel/i;   // "é" is not a word character: \b after it never matches
const WHITE = /\bwhite\b|blanc|chardonnay|pinot gri|riesling|moscato|viognier|albari|vermentino|gr[uü]ner|semillon|chenin|torront|chablis|sancerre|soave|gavi|verdejo/i;
const RED = /\bred\b|cabernet|merlot|pinot noir|malbec|syrah|shiraz|zinfandel|tempranillo|sangiovese|grenache|nebbiolo|chianti|rioja|bordeaux|barolo|montepulciano/i;
function wineHeading(items) {
  const n = { red: 0, white: 0, sparkling: 0, 'rosé': 0, other: 0 }; let tot = 0;
  for (const li of items) {
    if (String(li.category || '').toLowerCase() !== 'wine') continue;
    const q = parseInt(li.qty, 10) || 0, s = String(li.label || '') + ' ' + String(li.name || '');
    tot += q;
    // The line's label decides first ("White Wine" stays white even when the bottle is a Blanc de Blancs Brut) — the
    // section it is shown under; the product name only when the label names no colour (a customer's own list line).
    const lab = String(li.label || '');
    const k = SPARK.test(lab) ? 'sparkling' : ROSE.test(lab) ? 'rosé' : RED.test(lab) ? 'red' : WHITE.test(lab) ? 'white'
      : SPARK.test(s) ? 'sparkling' : ROSE.test(s) ? 'rosé' : RED.test(s) ? 'red' : WHITE.test(s) ? 'white' : 'other';
    n[k] += q;
  }
  if (!tot) return '';
  const parts = ['red', 'white', 'sparkling', 'rosé', 'other'].filter(k => n[k] > 0).map(k => n[k] + ' ' + k);
  return 'WINE — ' + tot + ' bottle' + (tot === 1 ? '' : 's') + (parts.length ? ' (' + parts.join(', ') + ')' : '');
}

// o: { guests, hours, drinksPerPerson, targetDrinks }
function packageFacts(items, o) {
  items = Array.isArray(items) ? items : (() => { try { return JSON.parse(items || '[]'); } catch (e) { return []; } })();
  const guests = parseInt(o && o.guests, 10) || 0;
  const out = { drinks_statement: '', why_drinks_statement: '', wine_heading: wineHeading(items), delivered_drinks: 0 };
  if (!guests) return out;
  const delivered = Math.round(items.reduce((s, li) => s + servings(li), 0));
  if (!delivered) return out;
  const dpp = Math.max(1, Math.round(delivered / guests));
  const hours = parseFloat(o.hours) || 0, givenDpp = parseFloat(o.drinksPerPerson) || 0;
  const hoursTxt = (!givenDpp && hours > 0) ? ' over ' + (Math.round(hours * 10) / 10) + ' hour' + (hours === 1 ? '' : 's') : '';
  out.delivered_drinks = delivered;
  out.drinks_statement = 'This package delivers about ' + dpp + ' drinks per person for your ' + guests + ' guests' + hoursTxt + ' (about ' + (dpp * guests) + ' drinks total).';
  const target = parseFloat(o.targetDrinks) || 0;
  out.why_drinks_statement = (target > 0 && delivered > target * 1.15)
    ? 'Your package includes at least one bottle or pack of each type so there\'s real variety for your ' + guests + ' guests, which is why it covers about ' + dpp + ' drinks per person. The rest of your budget goes into premium selections rather than extra quantity.'
    : 'This package is sized for about ' + dpp + ' drinks per person for your ' + guests + ' guests, and any remaining budget goes into premium selections rather than extra quantity.';
  return out;
}

module.exports = { packageFacts, wineHeading, servings };
