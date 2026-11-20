// search-normalize.js (DC, Nov 20): abbreviations (whole words), aliases (whole message), zero-result spell check.
const SN = require('../../search-normalize.js');
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log((cond ? '  ✓ ' : '  ✗ ') + label); };
const ex = SN.expandAbbreviations;

// ── Layer 1: abbreviations, whole words only, longest first ──
ok('abbr: "cakebread chard" -> "cakebread chardonnay"', ex('cakebread chard') === 'cakebread chardonnay');
ok('abbr: "Far Niente Chard 750ml" -> chardonnay, the rest kept as typed', ex('Far Niente Chard 750ml') === 'Far Niente chardonnay 750ml');
ok('abbr: "cakebread cab" -> "cakebread cabernet"', ex('cakebread cab') === 'cakebread cabernet');
ok('abbr: "cloudy bay sav blanc" -> sauvignon blanc (never "sauvignon blanc blanc")', ex('cloudy bay sav blanc') === 'cloudy bay sauvignon blanc');
ok('abbr: "cloudy bay sauv blanc" -> sauvignon blanc (the two-word pattern first)', ex('cloudy bay sauv blanc') === 'cloudy bay sauvignon blanc');
ok('abbr: "cristal champ" -> "cristal champagne"', ex('cristal champ') === 'cristal champagne');
ok('abbr: "caymus cabsav" -> cabernet sauvignon', ex('caymus cabsav') === 'caymus cabernet sauvignon');
ok('abbr: "caymus cab sav" / "cab sauv" -> cabernet sauvignon (never "cabernet sauvignon blanc")', ex('caymus cab sav') === 'caymus cabernet sauvignon' && ex('caymus cab sauv') === 'caymus cabernet sauvignon');
ok('abbr NEGATIVE: "cab franc" is Cabernet Franc — not rewritten', ex('cab franc') === 'cab franc' && ex('Chinon cab franc 750ml') === 'Chinon cab franc 750ml');
ok('abbr NEGATIVE: whole words only ("richard", "scab", "chardonnay", "champagne", "cabernet" unchanged)', ['richard', 'scab', 'Chardonnay', 'Champagne', 'Cabernet Sauvignon', 'savory'].every(t => ex(t) === t));
ok('abbr NEGATIVE: "domaine bousquet malbec" / "opus one" unchanged', ex('domaine bousquet malbec') === 'domaine bousquet malbec' && ex('opus one') === 'opus one');
ok('abbr: "Tito\'s" keeps its apostrophe (no word touched)', ex("Tito's Handmade Vodka") === "Tito's Handmade Vodka");

// ── Layer 2: aliases, the WHOLE message only ──
ok('alias: "vueve" -> Veuve Clicquot', (SN.aliasFor('vueve') || {}).to === 'Veuve Clicquot');
ok('alias: "DOM" (any case) -> Dom Perignon', (SN.aliasFor('DOM') || {}).to === 'Dom Perignon');
ok('alias: "dom p" -> Dom Perignon', (SN.aliasFor('dom p') || {}).to === 'Dom Perignon');
ok('alias: "  Vueve! " -> normalized, still the alias', (SN.aliasFor('  Vueve! ') || {}).to === 'Veuve Clicquot');
ok('alias: "titos" -> Tito\'s Vodka', (SN.aliasFor('titos') || {}).to === "Tito's Vodka");
ok('alias NEGATIVE: "opus one", "domaine bousquet malbec", "cab franc" are no alias', ['opus one', 'domaine bousquet malbec', 'cab franc'].every(m => SN.aliasFor(m) === null));
ok('alias NEGATIVE: never inside a longer message ("I want dom", "add dom and cristal")', SN.aliasFor('I want dom') === null && SN.aliasFor('add dom and cristal') === null);
ok('alias NEGATIVE: "cakebread sauv" (DC: approve = no) is not in the file', SN.aliasFor('cakebread sauv') === null);
ok('aliasTerm: the model searched the customer\'s whole message -> rewritten', SN.aliasTerm('dom', 'DOM') === 'Dom Perignon');
ok('aliasTerm: a search text that is only part of the message -> untouched', SN.aliasTerm('dom', 'add dom and cristal') === 'dom' && SN.aliasTerm('Cristal', 'vueve') === 'Cristal');

// ── Layer 3: zero-result spell check, category words only (data/search-category-words.json) ──
{ const f = SN.spellFix('proseco');
  ok('spell: "proseco" -> "prosecco" (a category word)', f && f.term === 'prosecco'); }
