// Alternatives listed in the proposal PDF next to the basket line they could replace. Real case (Oct 1, Sean,
// Foodie For All): "can you give two options for the prosecco, sauv blanc, and rose?" got a list in the reply; "send a
// pdf proposal and include the various prosecco, sauv blanc, and rose options separately" got a PDF with only the
// three basket wines. The options shown are kept in the session (state.shownOptions, from the grouped product_query
// result) and, when a proposal asks for them, passed to generate_proposal as `options` — decided here, in code.
//
// options = [{ label, selected: {name, size, qty, price} | null, alternatives: [{name, size, price, url, product_id}] }]

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '');
const wordsOf = s => norm(s).replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz)\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !/^(the|of|and|de|du|la|le|el|by|ml|oz)$/.test(w));

// "include the ... options", "with the alternatives", "list the choices" — in a proposal request.
function wantsOptions(msg) {
  const s = String(msg || '');
  if (/\b(?:without|no|don'?t include|do not include|skip|remove)\b[^.?!\n]{0,30}\b(?:options|alternatives|choices)\b/i.test(s)) return false;
  return /\b(?:options|alternatives|choices)\b/i.test(s);
}
// "remove the options from the proposal" — a later proposal goes without them.
function dropsOptions(msg) {
  return /\b(?:without|no|remove|drop|take out|don'?t include|do not include)\b[^.?!\n]{0,30}\b(?:options|alternatives|choices)\b/i.test(String(msg || ''));
}
// "two options for ..." -> 2
function countAsked(msg) {
  const m = norm(msg).match(/\b(one|two|three|four|five|1|2|3|4|5)\s+(?:more\s+|other\s+|different\s+)?(?:options?|choices|alternatives|picks)\b/);
  return m ? ({ one: 1, two: 2, three: 3, four: 4, five: 5 }[m[1]] || parseInt(m[1], 10)) : null;
}

// The grouped search result (product_query with several labelled queries) -> [{label, products}]
function groupsFromResult(queries, result) {
  if (!result || !Array.isArray(result.results)) return [];
  return result.results.map((r, i) => ({
    // product_query results are labeled by their query; the alternatives intent has no queries — each result names the
    // original it replaces in r.query (F-0021: those options were never kept, the PDF said none were shown)
    label: String((queries && queries[i] && (queries[i].label || queries[i].term || queries[i].name)) || r.label || r.query || '').trim(),
    products: (r && Array.isArray(r.products) ? r.products : []).map(p => ({
      name: p.name || '', size: p.size || p.sizeStr || '', price: Number(p.salePrice || p.price) || 0,
      url: p.url || '', product_id: p.product_id || p.id || '', upc: p.upc || '', establishmentId: p.establishmentId || '' })),
  })).filter(g => g.label && g.products.length);
}

// Was this product named in the reply the customer saw? Most of its name words appear there.
function shownIn(reply, name) {
  const rw = new Set(wordsOf(reply)), pw = wordsOf(name);
  if (!pw.length) return false;
  return pw.filter(w => rw.has(w)).length >= Math.max(2, Math.ceil(pw.length * 0.7)) || (pw.length === 1 && rw.has(pw[0]));
}

// shown = state.shownOptions {groups, want, reply}; items = basket lines; lineFor(items, label) -> index | -1
function buildOptions(shown, items, lineFor = require('./basket-line.js')) {
  if (!shown || !Array.isArray(shown.groups)) return [];
  const out = [];
  for (const g of shown.groups) {
    const ix = lineFor(items || [], g.label);
    const sel = ix >= 0 ? items[ix] : null;
    let alts = g.products.filter(p => !(sel && (p.product_id && p.product_id === sel.product_id || norm(p.name) === norm(sel.name))));
    // Only what the reply actually listed (the LLM may show fewer than the search returned), when it named any.
    const inReply = shown.reply ? alts.filter(p => shownIn(shown.reply, p.name)) : [];
    if (inReply.length) alts = inReply;
    if (shown.want) alts = alts.slice(0, shown.want);
    else alts = alts.slice(0, 3);
    if (!alts.length) continue;
    out.push({ label: g.label, selected: sel ? { name: sel.name || sel.label, size: sel.size || '', qty: sel.qty || sel.quantity || 1, price: Number(sel.price) || 0 } : null, alternatives: alts });
  }
  return out;
}

// One line for the chat/email reply: "Options in the PDF: Prosecco (2), Sauvignon Blanc (2), Provence Rose (2)."
function describe(options) {
  if (!options || !options.length) return '';
  return 'Options listed in the PDF: ' + options.map(o => o.label + ' (' + o.alternatives.length + ')').join(', ') + '.';
}

module.exports = { wantsOptions, dropsOptions, countAsked, groupsFromResult, buildOptions, describe, shownIn };
