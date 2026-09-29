// The reply to a shopping list (ShoppingAgent custom_list), composed in code. Real flakiness (Sep 29,
// smoke runs): the LLM wrote the whole reply, so the basket layout ("3x" vs "× 3"), whether a product
// total appeared, and what it asked about an unavailable item changed run to run — cta-sub-named got a
// size list instead of the named substitute, shopping-list lost its line items. The basket is known in
// code (state.lastLineItems), so it is rendered here; the only LLM text kept is a numbered option list
// it searched for a GENERIC item it couldn't match ("dry rosé"), which code can't write.
// A NAMED product that isn't available ("Grey Goose Vodka 3.5 L") gets a plain line, and the CTA table
// then offers the in-stock substitute (sub.offer_named) — its size list from the LLM is dropped.

// Descriptors, varietals and categories: a name made only of these is generic, not a product.
const GENERIC = new Set(('the and of de du la le a an wine wines red white rose rosé sparkling still dry sweet off light organic ' +
  'natural vineyard vineyards valley estate reserve bottle bottles pack case chardonnay cabernet sauvignon blanc pinot noir grigio ' +
  'gris merlot malbec zinfandel syrah shiraz riesling champagne prosecco cava brut vodka gin rum tequila whiskey whisky bourbon ' +
  'scotch rye mezcal liqueur beer lager ipa seltzer blanco reposado anejo añejo premium nice good cheap budget classic any some ' +
  'french italian spanish californian napa sonoma provence').split(' '));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const brandWords = name => norm(name).replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz|cl)\b/g, ' ').split(/[^a-z0-9']+/)
  .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC.has(w));
const isNamed = name => brandWords(name).length > 0;
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Numbered, priced option runs in the LLM's text, each with the line that introduces it.
function pickBlocks(text) {
  const L = String(text || '').split('\n'), blocks = [];
  for (let i = 0; i < L.length; i++) {
    if (!/^\s*1[.)]\s/.test(L[i])) continue;
    let j = i; const run = [];
    while (j < L.length && /^\s*\d{1,2}[.)]\s/.test(L[j])) run.push(L[j++]);
    if (run.filter(l => /\$\s?\d/.test(l)).length >= 2) {
      let k = i - 1; while (k >= 0 && !L[k].trim()) k--;
      const intro = k >= 0 && !/^\s*(?:-{3,}|\d+[.)]\s)/.test(L[k]) && !/\$\s?\d/.test(L[k]) ? L[k].trim() : '';
      blocks.push({ intro, lines: run });
    }
    i = j;
  }
  return blocks;
}

// items: basket lines; unmatched: names the list couldn't match (events.unmatched); llmText: the LLM's reply.
// Returns { text, named: [...], generic: [...], blocks, log } — named unavailable first (the CTA offers for [0]).
function compose({ items, unmatched, llmText }) {
  const q = li => li.qty || li.quantity || 1, pr = li => parseFloat(li.price) || 0;
  const lines = items.map(li => q(li) + 'x ' + li.name + ' — ' + money(pr(li)) + ' ea = ' + money(q(li) * pr(li)));
  const total = items.reduce((a, li) => a + q(li) * pr(li), 0);
  const clean = n => String(n || '').replace(/^\s*\d{1,3}\s*(?:x\s*|bottles?\s+(?:of\s+)?)?/i, '').trim();
  const un = [...new Set((unmatched || []).map(clean).filter(Boolean))];
  const named = un.filter(isNamed), generic = un.filter(n => !isNamed(n));
  // Option lists about a NAMED unavailable product (its other sizes) are dropped: the CTA names one substitute.
  const blocks = pickBlocks(llmText).filter(b => !named.some(n => { const bw = brandWords(n).slice(0, 2); const bt = ' ' + norm(b.intro + ' ' + b.lines.join(' ')).replace(/[^a-z0-9']+/g, ' ') + ' '; return bw.every(w => bt.includes(' ' + w + ' ')); }));
  let text = (lines.length ? 'Here\'s your list:\n\n' + lines.join('\n') + '\n\nProduct total: ' + money(total) : '');
  for (const n of named) text += '\n\n' + n + ' isn\'t available at this store.';
  const coveredGeneric = generic.filter(g => blocks.some(b => brandWordsLoose(g).some(w => norm(b.intro + ' ' + b.lines.join(' ')).includes(w))));
  for (const g of generic.filter(x => !coveredGeneric.includes(x))) text += '\n\nI couldn\'t find a match for ' + g + ' at this store.';
  for (const b of blocks) text += '\n\n' + (b.intro ? b.intro + '\n' : '') + b.lines.join('\n');
  if (blocks.length) text += '\n\n' + (blocks.length === 1 ? 'Which one would you like?' : 'Which would you like from each list?');
  const log = '[list-reply] composed in code: ' + items.length + ' line(s), total ' + money(total) +
    (named.length ? ', unavailable named: ' + JSON.stringify(named) : '') + (generic.length ? ', unmatched generic: ' + JSON.stringify(generic) : '') +
    ', ' + blocks.length + ' LLM option list(s) kept' + (pickBlocks(llmText).length > blocks.length ? ', ' + (pickBlocks(llmText).length - blocks.length) + ' dropped (sizes of a named unavailable product)' : '');
  return { text: text.trim(), named, generic, blocks, log };
}
// Words that tie a generic request to an option list ("dry rosé" -> rose); descriptors like "dry" alone don't.
function brandWordsLoose(name) {
  return norm(name).replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz|cl)\b/g, ' ').split(/[^a-z0-9']+/).filter(w => w.length >= 3 && !/^(dry|sweet|off|the|and|bottle|bottles|wine|wines)$/.test(w));
}

module.exports = { compose, pickBlocks, isNamed };