ok('spell: "chardonay" / "tequlia" / "bourbn" -> the category word', (SN.spellFix('chardonay') || {}).term === 'chardonnay' && (SN.spellFix('tequlia') || {}).term === 'tequila' && (SN.spellFix('bourbn') || {}).term === 'bourbon');
ok('spell: brands are NEVER corrected — no store vocabulary ("veuve clicqout" -> null)', SN.spellFix('veuve clicqout') === null);
ok('spell NEGATIVE: "domaine bousquet malbec" -> null ("bouquet" is no category word)', SN.spellFix('domaine bousquet malbec') === null);
ok('spell NEGATIVE: "chard farm pinot noir" -> null', SN.spellFix('Chard Farm pinot noir') === null);
ok('spell: nothing unknown -> null (never a rewrite)', SN.spellFix('la marca prosecco') === null);
ok('spell: the category list holds only 5+ letter words (no gin / rose / brut / franc targets)', [...SN.CATEGORY].every(w => w.length >= 5) && !SN.CATEGORY.has('franc') && SN.CATEGORY.has('prosecco'));
ok('spell NEGATIVE: "Merlet cognac" -> "merlot cognac" is proposed, but the retry is rejected unless a row names BOTH words',
  SN.acceptFix(SN.spellFix('Merlet cognac'), [{ name: 'Josh Cellars Merlot - 750 ML' }]).length === 0);
ok('spell NEGATIVE: "bousquet" -> the retry must name every word, else rejected',
  SN.acceptFix({ term: 'domaine bouquet malbec' }, [{ name: 'Bouquet Garni Red' }, { name: 'Domaine X Malbec' }]).length === 0);
ok('spell: the retry is kept when a row names the corrected words', SN.acceptFix({ term: 'prosecco' }, [{ name: 'La Marca Prosecco - 750 ML' }]).length === 1);
ok('spell: short words (< 4 letters) and numbers are never changed', SN.spellFix('dom 750ml', ['don']) === null);
ok('spell: a tie (two target words equally close) is left alone', SN.spellFix('bota', ['bola', 'boca']) === null);
ok('spell: first letter must match ("xrosecco" is not "prosecco")', SN.spellFix('xrosecco') === null);

// ── Abbreviation safety: an expansion that found nothing retries the typed text ──
ok('expansionMissed: expanded + 0 rows -> retry the typed text', SN.expansionMissed('Chard Farm pinot noir', 'chardonnay Farm pinot noir', 0) === true);
ok('expansionMissed: rows found -> no retry', SN.expansionMissed('cakebread chard', 'cakebread chardonnay', 3) === false);
ok('expansionMissed: nothing expanded -> no retry', SN.expansionMissed('opus one', 'opus one', 0) === false);

// ── The relevance filter judges rows by the text actually searched (Nov 20 staging: "proseco" -> 12 Proseccos, all dropped) ──
{ const SM = require('../../search-match.js');
  const rows = [{ name: 'La Marca Prosecco - 750 ML', price: 17 }, { name: 'Mionetto Prosecco Brut - 750 ML', price: 15 }];
  ok('searchedText: spell check / abbreviation changed the text -> that text', SN.searchedText('proseco', 'prosecco') === 'prosecco' && SN.searchedText('rombauer chard 750ml', 'rombauer chardonnay 750ml') === 'rombauer chardonnay 750ml');
  ok('searchedText: unchanged (or only case / punctuation) -> null, judged as typed', SN.searchedText('opus one', 'opus one') === null && SN.searchedText('Opus One', 'opus one') === null && SN.searchedText('x', null) === null);
  ok('relevance: judged on "proseco" every Prosecco is dropped (the bug)', SM.rankByMatch('proseco', rows).products.length === 0);
  ok('relevance: judged on the searched "prosecco" both are kept', SM.rankByMatch(SN.searchedText('proseco', 'prosecco'), rows).products.length === 2); }

// ── Off switch: rachel/data/search-normalize-config.json, read at start ──
{ const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-')), data = path.join(dir, 'data');
  fs.mkdirSync(data);
  for (const f of ['search-aliases.json', 'search-abbreviations.json', 'search-category-words.json']) fs.copyFileSync(path.join(__dirname, '../../data', f), path.join(data, f));
  fs.writeFileSync(path.join(data, 'search-normalize-config.json'), JSON.stringify({ abbreviations: false, aliases: false, spellcheck: false }));
  fs.copyFileSync(path.join(__dirname, '../../search-normalize.js'), path.join(dir, 'search-normalize.js'));
  const OFF = require(path.join(dir, 'search-normalize.js'));
  ok('off switch: every layer false -> no abbreviation, no alias, no spell fix', OFF.expandAbbreviations('cakebread chard') === 'cakebread chard' && OFF.aliasFor('vueve') === null && OFF.spellFix('proseco') === null);
  ok('off switch: the shipped config has every layer on', JSON.stringify(SN.enabled()) === JSON.stringify({ abbreviations: true, aliases: true, spellcheck: true }));
  fs.rmSync(dir, { recursive: true, force: true }); }

if (failed) { console.log(failed + ' failed'); process.exit(1); }
