// add-replace.js (DC, Nov 20): an add-item replaces a basket line only with a switch phrase, no add word, the PRODUCT's own
// type, and exactly one basket line of that type.
const AR = require('../../add-replace.js');
const basketLineFor = require('../../basket-line.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const patron = { name: 'Patrón Silver Tequila - 750 ML', qty: 4 }, goose = { name: 'Grey Goose Vodka 750ML', qty: 3 }, ketel = { name: 'Ketel One Vodka - 1 L', qty: 2 };
const josh = { name: 'Josh Cellars Sauvignon Blanc - 750 ML', qty: 2 };
const titos = { name: "Tito's Handmade Vodka - 750 ML", category: 'Liquor' }, casa = { name: 'Casamigos Blanco Tequila - 750 ML', category: 'Liquor' };
// a. switch phrase required; an add word always wins
const BL = basketLineFor; const D = (m, p, it) => AR.decide(m, p, it, BL);
ok('a: "add Casamigos Blanco" with Patrón -> new line', AR.decide('add Casamigos Blanco Tequila 750ml', casa, [patron]).action === 'add');
ok('a: "let\'s go with Tito\'s for vodka" with one vodka -> replace it', (d => d.action === 'replace' && d.line === goose && d.reason === 'go with')(AR.decide("let's go with Tito's for vodka", titos, [goose, patron])));
ok('a: "Tito\'s instead" / "switch to" / "swap" / "replace" / "change to" / "make it the" -> replace',
  ["Tito's instead", "switch to Tito's", "swap the vodka for Tito's", "replace the Grey Goose with Tito's", "change it to Tito's", "make it the Tito's"].every(m => AR.decide(m, titos, [goose]).action === 'replace'));
ok('a: an add word beats a switch phrase ("add Tito\'s instead of the Grey Goose", "go with Tito\'s too", "also swap in Tito\'s", "plus", "another", "as well")',
  ["add Tito's instead of the Grey Goose", "go with Tito's too", "also swap in Tito's", "plus go with Tito's", "go with another vodka, Tito's", "go with Tito's as well"].every(m => AR.decide(m, titos, [goose]).action === 'add'));
ok('a: no switch phrase ("Tito\'s 750ml", "I need Tito\'s") -> new line', ["Tito's 750ml", "I need Tito's"].every(m => AR.decide(m, titos, [goose]).action === 'add'));
ok('a: the reason names the add word', /"add"/.test(AR.decide('add Casamigos', casa, [patron]).reason));
// b. the type is the product's own, never the message's
const nov17 = { name: 'Oyster Bay Rosé - 2020 - 750 ML', category: 'Wine' };
ok('b: Nov 17 — "go with Oyster Bay Sauvignon Blanc" resolved to the Rosé -> Josh Sauvignon Blanc is not its type, new line',
  AR.decide('go with Oyster Bay Sauvignon Blanc', nov17, [josh]).action === 'add');
ok('b: Nov 17 exact message "can you add Oyster Bay Sauvignon Blanc" -> new line', AR.decide('can you add Oyster Bay Sauvignon Blanc', nov17, [josh]).action === 'add');
ok('b: "instead, the vodka one: Whispering Angel" — a product with no type word in its name/category -> new line',
  AR.decide('go with Whispering Angel instead of the vodka', { name: 'Whispering Angel - 750 ML', category: 'Wine' }, [goose]).action === 'add');
ok('b: the category counts ("Rosé" category on a name without it)', AR.typesOf({ name: 'Whispering Angel - 750 ML', category: 'Rosé Wine' }).includes('rose'));
ok('b: two-word grapes are one type (Sauvignon Blanc is not Chenin Blanc / Cabernet Sauvignon)',
  AR.decide('go with Dry Creek Chenin Blanc', { name: 'Dry Creek Chenin Blanc - 750 ML' }, [josh]).action === 'add'
  && AR.decide('go with Josh Cabernet', { name: 'Josh Cellars Cabernet Sauvignon - 750 ML' }, [josh]).action === 'add'
  && AR.decide('go with Oyster Bay Sauvignon Blanc instead', { name: 'Oyster Bay Sauvignon Blanc - 750 ML' }, [josh]).action === 'replace');
// c. exactly one line of the type
{ const d = AR.decide("go with Tito's instead", titos, [goose, ketel, patron]);
  ok('c: two vodka lines -> ask which, nothing replaced', d.action === 'ask' && d.lines.length === 2);
  const t = AR.askText(titos.name, d.lines, d.type);
  ok('c: the question lists both lines as bullets (never "1.")', /• 3x Grey Goose/.test(t) && /• 2x Ketel One/.test(t) && !/^\s*\d[.)]/m.test(t));
  const pend = { lines: d.lines.map(l => l.name) }, items = [goose, ketel, patron];
  ok('c: answer "the Ketel One" -> replace that line', (a => a && a.action === 'replace' && a.line === ketel)(AR.answer('the Ketel One', pend, items, basketLineFor)));
  ok('c: answer "keep both" / "new line" -> add', AR.answer('keep both', pend, items, basketLineFor).action === 'add' && AR.answer('as a new line please', pend, items, basketLineFor).action === 'add');
  ok('c: an unrelated answer -> not an answer (dropped)', AR.answer('what gins do you have?', pend, items, basketLineFor) === null);
  ok('c: a line gone since the question is never replaced', AR.answer('the Ketel One', pend, [goose, patron], basketLineFor) === null);
}
ok('c: no line of the type -> new line', AR.decide("go with Tito's instead", titos, [patron]).action === 'add');
ok('c: the product itself in the basket is not "another" line', AR.decide("go with Tito's instead", titos, [{ name: "Tito's Handmade Vodka - 750 ML", qty: 1 }]).action === 'add');
// named line (DC, Nov 20, decision 2): the message names the line to take out -> replaced even with "add"
{ const it = [goose, patron];
  ok('named: "add Tito\'s instead of the Grey Goose" -> Grey Goose replaced, reason named line', (d => d.action === 'replace' && d.line === goose && d.reason === 'named line')(D("add Tito's instead of the Grey Goose", titos, it)));
  ok('named: "in place of the Patron" / "replace the Patron with" / "swap out the Patron" / "swap the Patron for" -> the Patrón line',
    ["add Casamigos in place of the Patron", "replace the Patron with Casamigos", "swap out the Patron, add Casamigos", "swap the Patron for Casamigos"].every(m => (d => d.action === 'replace' && d.line === patron)(D(m, casa, it))));
  ok('named: "replace the Josh" names Josh (a short name)', D('replace the Josh with Oyster Bay', { name: 'Oyster Bay Sauvignon Blanc - 750 ML' }, [josh, patron]).line === josh);
  ok('named: a line named by type ("instead of the vodka") is that line', D("add Tito's instead of the vodka", titos, it).line === goose);
  { const d = D("add Tito's instead of the Absolut", titos, it);
    ok('named: not in the basket -> new line + notFound (Rachel says so)', d.action === 'add' && d.notFound === 'Absolut' && /not in the basket/.test(d.reason)); }
  ok('named: "switch to Tito\'s" / "swap in Tito\'s" / "replace it" name no line (type rules apply)',
    AR.namedLine("switch to Tito's", it, BL) === null && AR.namedLine("swap in Tito's", it, BL) === null && AR.namedLine('replace it with Tito\'s', it, BL) === null);
  ok('named: "add Tito\'s" names nothing -> add word -> new line', D("add Tito's", titos, it).action === 'add' && !D("add Tito's", titos, it).notFound);
  ok('named: text after the name is ignored ("instead of the Grey Goose I\'d like Tito\'s")', D("instead of the Grey Goose I'd like Tito's", titos, it).line === goose);
}
// stored decisions (Nov 20, DC): an add-item options list stores the MESSAGE's decision; the pick applies it to the picked product
{ const it = [josh, patron], osb = { name: 'Oyster Bay Sauvignon Blanc - 750 ML' };
  const i1 = AR.intentFor('can you add Oyster Bay Sauvignon Blanc', it, BL);
  ok('stored new_line ("add"): label new_line; the pick goes in as a new line, Josh stays', AR.intentLabel(i1) === 'new_line' && AR.applyIntent(i1, osb, it).action === 'add');
  const i2 = AR.intentFor('Oyster Bay Sauvignon Blanc please', it, BL);
  ok('stored new_line (no switch phrase): a new line', i2.kind === 'new_line' && AR.applyIntent(i2, osb, it).action === 'add');
  const i3 = AR.intentFor('add Oyster Bay instead of the Josh', it, BL);
  ok('stored replace_named: label carries the line; the pick replaces Josh', AR.intentLabel(i3) === 'replace_named:' + josh.name && (d => d.action === 'replace' && d.line === josh && d.reason === 'named line')(AR.applyIntent(i3, osb, it)));
  ok('stored replace_named, the line gone by pick time: new line', AR.applyIntent(i3, osb, [patron]).action === 'add');
  const i4 = AR.intentFor('add Oyster Bay instead of the Kim Crawford', it, BL);
  ok('stored new_line with notFound (named line not in the basket): new line + notFound', i4.kind === 'new_line' && AR.applyIntent(i4, osb, it).notFound === 'Kim Crawford');
  const i5 = AR.intentFor("let's go with Oyster Bay", it, BL);
  ok('stored replace_by_type: label replace_by_type; one Sauvignon Blanc line -> the pick replaces it', AR.intentLabel(i5) === 'replace_by_type' && AR.applyIntent(i5, osb, it).line === josh);
  ok('stored replace_by_type, the pick is another type (a Rosé): new line', AR.applyIntent(i5, { name: 'Oyster Bay Rosé - 2020 - 750 ML' }, it).action === 'add');
  ok('stored replace_by_type, two lines of the type: ask', AR.applyIntent(i5, osb, [josh, { name: 'Kim Crawford Sauvignon Blanc - 750 ML', qty: 1 }]).action === 'ask');
}
// search text: the take-out clause is cut, the product kept (Nov 20, scenario 168)
{ const sr = x => AR.searchRef(x);
  ok('search: "Tito\'s 750ml instead of the Grey Goose" -> "Tito\'s 750ml"', sr("Tito's 750ml instead of the Grey Goose").ref === "Tito's 750ml" && sr("Tito's 750ml instead of the Grey Goose").cut);
  ok('search: "Casamigos in place of the Patron" -> "Casamigos"', sr('Casamigos in place of the Patron').ref === 'Casamigos');
  ok('search: "Kim Crawford rather than the Josh" -> "Kim Crawford"', sr('Kim Crawford rather than the Josh').ref === 'Kim Crawford');
  ok('search: "replace the Grey Goose with Tito\'s 750ml" -> the part after "with"', sr("replace the Grey Goose with Tito's 750ml").ref === "Tito's 750ml");
  ok('search: "swap out the Bacardi for Mount Gay Black Barrel" -> the part after "for"', sr('swap out the Bacardi for Mount Gay Black Barrel').ref === 'Mount Gay Black Barrel');
  ok('search: "swap the Bacardi for the Mount Gay" / "switch out the Josh for Oyster Bay" -> after "for"', sr('swap the Bacardi for the Mount Gay').ref === 'Mount Gay' && sr('switch out the Josh for Oyster Bay').ref === 'Oyster Bay');
  ok('search: "instead of the Grey Goose, Tito\'s 750ml" -> after the comma', sr("instead of the Grey Goose, Tito's 750ml").ref === "Tito's 750ml");
  ok('search: "Tito\'s 750ml instead" -> "Tito\'s 750ml"', sr("Tito's 750ml instead").ref === "Tito's 750ml");
  ok('search: a plain product is left alone (not cut)', !sr("Tito's Handmade Vodka 750ml").cut && sr("Tito's Handmade Vodka 750ml").ref === "Tito's Handmade Vodka 750ml");
  ok('search: a product with "for" in it is not cut when no swap verb leads ("Glass for Two Rosé")', !sr('Glass for Two Rosé').cut);
}
if (failed) { console.log(failed + ' failed'); process.exit(1); }
