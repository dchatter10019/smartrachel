export default async function main(args) {
  // ============================================================
  // BuildPackage v2.7.21 — composite event-package builder. (v2.7.21: whole-word spirit types, see classifyOk.)
  // v1.1: CUSTOM mode honors per-category price caps; preferred brands win ties.
  // v1.2: quote-mode + caps derives the full range from caps; relax never bypasses a hard cap.
  // v1.3: SERVER-SIDE price filtering (&min=&max=) on hard-capped standard slots; retry once.
  // v1.4: default min = 0.01 when no minimum is given.
  // v1.5: kitchen_location may be a location name OR a full street address.
  // v1.6: new API takes location (name) and zipcode as SEPARATE params — send ONE.
  // v1.7: explicit drinks_per_person input. When > 0 it DRIVES total drinks
  //       (total = guests x drinks_per_person) and OVERRIDES the hours-derived
  //       rate, so a customer who says "2 drinks per person" no longer needs to
  //       give a duration. hours becomes optional when drinks_per_person is set
  //       (a nominal 3h fallback keeps hour-dependent CUSTOM caps sane).
  // v1.8: Beer + Hard Seltzer (+ NA beer) share ONE bucket — the beer allocation
  //       is split EVENLY across whichever are requested (seltzer/NA carved OUT of
  //       the beer share, NOT added on top), and they inherit the beer price cap.
  //       Same result whether drinks came from drinks_per_person or from hours.
  // v1.9: CUSTOM mode fixes — (a) size each beer/seltzer off the ACTUAL case size of
  //       the product picked (parsed from its name/size, e.g. a 12-pack gets 2x the
  //       cases of a 24-pack) instead of the model's assumed pack_size; (b) when a
  //       named product is unavailable, redistribute its share across the AVAILABLE
  //       products in that category instead of losing it.
  // v2.0: AUTO-CUSTOM — any build carrying named_products runs CUSTOM mode even if
  //       package_type is a number (the model sometimes sends package_type="4" AND
  //       a named_products list; the numbered path ignored the names and returned
  //       generic wine/beer). Now the named brands always win. Also: (a) spelling-
  //       variant retry (Light<->Lite, de-spaced) so brands aren't dropped over a
  //       spelling gap; (b) pack count for beer/seltzer now also reads the product
  //       URL slug ("...-12pk-...", "...-8pk-...") — the ONLY place variety-pack
  //       counts like High Noon (12) / Surfside (8) are exposed — so quantities are
  //       sized off the real case, not the assumed 24. (c) Wine splits EVENLY by
  //       sub-type (red / white / sparkling) independent of how many brands per side
  //       survive the price cap, so a dropped white no longer skews the mix to red.
  // v2.1: optional per-category drink-mix percentages (wine_pct / beer_pct /
  //       seltzer_pct / spirit_pct). When given, BOTH modes size each category's
  //       share of the total drinks by that split. CUSTOM: beer vs. hard seltzer
  //       separated, renormalized over categories that have products. STANDARD (1-7):
  //       the package's fixed split is overridden and renormalized over the categories
  //       that package includes; beer% vs seltzer% splits the beer family. Omit them
  //       and behavior is unchanged (default splits, seltzer bucketed with beer).
  // v2.2: standard-package wine defaults to an EVEN red/white split (was 60/40 red);
  //       the odd bottle goes to white. Package 5 = 40 red / 40 white / 20 sparkling.
  //       Custom mode already split red/white evenly.
  // v2.3: standard packages size beer/seltzer off the chosen product's ACTUAL pack
  //       size (parsed from name/size/URL), not the nominal beer_pack_size. Counting a
  //       real 24-pack as a 12-pack was DOUBLING beer/seltzer servings. Custom mode
  //       already did this; now both modes agree.
  // v2.4: (a) NO cap on hours-derived drinks/person — long events keep scaling
  //       (was capped at 4.5). (b) CATEGORY GUARD in CUSTOM mode: a product can only
  //       fill a slot of its own category (a bourbon can't be "wine"). (c) generic
  //       category words passed as named products ("Wine", "Beer", "Hard Seltzer")
  //       resolve as real categories — wine gets a red/white split and a budget-
  //       derived price target — instead of a single fuzzy name-match. (d) budget
  //       trim is proportional (ratios survive) with a largest-remainder fill-up.
  // v2.6: BUDGET-LIMITED signal. New outputs delivered_drinks, delivered_per_person,
  //       target_per_person, budget_limited, suggested_budget — when the budget forces
  //       a package meaningfully smaller than the duration/drinks-per-person target,
  //       Rachel can warn the customer and offer to raise the budget.
  // v2.7: SPEND TOWARD THE BUDGET + FLOOR CAPS.
  //       (a) Price-floor caps: the per-bottle target no longer runs away with the
  //           budget. Spirits target capped at $70 when the customer is mixing
  //           (cocktail_ingredients present) else $90; wine target capped at $60.
  //           pick() also caps the target at 2x the median price of what's actually
  //           in stock, so a $4,000 spirits build can't come back as 6x $330 Weller.
  //       (b) Floors never empty a category: EVERY non-hard-capped slot (cocktail
  //           base spirits included — they were excluded before, which is why
  //           Vodka/Rum/Gin came back "unavailable") retries at $0 before being
  //           reported unavailable. Mixers are searched with no floor and must be
  //           non-alcoholic (no more Ketel One for "mint").
  //       (c) SPEND-UP pass (non-quote builds only): target 90-97% of the product
  //           budget. Pass 1 tiers categories UP — swap each line for the next
  //           pricier in-stock bottle (preferred brands first), bounded by per-
  //           category ceilings (spirits $90 mixing / $150 otherwise, wine $90,
  //           or the customer's hard cap). Pass 2 adds quantity to the least-
  //           covered line while drinks/person stays <= 1.5x the target. The
  //           existing budget trim still runs afterwards, so the package never
  //           exceeds the budget.
  //       (d) New outputs: budget_remaining (total budget minus estimated grand
  //           total), upgraded_lines (count of lines tiered up), and a per-line
  //           "tier" field ("base" | "upgraded" | "added") inside line_items.
  // v2.7.1: budget-aware tier ceilings. A small premium party (20 guests / 2 h / $2,000)
  //         already has every quantity maxed (143 servings vs a 45 target), so the only
  //         lever left is price — but the fixed $90 wine / $150 spirit ceilings stalled it
  //         at 56%. Ceilings now rise to 1.25x the budget-implied price per bottle (max
  //         $400); mixing spirits and quote mode keep the fixed ceilings.
  // v2.7.2: quantity pass REMOVED. The package never carries more drinks than the
  //         guests x hours math (and the category minimums) call for. Budget is spent
  //         on better bottles only; the rest is reported as budget_remaining.
  // v2.7.5: mocktails (mixer-only cocktail_ingredients) add mixers WITHOUT suppressing the default spirits.
  // v2.7.4: beer/seltzer cases are sized per product pack so the slot reaches its drink target.
  // v2.7.3: new output drinks_statement (a numbers-only sentence for Rachel to paste verbatim).
  // ============================================================

  var iv = args.inputVars;
  var guests = parseInt(iv.guests) || 0;
  var hours = parseFloat(iv.hours) || 0;
  var drinksPerPerson = parseFloat(iv.drinks_per_person) || 0;
  var rawPackageType = iv.package_type;
  var isCustom = (rawPackageType === "CUSTOM" || rawPackageType === "custom");
  var packageType = isCustom ? "CUSTOM" : (parseInt(rawPackageType) || 5);
  var totalBudget = parseFloat(iv.total_budget) || 0;
  var beerPackSize = parseInt(iv.beer_pack_size) || 12;
  function resolveLocation(raw) {
    var s = String(raw || "").replace(/–/g, "-").trim();
    var zips = s.match(/\b\d{5}\b/g);
    if (zips && zips.length) return { location: "", zipcode: zips[zips.length - 1] };
    return { location: s, zipcode: "" };
  }
  var loc = resolveLocation(iv.kitchen_location);
  var locDisplay = loc.location || loc.zipcode;
  var clientName = String(iv.client_name || "");
  var hardSeltzer = String(iv.hard_seltzer || "") === "true";
  var naBeer = String(iv.na_beer || "") === "true";

  // v2.1: optional per-category drink-mix percentages (CUSTOM mode). When the
  // customer states a split like "Wine 20%, Beer 50%, Hard Seltzer 30%", these size
  // each category's share of the total drinks instead of the default even split.
  // Only the categories that actually have available products are counted, and the
  // provided percentages are renormalized across them so the total drink target is
  // still hit even if one category's share can't be filled.
  var winePct = parseFloat(iv.wine_pct) || 0;
  var beerPct = parseFloat(iv.beer_pct) || 0;
  var seltzerPct = parseFloat(iv.seltzer_pct) || 0;
  var spiritPct = parseFloat(iv.spirit_pct) || 0;
  var hasPct = (winePct > 0 || beerPct > 0 || seltzerPct > 0 || spiritPct > 0);

  var capWineMin = parseFloat(iv.wine_min_price) || 0;
  var capWineMax = parseFloat(iv.wine_max_price) || 0;
  var capBeerMin = parseFloat(iv.beer_min_price) || 0;
  var capBeerMax = parseFloat(iv.beer_max_price) || 0;
  var capSpiritMin = parseFloat(iv.spirit_min_price) || 0;
  var capSpiritMax = parseFloat(iv.spirit_max_price) || 0;
  var hasPriceCaps = !!(capWineMax || capBeerMax || capSpiritMax || capWineMin || capBeerMin || capSpiritMin);
  // v2.6: quote mode with no caps used to run with target 0 / max 999999 and the price-desc tiebreak picked the
  // most expensive bottle on the shelf ($291 Caymus). Use mid-range defaults instead.
  var QD = { wineT: 16, wineMin: 8, wineMax: 28, spiritT: 28, spiritMin: 14, spiritMax: 45 };

  var cocktailIngredients = [];
  if (iv.cocktail_ingredients) {
    try { cocktailIngredients = JSON.parse(iv.cocktail_ingredients) || []; } catch (e) { cocktailIngredients = []; }
  }
  if (!Array.isArray(cocktailIngredients)) cocktailIngredients = [];
  // v2.7: "mixing" = the customer is making cocktails (spirits get mixed, so
  // mixing-grade bottles — not sipping bottles — are the right tier).
  var isMixing = cocktailIngredients.length > 0;
  // v2.7: price-target caps (per bottle). The target drives the stepped floor in
  // pick(), so capping it is what stops a big budget from buying only luxury bottles.
  var SPIRIT_TARGET_CAP = isMixing ? 70 : 90;
  var WINE_TARGET_CAP = 60;
  // v2.7: spend-up ceilings — how far pass 1 may tier a line up (per bottle/pack).
  var SPEND_BAND_LO = 0.90, SPEND_BAND_HI = 0.97;
  var TIER_CEIL = { spirits: isMixing ? 90 : 150, wine: 90, beer: 999999, mixers: 0 };
  // v2.7.1: the ceilings above are FLOORS for the ceiling. When the budget per bottle is
  // higher than them (20 guests / 2 h / $2,000 = ~$230 a bottle), the tier-up pass may
  // climb to 1.25x the budget-implied price, capped at TIER_CEIL_MAX. Mixing spirits
  // never scale (a $300 bottle in a cocktail is the Weller bug). Without this, a small
  // premium party stalls at ~55% of budget with every quantity already maxed.
  var TIER_CEIL_MAX = 400;
  function scaledCeil(base, rawTarget) {
    if (!(rawTarget > 0)) return base;
    return Math.max(base, Math.min(TIER_CEIL_MAX, Math.round(rawTarget * 1.25)));
  }

  var namedProducts = [];
  if (iv.named_products) {
    try { namedProducts = JSON.parse(iv.named_products) || []; } catch (e) { namedProducts = []; }
  }
  if (!Array.isArray(namedProducts)) namedProducts = [];

  // v2.0: ANY build that carries named products IS a custom build, even when the
  // model mislabels package_type as a numbered standard package (e.g. "4"). The
  // numbered path ignores named_products and runs generic category searches, which
  // is what produced Merlot/Moscato/Corona for a request that named Cabernet,
  // Chardonnay and Michelob. Detecting custom from the products themselves makes
  // the function robust to that model mistake.
  if (namedProducts.length > 0) { isCustom = true; packageType = "CUSTOM"; }

  function fail(msg) {
    return { outputVars: {
      success: "false", error: msg, line_items: "[]", line_items_display: "",
      product_total: "0", estimated_tax: "0", estimated_service: "0", estimated_tip: "0",
      delivery_fee: "25", estimated_grand_total: "0", product_budget: "0", budget_used_pct: "0",
      preferred_brands: "", unavailable: "", total_drinks: "0", summary: "", is_custom_mode: isCustom ? "true" : "false",
      delivered_drinks: "0", delivered_per_person: "0", target_per_person: "0", budget_limited: "false", suggested_budget: "0",
      budget_remaining: "0", upgraded_lines: "0"
    }, paths: ["error"] };
  }

  if (guests <= 0) return fail("Missing guests: guests=" + guests);
  if (hours <= 0 && drinksPerPerson <= 0) return fail("Missing hours or drinks_per_person (need one to size drinks)");
  if (totalBudget <= 0) return fail("Missing total_budget");
  var isQuoteMode = (totalBudget >= 999999);
  var quoteDefaults = isQuoteMode && !hasPriceCaps;
  if (totalBudget < 150 && !isQuoteMode) return fail("Budget $" + totalBudget + " is below the $150 minimum.");
  if (!locDisplay || !clientName) return fail("Missing kitchen_location or client_name");
  if (isCustom && namedProducts.length === 0) return fail("package_type=CUSTOM requires named_products");

  // hoursEff: real hours when given, else a nominal 3h so hour-dependent CUSTOM
  // caps don't collapse to zero. Drink COUNT uses drinks_per_person when set,
  // so this fallback never affects the headline quantity in that case.
  var hoursEff = hours > 0 ? hours : 3;

  var baseDpp;
  if (hoursEff <= 1) baseDpp = 1.5;
  else if (hoursEff <= 2) baseDpp = 2.25;
  else if (hoursEff <= 3) baseDpp = 2.90;
  else if (hoursEff <= 4) baseDpp = 3.45;
  else if (hoursEff <= 5) baseDpp = 3.90;
  else baseDpp = 3.90 + (hoursEff - 5) * 0.30; // v2.4: no cap — long events keep scaling (18h -> 7.8/person)

  var mult = 1.0;
  if (!isCustom) {
    if (packageType === 3) mult = 0.80;
    else if (packageType === 6) mult = 0.90;
  }

  var productBudget = isQuoteMode ? 0 : Math.round(((totalBudget - 25) / 1.25) * 100) / 100;

  var NOT_PREFERRED = ["woodbridge", "meiomi", "robert mondavi private selection", "cook's", "cooks", "simi", "j. roget", "caymus", "cakebread", "opus one", "silver oak", "far niente", "duckhorn", "stag's leap", "stags leap", "charles krug"];
  var PREFERRED = ["moet & chandon", "moet and chandon", "dom perignon", "veuve clicquot", "krug", "ruinart", "mercier",
    "chandon", "cloudy bay", "terrazas", "cape mentelle", "newton vineyard", "chateau d'yquem", "chateau cheval blanc", "colgin", "joseph phelps",
    "hennessy", "glenmorangie", "ardbeg", "belvedere",
    "corona", "modelo", "pacifico", "victoria",
    "robert mondavi winery", "schrader", "mount veeder", "the prisoner", "kim crawford", "ruffino", "sea smoke", "lingua franca",
    "high west", "nelson's green brier", "mi campo",
    "kendall-jackson", "kendall jackson", "la crema", "cambria", "carmel road", "matanzas creek", "murphy-goode", "murphy goode", "freemark abbey",
    "cardinale", "lokoya", "mt. brave", "mt brave", "gran moraine",
    "bardstown bourbon", "green river distilling"];

  function brandStatus(name) {
    var n = (name || "").toLowerCase();
    for (var i = 0; i < NOT_PREFERRED.length; i++) if (n.indexOf(NOT_PREFERRED[i]) >= 0) return "other";
    for (var j = 0; j < PREFERRED.length; j++) if (n.indexOf(PREFERRED[j]) >= 0) return "preferred";
    return "other";
  }
  // v2.7: 2 = preferred brand, 1 = neutral, 0 = on the NOT_PREFERRED list (Far Niente,
  // Caymus, Woodbridge...). Used so an avoid-list bottle is the LAST resort, not a
  // default white because it happened to be the priciest thing under the ceiling.
  // v2.7.11: a plain mixer ("Lime Juice") must not resolve to a flavoured variant
  // ("Cucumber Lime Juice with Mint") unless the customer's term names that flavour.
  var curMixerTerm = "";
  var MIXER_FLAVOR_WORDS = ["cucumber", "mint", "strawberry", "mango", "peach", "raspberry", "blueberry", "watermelon", "pineapple", "coconut", "jalapeno", "habanero", "spicy", "pomegranate", "passion", "lavender", "hibiscus", "kombucha"];
  function mixerFlavorPenalty(name) {
    var n = (name || "").toLowerCase(), c = 0;
    for (var f = 0; f < MIXER_FLAVOR_WORDS.length; f++) {
      if (n.indexOf(MIXER_FLAVOR_WORDS[f]) >= 0 && curMixerTerm.indexOf(MIXER_FLAVOR_WORDS[f]) < 0) c++;
    }
    return c;
  }
  function brandRank(name) {
    var n = (name || "").toLowerCase();
    for (var i = 0; i < NOT_PREFERRED.length; i++) if (n.indexOf(NOT_PREFERRED[i]) >= 0) return 0;
    if (n.indexOf("mi campo") >= 0 || n.indexOf("mi-campo") >= 0) return 3; // v2.7.10: Mi Campo is the lead tequila — always ranked first
    for (var j = 0; j < PREFERRED.length; j++) if (n.indexOf(PREFERRED[j]) >= 0) return 2;
    return 1;
  }
  function preferredLabel(name) {
    var n = (name || "").toLowerCase();
    for (var i = 0; i < NOT_PREFERRED.length; i++) if (n.indexOf(NOT_PREFERRED[i]) >= 0) return "";
    for (var j = 0; j < PREFERRED.length; j++) if (n.indexOf(PREFERRED[j]) >= 0) return PREFERRED[j];
    return "";
  }

  var MINI_WORDS = ["miniature", "sample", " nip", "airline"];
  function isMini(p) {
    var s = ((p.name || "") + " " + (p.sizeStr || "")).toLowerCase();
    for (var i = 0; i < MINI_WORDS.length; i++) if (s.indexOf(MINI_WORDS[i]) >= 0) return true;
    if (/(^|[^a-z])mini([^a-z]|$)/.test(s)) return true;
    if (/(^|[^0-9])(50|100|200)\s?ml/.test(s)) return true;
    return false;
  }
  var RED_KW = ["cabernet", "merlot", "pinot noir", "malbec", "syrah", "shiraz", "zinfandel", "tempranillo", "sangiovese", "grenache", "nebbiolo", "mourvedre", "petit verdot", "carmenere", "gamay", "barbera", "red blend", "chianti", "cotes du rhone", "rioja", "red wine", "bordeaux", "brunello", "barolo", "amarone", "montepulciano"];
  var WHITE_KW = ["sauvignon blanc", "chardonnay", "pinot grigio", "pinot gris", "riesling", "moscato", "muscat", "viognier", "gewurztraminer", "albarino", "chenin blanc", "gruner", "semillon", "torrontes", "white blend", "chablis", "white burgundy", "sancerre", "pouilly", "white wine", "vermentino", "soave", "gavi"];
  var SPARK_KW = ["sparkling", "champagne", "prosecco", "cava", "brut", "franciacorta", "lambrusco", "spumante", "cremant", "nectar imperial"];
  var NON_WINE = ["vermouth", "sake", "port", "sherry", "rose", "rosé"];
  var SPIRIT_KW = { vodka: ["vodka"], rum: ["rum"], bourbon: ["bourbon", "whiskey", "whisky"], gin: ["gin"], tequila: ["tequila"] };
  var ALL_SPIRIT_WORDS = ["vodka", "rum", "bourbon", "whiskey", "whisky", "gin", "tequila", "scotch", "cognac", "brandy", "mezcal", "liqueur"];
  // v2.7: spirit / RTD brands whose product names omit the spirit word ("Ketel One
  // Botanical Cucumber & Mint") — never acceptable in a MIXER slot.
  var MIXER_BLOCK_BRANDS = ["ketel one", "botanical", "smirnoff", "absolut", "tito's", "titos", "grey goose", "belvedere", "bacardi", "captain morgan", "malibu", "jose cuervo", "high noon", "white claw", "truly", "cutwater", "on the rocks", "crown royal", "jack daniel", "jim beam", "hennessy", "patron", "casamigos", "don julio", "baileys", "kahlua", "aperol", "campari", "jagermeister", "fireball", "svedka", "new amsterdam", "pinnacle", "deep eddy", "skyy", "ciroc"];

  function nameHasAny(name, kws) {
    var n = (name || "").toLowerCase();
    for (var i = 0; i < kws.length; i++) if (n.indexOf(kws[i]) >= 0) return true;
    return false;
  }
  function classifyOk(slotType, p) {
    var name = (p.name || "").toLowerCase();
    if (isMini(p)) return false;
    if (slotType === "red") return nameHasAny(name, RED_KW) && !nameHasAny(name, WHITE_KW) && !nameHasAny(name, SPARK_KW) && !nameHasAny(name, NON_WINE) && !nameHasAny(name, ALL_SPIRIT_WORDS) && name.indexOf("beer") < 0;
    if (slotType === "white") return nameHasAny(name, WHITE_KW) && !nameHasAny(name, SPARK_KW) && !nameHasAny(name, NON_WINE) && !nameHasAny(name, ALL_SPIRIT_WORDS);
    if (slotType === "sparkling") return nameHasAny(name, SPARK_KW) && !nameHasAny(name, NON_WINE) && !nameHasAny(name, ALL_SPIRIT_WORDS);
    if (slotType === "beer") return !nameHasAny(name, ALL_SPIRIT_WORDS.concat(RED_KW).concat(WHITE_KW).concat(SPARK_KW)) && !/\b(liqueur|cold brew|coffee|amaro|aperitivo|vermouth|sake|mead|bitters|syrup|mixer|tonic|soda|juice|cider|angry orchard)\b/.test(name); // v2.7: cider is not beer
    if (slotType === "seltzer") return name.indexOf("seltzer") >= 0 || name.indexOf("claw") >= 0 || name.indexOf("truly") >= 0 || name.indexOf("high noon") >= 0;
    if (slotType === "nabeer") return name.indexOf("non alcoholic") >= 0 || name.indexOf("non-alcoholic") >= 0 || name.indexOf("0.0") >= 0 || name.indexOf("athletic") >= 0 || name.indexOf("na beer") >= 0;
    // v2.7: a MIXER slot (juice / soda / tonic / syrup / garnish) must be non-alcoholic —
    // "mint" used to match a Ketel One Botanical vodka.
    if (slotType === "mixer") {
      // v2.7.7: "Ginger Beer", "Ginger Ale", "Root Beer" are non-alcoholic mixers; the beer/ale
      // blocklist below used to reject them, so they were always reported "unavailable".
      // v2.7.8: the spirit filter is a substring match and "gin" sits inside "ginger", so every
      // ginger product was rejected as gin. Neutralise both before the checks below.
      name = name.replace(/\b(ginger|root|birch)\s+(beer|ale)\b/g, "$1 soda").replace(/ginger/g, "zinger");
    }
    if (slotType === "mixer") return !nameHasAny(name, ALL_SPIRIT_WORDS.concat(RED_KW).concat(WHITE_KW).concat(SPARK_KW).concat(MIXER_BLOCK_BRANDS)) && !/\b(beer|lager|ale|ipa|stout|seltzer|hard|wine|vermouth|sake|amaro|aperitivo|triple sec|schnapps|cordial|proof|abv|rtd|ready to drink|spritz|kombucha|probiotic|energy)\b/.test(name);
    // v2.7: cocktail BASE / SECONDARY slots (a spirit or liqueur) — anything full-size
    // that isn't a mixer, a beer or a wine.
    if (slotType === "cbase") return !/\b(beer|lager|ale|ipa|stout|seltzer|soda|tonic|juice|syrup|mixer|hard tea|hard lemonade)\b/.test(name) && !nameHasAny(name, RED_KW.concat(WHITE_KW).concat(SPARK_KW));
    if (SPIRIT_KW[slotType]) {
      // v2.7.21: whole words — "gin" sits inside "Disaronno Originale Amaretto" (Rachel's gin slot took it, Oct 21).
      var hasW = function (n, ws) { return ws.some(function (w) { return new RegExp("\\b" + w + "\\b").test(n); }); };
      if (!hasW(name, SPIRIT_KW[slotType])) return false;
      for (var t in SPIRIT_KW) {
        if (t === slotType) continue;
        var own = SPIRIT_KW[slotType];
        for (var k = 0; k < SPIRIT_KW[t].length; k++) {
          var w = SPIRIT_KW[t][k];
          if (own.indexOf(w) >= 0) continue;
          if (hasW(name, [w])) return false;
        }
      }
      return true;
    }
    return true;
  }

  // Actual number of drink-containers in a beer/seltzer pack (a can/bottle = 1
  // drink). Reads, in order of reliability: the API "NxM" size string
  // ("12x12 Oz Bottle" -> 12), an explicit pack count in the name ("12 Pack"),
  // then the URL slug ("...-12pk-12oz-can" -> 12; "...-8pk-..." -> 8) which is the
  // only place variety-pack counts like High Noon / Surfside are exposed. Falls
  // back to the model's assumed pack size only when none of those are present.
  function beerPackCount(name, sizeStr, url, fallback) {
    var s = ((sizeStr || "") + " " + (name || "")).toLowerCase();
    var m = s.match(/(\d+)\s*x\s*\d+/);            // NxM -> N containers
    if (m) return parseInt(m[1]) || fallback;
    m = s.match(/(\d+)\s*[- ]?\s*(?:pk|pack)\b/);   // "12 pack", "24pk"
    if (m) return parseInt(m[1]) || fallback;
    var u = String(url || "").toLowerCase();
    m = u.match(/(\d+)\s*pk\b/);                    // slug "...-12pk-12oz-can"
    if (m) return parseInt(m[1]) || fallback;
    m = u.match(/(\d+)\s*x\s*\d+/);                 // slug "...-24x12oz-..."
    if (m) return parseInt(m[1]) || fallback;
    return fallback;
  }

  // v2.7.6: total volume (ml) of one unit of a mixer product, parsed from its size
  // string / name ("1L", "503 ML", "12 OZ", "4X 12 OZ", "1 GAL", "20LB"). 0 = unknown.
  function mixerUnitMl(name, sizeStr) {
    var s = ((sizeStr || "") + " " + (name || "")).toLowerCase();
    var mult = 1, m = s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(oz|ml|l|ltr|liter|litre)\b/);
    var amt = 0, unit = "";
    if (m) { mult = parseInt(m[1]) || 1; amt = parseFloat(m[2]); unit = m[3]; }
    else {
      m = s.match(/(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz|ml|liters?|litres?|ltr|l|gal|gallon|lb|lbs)\b/);
      if (!m) return 0;
      amt = parseFloat(m[1]); unit = m[2].replace(/\s|\./g, "");
    }
    var f = 0;
    if (unit === "oz" || unit === "floz") f = 29.57;
    else if (unit === "ml") f = 1;
    else if (/^(l|ltr|liter|liters|litre|litres)$/.test(unit)) f = 1000;
    else if (unit === "gal" || unit === "gallon") f = 3785;
    else if (unit === "lb" || unit === "lbs") f = 453;
    return Math.round(mult * amt * f);
  }
  // v2.7.6: ml of a mixer used per drink. Flavourings (lime juice, grenadine, syrup...) ~20ml;
  // everything else (soda, ginger beer, lemonade, juice, tonic) ~120ml.
  function mixerMlPerDrink(term) {
    return /\b(lime|lemon juice|grenadine|syrup|bitters|mint|agave|honey|puree|cordial|vanilla|elderflower|ginger syrup)\b/.test(String(term || "").toLowerCase()) ? 20 : 120;
  }

  // v2.7.13: a generic "Tequila" search never surfaces Mi Campo (it is outside the 100-row
  // slice), so every tequila search also pulls Mi Campo by name. Mi Campo ranks first in pick()
  // and is never tiered up. Works for every path (standard, cocktail, CUSTOM, quote).
  var miCampoCache = null;
  async function search(term, minP, maxP) {
    var rows = await searchRaw(term, minP, maxP);
    if (!/tequila/i.test(String(term || "")) || /mi[ -]campo/i.test(String(term || ""))) return rows;
    if (miCampoCache === null) {
      var mc = await searchRaw("Mi Campo", 0, 999999);
      miCampoCache = mc.filter(function (p) { return /mi[ -]campo/i.test(p.name) && /tequila/i.test(p.name); });
    }
    var have = {};
    for (var i = 0; i < rows.length; i++) have[rows[i].name.toLowerCase()] = 1;
    for (var j = 0; j < miCampoCache.length; j++) if (!have[miCampoCache[j].name.toLowerCase()] && miCampoCache[j].price >= (minP > 0 ? 0 : 0)) rows.push(miCampoCache[j]);
    return rows;
  }

  async function searchRaw(term, minP, maxP) {
    var sMin = (minP > 0) ? minP : 0.01;
    var sMax = (maxP > 0) ? maxP : 999999;
    var locParam = loc.zipcode ? ("&zipcode=" + encodeURIComponent(loc.zipcode)) : ("&location=" + encodeURIComponent(loc.location));
    var url = "https://api.getbevvi.com/api/corpproducts/searchCorpProducts?searchBy=" + encodeURIComponent(term) + "&limit=100&client=" + encodeURIComponent(clientName) + "&min=" + encodeURIComponent(sMin) + "&max=" + encodeURIComponent(sMax) + locParam;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var res = await fetch(url);
        if (!res.ok) continue;
        var data = res.json;
        if (!Array.isArray(data)) continue;
        return data.map(function (p) {
          var price = p.salePrice || p.price || 0;
          var sizeStr = p.size && p.units ? String(p.size) + String(p.units) : "";
          var url2 = p.url ? p.url : (p.slug ? "https://airculinaire.getbevvi.com/productdetail/" + p.slug : "");
          var pid = (p.corpProductFilter && p.corpProductFilter.corpProductId) || p.id || "";
          return { name: p.name || "", price: parseFloat(price) || 0, sizeStr: sizeStr, url: url2, product_id: pid };
        }).filter(function (p) { return p.price > 0 && p.name; });
      } catch (e) { /* transient -> retry once */ }
    }
    return [];
  }

  function pick(cands, slotType, targetPrice, minP, maxP, totalQty, maxUnique) {
    // v2.7.14: Mi Campo (rank 3) is exempt from the derived price floor — only a customer-stated
    // spirit minimum (capSpiritMin) can exclude it — and mixers may not be soft drinks unless asked
    // ("Sugar" matched Coca-Cola Zero Sugar).
    var pool = cands.filter(function (p) {
      if (!classifyOk(slotType, p)) return false;
      if (slotType === "mixer" && /\b(coca[- ]?cola|coke|pepsi|sprite|dr\.? ?pepper|mountain dew|fanta|diet|zero sugar)\b/i.test(p.name) && !/cola|coke|pepsi|sprite|pepper|dew|fanta|diet/.test(curMixerTerm)) return false;
      // v2.7.15: food is never a mixer ("Mint" returned Oreo Mint cookies)
      if (slotType === "mixer" && /\b(cookies?|oreo|cracker|crackers|chips?|candy|chocolate|cake|brownie|granola|gum|pretzels?|popcorn|ice cream|snack|jerky|nuts)\b/i.test(p.name)) return false;
      if (p.price > (maxP || 999999)) return false;
      if (p.price >= (minP || 0)) return true;
      return brandRank(p.name) === 3 && !(capSpiritMin > 0);
    });
    if (pool.length === 0) return [];
    // v2.7: cap the target at 2x the median in-stock price for this slot, so the
    // stepped floor is anchored to what the store actually carries, not to
    // budget / bottle_count (which is how a $4,000 build landed on $330 Weller).
    var effTarget = targetPrice || 0;
    if (effTarget > 0 && pool.length >= 3) {
      var prices = pool.map(function (p) { return p.price; }).sort(function (a, b) { return a - b; });
      var median = prices[Math.floor(prices.length / 2)];
      if (median > 0 && effTarget > median * 2) effTarget = median * 2;
    }
    // v2.7.12: with no customer price cap, never take a bottle priced above 2.5x the target
    // (a $2,356 Clase Azul was chosen as "the priciest tequila under no ceiling").
    if (effTarget > 0 && !(maxP > 0 && maxP < 999999)) {
      var sane = pool.filter(function (p) { return p.price <= effTarget * 2.5 || brandRank(p.name) === 3; });
      if (sane.length > 0) pool = sane;
    }
    // v2.7.12: a mixer must actually be what was asked for ("Club Soda" must not return Coca-Cola).
    if (slotType === "mixer" && curMixerTerm) {
      var GENERIC = { juice: 1, soda: 1, syrup: 1, mixer: 1, water: 1, the: 1 };
      var toks = curMixerTerm.split(/[^a-z]+/).filter(function (w) { return w.length >= 3 && !GENERIC[w]; });
      if (toks.length > 0) {
        var onTerm = pool.filter(function (p) { var nm = (p.name || "").toLowerCase(); return toks.every(function (w) { return nm.indexOf(w) >= 0; }); });
        if (onTerm.length > 0) pool = onTerm;
      }
    }
    // v2.7.15: "Soda Water" / "Club Soda" must be plain soda water, never tonic ("Soda Water" returned Canada Dry Tonic)
    if (slotType === "mixer" && /(club soda|soda water|sparkling water|seltzer)/.test(curMixerTerm) && !/tonic/.test(curMixerTerm)) {
      var plainSoda = pool.filter(function (p) { return /(club soda|soda water|sparkling water|seltzer water|perrier|pellegrino|topo chico)/i.test(p.name) && !/tonic/i.test(p.name); });
      if (plainSoda.length > 0) pool = plainSoda; else { var noTonic = pool.filter(function (p) { return !/tonic/i.test(p.name); }); if (noTonic.length > 0) pool = noTonic; }
    }
    var steps = [0.50, 0.35, 0.20, 0];
    var chosenPool = null;
    for (var s = 0; s < steps.length; s++) {
      var floor = Math.max(minP || 0, effTarget * steps[s]);
      var sub = pool.filter(function (p) { return p.price >= floor; });
      if (sub.length > 0) { chosenPool = sub; break; }
    }
    if (!chosenPool) chosenPool = pool;
    // v2.7.10: Mi Campo (rank 3) stays in the pool even when it is cheaper than the stepped
    // price floor, so it is always offered first for tequila slots.
    for (var mc = 0; mc < pool.length; mc++) if (brandRank(pool[mc].name) === 3 && chosenPool.indexOf(pool[mc]) < 0) chosenPool.push(pool[mc]);
    chosenPool.sort(function (a, b) {
      var pa = brandRank(a.name), pb = brandRank(b.name); // v2.7: preferred > neutral > avoid-list
      if (pa !== pb) return pb - pa;
      if (slotType === "mixer") {
        var fpa = mixerFlavorPenalty(a.name), fpb = mixerFlavorPenalty(b.name);
        if (fpa !== fpb) return fpa - fpb; // v2.7.11: plain before flavoured
        // v2.7.9: mixers are bought for volume, not prestige — take the best price per ml
        // (products with an unparseable size sort after those with a known one).
        var va = mixerUnitMl(a.name, a.sizeStr), vb = mixerUnitMl(b.name, b.sizeStr);
        var ppa = va > 0 ? a.price / va : 1e9, ppb = vb > 0 ? b.price / vb : 1e9;
        if (ppa !== ppb) return ppa - ppb;
      }
      return b.price - a.price;
    });
    var seen = {};
    var uniq = [];
    for (var i = 0; i < chosenPool.length && uniq.length < (maxUnique || 2); i++) {
      var key = chosenPool[i].name.toLowerCase();
      if (!seen[key]) { seen[key] = 1; uniq.push(chosenPool[i]); }
    }
    var out = [];
    var remaining = totalQty;
    for (var j = 0; j < uniq.length; j++) {
      var share = (j === uniq.length - 1) ? remaining : Math.ceil(totalQty / uniq.length);
      if (share > remaining) share = remaining;
      if (share <= 0) break;
      out.push({ product: uniq[j], qty: share });
      remaining -= share;
    }
    return out;
  }

  var lineItems = [];
  // v2.7: per-line metadata for the spend-up pass, index-parallel to lineItems
  // (kept OUT of lineItems so it never leaks into the line_items JSON).
  //   pool    — in-class candidates for this slot (for tier-up swaps), may be []
  //   ceil    — max unit price pass 1 may tier up to (0 = no tier-up)
  //   baseQty — quantity the drinks math asked for (coverage denominator)
  //   qtyCap  — hard quantity ceiling for pass 2 (0 = none)
  var lineMeta = [];
  var unavailable = [];
  var summaryBits = [];
  var totalDrinks = 0;

  // v2.7: distinct, in-class, full-size candidates for a slot, cheapest first.
  function tierPool(cands, slotType, ceilP) {
    var seen = {}, out = [];
    var arr = (cands || []).filter(function (p) { return classifyOk(slotType, p) && p.price <= (ceilP || 999999); });
    arr.sort(function (a, b) { return a.price - b.price; });
    for (var i = 0; i < arr.length; i++) { var k = arr[i].name.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(arr[i]); } }
    return out;
  }

  function addLines(picks, label, category, meta) {
    if (picks.length === 0) { unavailable.push(label); return; }
    for (var i = 0; i < picks.length; i++) {
      lineItems.push({
        label: label, name: picks[i].product.name, qty: picks[i].qty,
        price: picks[i].product.price, size: picks[i].product.sizeStr,
        url: picks[i].product.url, product_id: picks[i].product.product_id, category: category, tier: "base"
      });
      lineMeta.push({ pool: (meta && meta.pool) || [], ceil: (meta && meta.ceil) || 0, baseQty: picks[i].qty, qtyCap: (meta && meta.qtyCap) || 0, term: (meta && meta.term) || "", slot: (meta && meta.slot) || "" });
    }
  }

  if (isCustom) {
    // ================= CUSTOM MODE =================
    var byCat = { wine: [], beer: [], spirits: [] };
    for (var i = 0; i < namedProducts.length; i++) {
      var cat = (namedProducts[i].category || "").toLowerCase();
      if (byCat[cat]) byCat[cat].push(namedProducts[i]);
      else return fail("Unknown category in named_products: " + namedProducts[i].name);
    }
    var cmult = 1.0;
    if (byCat.wine.length > 0 && byCat.beer.length === 0 && byCat.spirits.length === 0) cmult = 0.80;
    else if (byCat.wine.length > 0 && byCat.spirits.length > 0 && byCat.beer.length === 0) cmult = 0.90;
    totalDrinks = drinksPerPerson > 0 ? Math.round(guests * drinksPerPerson) : Math.round(guests * baseDpp * cmult);
    var repCats = (byCat.wine.length ? 1 : 0) + (byCat.beer.length ? 1 : 0) + (byCat.spirits.length ? 1 : 0);
    var drinksPerCat = repCats ? totalDrinks / repCats : 0;

    // v2.0: a named brand that returns nothing is retried with common spelling
    // variants (Light<->Lite, and de-spaced e.g. "Surf Side"->"Surfside") before we
    // give up on it, so the customer's actual brand isn't dropped over a spelling gap.
    async function searchNamed(name) {
      var r = await search(name);
      if (r.length) return r;
      var lo = String(name).toLowerCase();
      var variants = [];
      if (lo.indexOf("light") >= 0) variants.push(name.replace(/light/ig, "Lite"));
      if (lo.indexOf("lite") >= 0) variants.push(name.replace(/lite/ig, "Light"));
      if (/\s/.test(name)) variants.push(name.replace(/\s+/g, ""));
      for (var v = 0; v < variants.length; v++) {
        var rr = await search(variants[v]);
        if (rr.length) return rr;
      }
      return r;
    }
    // v2.4: generic category words passed as "named products" ("Wine", "Beer",
    // "Hard Seltzer") are NOT brands — resolve them as real CATEGORIES (wine gets a
    // red/white split; everything goes through the category classifier) instead of
    // a single fuzzy name-match. A fuzzy match on "Wine" is how a BOURBON ("...Wine
    // Cask Bourbon") ended up as the wine line.
    function genericKind(name) {
      var g = String(name || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
      if (/^(wines?|red and white wines?|red white wines?|red or white wines?)$/.test(g)) return "wine";
      if (/^(red wines?|reds?)$/.test(g)) return "red";
      if (/^(white wines?|whites?)$/.test(g)) return "white";
      if (/^(sparkling wines?|sparkling|champagnes?|bubbles|bubbly)$/.test(g)) return "sparkling";
      if (/^(beers?|lagers?|domestic beers?|imported beers?|light beers?)$/.test(g)) return "beer";
      if (/^(hard seltzers?|seltzers?)$/.test(g)) return "seltzer";
      if (/^(non ?alcoholic beers?|na beers?|n a beers?|nonalcoholic beers?)$/.test(g)) return "nabeer";
      return null;
    }
    // v2.4: CATEGORY GUARD — a product may only fill a slot whose category it actually
    // belongs to. Stops a spirit from filling a wine slot and vice-versa.
    function catCompatible(catN, p) {
      var nm = (p.name || "").toLowerCase();
      var isWineish = nameHasAny(nm, RED_KW.concat(WHITE_KW).concat(SPARK_KW)) || /\bwine\b/.test(nm);
      var isBeerish = /\b(beer|lager|ale|ipa|stout|pilsner|seltzer|hard tea|hard lemonade)\b/.test(nm);
      var isSpiritBottle = nameHasAny(nm, ALL_SPIRIT_WORDS) && !/\b(seltzer|cocktail|ready to drink|rtd|hard tea|hard lemonade)\b/.test(nm);
      if (catN === "wine") return !isSpiritBottle && !isBeerish;
      if (catN === "spirits") return !isWineish && !isBeerish;
      if (catN === "beer") return !isWineish && !isSpiritBottle;
      return true;
    }

    // Split the named list into real brand names vs generic category words.
    var brandEntries = [], genericEntries = [];
    for (var gi = 0; gi < namedProducts.length; gi++) {
      var gk0 = genericKind(namedProducts[gi].name);
      if (gk0) genericEntries.push({ np: namedProducts[gi], kind: gk0 });
      else brandEntries.push(namedProducts[gi]);
    }
    var results = await Promise.all(brandEntries.map(function (np) { return searchNamed(np.name); }));

    // PASS 1a — brand names: resolve each to its best in-stock match (or mark unavailable).
    var chosen = []; // { np, catN, best }
    for (var n = 0; n < brandEntries.length; n++) {
      var np = brandEntries[n];
      var catN = (np.category || "").toLowerCase();
      var found = results[n].filter(function (p) { return !isMini(p) && catCompatible(catN, p); });
      if (found.length === 0) { unavailable.push(np.name); continue; }
      // PER-CATEGORY PRICE CAPS APPLY IN CUSTOM MODE TOO
      var capMin = 0, capMax = 0;
      if (catN === "wine") { capMin = capWineMin; capMax = capWineMax; }
      else if (catN === "beer") { capMin = capBeerMin; capMax = capBeerMax; }
      else if (catN === "spirits") { capMin = capSpiritMin; capMax = capSpiritMax; }
      if (capMin || capMax) {
        var inRange = found.filter(function (p) { return p.price >= (capMin || 0) && p.price <= (capMax || 999999); });
        if (inRange.length > 0) {
          found = inRange;
        } else {
          unavailable.push(np.name + " (none within $" + (capMin || 0) + "-$" + (capMax || "any") + ")");
          continue;
        }
      }
      // best match: name token overlap, then preferred brand, then price desc
      var terms = np.name.toLowerCase().split(/\s+/);
      found.sort(function (a, b) {
        function score(x) { var s = 0; var ln = x.name.toLowerCase(); for (var t = 0; t < terms.length; t++) if (ln.indexOf(terms[t]) >= 0) s++; return s; }
        var d = score(b) - score(a); if (d) return d;
        var pa = brandStatus(a.name) === "preferred" ? 1 : 0;
        var pb2 = brandStatus(b.name) === "preferred" ? 1 : 0;
        if (pa !== pb2) return pb2 - pa;
        return b.price - a.price;
      });
      chosen.push({ np: np, catN: catN, best: found[0] });
    }

    // PASS 1b — generic category slots → real category picks (2 products each, wine
    // split red/white), with a per-unit price target derived from that family's share
    // of the budget so a 10% wine line doesn't buy the most expensive bottle in stock.
    if (genericEntries.length > 0) {
      var reqW = false, reqB = false, reqS = false, reqSp = false;
      for (var ri = 0; ri < namedProducts.length; ri++) {
        var rnp = namedProducts[ri]; var rk = genericKind(rnp.name);
        var rc = (rnp.category || "").toLowerCase(); var rsc = String(rnp.subcategory || "").toLowerCase();
        if (rk === "wine" || rk === "red" || rk === "white" || rk === "sparkling") reqW = true;
        else if (rk === "seltzer") reqS = true;
        else if (rk === "beer" || rk === "nabeer") reqB = true;
        else if (rc === "wine") reqW = true;
        else if (rc === "spirits") reqSp = true;
        else if (rc === "beer") { if (rsc.indexOf("seltzer") >= 0) reqS = true; else reqB = true; }
      }
      var fW, fB, fS;
      if (hasPct) {
        var qW = reqW ? winePct : 0, qB = reqB ? beerPct : 0, qS = reqS ? seltzerPct : 0, qSp = reqSp ? spiritPct : 0;
        var qSum = (qW + qB + qS + qSp) || 1;
        fW = qW / qSum; fB = qB / qSum; fS = qS / qSum;
      } else {
        var nFam = ((reqW ? 1 : 0) + ((reqB || reqS) ? 1 : 0) + (reqSp ? 1 : 0)) || 1;
        fW = reqW ? 1 / nFam : 0;
        var fBF = (reqB || reqS) ? 1 / nFam : 0;
        var nBF = ((reqB ? 1 : 0) + (reqS ? 1 : 0)) || 1;
        fB = reqB ? fBF / nBF : 0; fS = reqS ? fBF / nBF : 0;
      }
      var TERM = { red: "Red Wine", white: "White Wine", sparkling: "Sparkling Wine", beer: "Beer", seltzer: "Hard Seltzer", nabeer: "Non Alcoholic Beer" };
      var LABEL = { red: "Red Wine", white: "White Wine", sparkling: "Sparkling Wine", beer: "Beer", seltzer: "Hard Seltzer", nabeer: "Non-Alcoholic Beer" };
      var gSubs = [];
      for (var ge = 0; ge < genericEntries.length; ge++) {
        var kind = genericEntries[ge].kind;
        var subs = kind === "wine" ? ["red", "white"] : [kind];
        for (var si = 0; si < subs.length; si++) {
          var sk = subs[si];
          var isWineSub = (sk === "red" || sk === "white" || sk === "sparkling");
          var frac = isWineSub ? (fW / subs.length) : (sk === "seltzer" ? fS : fB);
          var drinks = totalDrinks * frac;
          var bud = isQuoteMode ? 0 : productBudget * frac;
          var units = isWineSub ? Math.max(1, Math.ceil(drinks / 5)) : Math.max(1, Math.ceil(drinks / beerPackSize));
          var tgt = bud > 0 ? bud / units : 0;
          var rawTgt = tgt;
          if (isWineSub && tgt > WINE_TARGET_CAP) tgt = WINE_TARGET_CAP; // v2.7 floor cap
          if (isWineSub && capWineMin > 0 && !isQuoteMode) tgt = Math.max(tgt, capWineMin * 1.4); // v2.7 min cap lifts target
          var cMin, cMax;
          if (isWineSub) { cMin = capWineMin || (tgt ? tgt * 0.6 : 0); cMax = capWineMax || (tgt ? Math.max(tgt * 1.4, capWineMin * 1.6) : 999999); }
          else { cMin = capBeerMin || (tgt > 80 ? 0 : (tgt ? tgt * 0.6 : 0)); cMax = capBeerMax || (tgt > 80 ? 999999 : (tgt ? tgt * 1.4 : 999999)); }
          if (quoteDefaults) { if (isWineSub) { tgt = QD.wineT; cMin = QD.wineMin; cMax = QD.wineMax; } else { cMin = 0; cMax = 999999; } }
          gSubs.push({ term: TERM[sk], slot: sk, catN: isWineSub ? "wine" : "beer", label: LABEL[sk], subcat: sk, target: tgt, min: cMin, max: cMax, hardCap: isWineSub ? !!(capWineMax || capWineMin) : !!(capBeerMax || capBeerMin), ceil: isWineSub ? (isQuoteMode ? TIER_CEIL.wine : scaledCeil(TIER_CEIL.wine, rawTgt)) : TIER_CEIL.beer });
        }
      }
      // v2.7: generic WINE slots with a price target search server-side in
      // [0.35 x target, wine ceiling] (the API returns only 100 rows and the wide
      // slice is all cheap bottles); wide search as a fallback if that is empty.
      function gBanded(gs) { return (!isQuoteMode && gs.catN === "wine" && gs.target > 0 && !gs.hardCap) ? { min: Math.max(0.01, Math.round(gs.target * 0.35 * 100) / 100), max: gs.ceil } : null; }
      var gRes = await Promise.all(gSubs.map(function (gs) {
        if (gs.hardCap) return search(gs.term, gs.min, gs.max);
        var gb = gBanded(gs);
        return gb ? search(gs.term, gb.min, gb.max) : search(gs.term, 0, 999999);
      }));
      for (var gj = 0; gj < gSubs.length; gj++) {
        var gs = gSubs[gj];
        var gp = pick(gRes[gj], gs.slot, gs.target, gs.min, gs.max, 2, 2);
        if (gp.length === 0 && !gs.hardCap) gp = pick(gRes[gj], gs.slot, 0, 0, 999999, 2, 2);
        if (gp.length === 0 && gBanded(gs)) {
          gRes[gj] = await search(gs.term, 0, 999999);
          gp = pick(gRes[gj], gs.slot, gs.target, gs.min, gs.max, 2, 2);
          if (gp.length === 0) gp = pick(gRes[gj], gs.slot, 0, 0, 999999, 2, 2);
        }
        if (gp.length === 0) { unavailable.push(gs.label); continue; }
        // v2.7: generic slots may be tiered up by the spend-up pass (named brands may not).
        var gCeil = gs.hardCap ? gs.max : (gs.ceil || TIER_CEIL[gs.catN] || 0);
        var gPool = tierPool(gRes[gj], gs.slot, gCeil);
        for (var gq = 0; gq < gp.length; gq++) {
          chosen.push({ np: { name: gs.label, category: gs.catN, subcategory: gs.subcat }, catN: gs.catN, best: gp[gq].product, pool: gPool, ceil: gCeil, term: gs.term, slot: gs.slot });
        }
      }
    }

    // Count AVAILABLE products per category so an unavailable item's share is
    // redistributed across the ones that were actually found (not lost).
    var availByCat = { wine: 0, beer: 0, spirits: 0 };
    for (var ci = 0; ci < chosen.length; ci++) availByCat[chosen[ci].catN]++;

    // v2.0: wine splits EVENLY by sub-type (red / white / sparkling|rosé)
    // INDEPENDENT of how many brands per side survived the price cap. Each present
    // sub-bucket gets an equal share of the wine drinks, then that share is divided
    // among its available brands — so if one white brand drops out, white still
    // gets its full half instead of the mix skewing toward red.
    function wineSubOf(np, best) {
      var sc = String((np && np.subcategory) || "").toLowerCase();
      if (sc.indexOf("red") >= 0) return "red";
      if (sc.indexOf("white") >= 0) return "white";
      if (sc.indexOf("spark") >= 0 || sc.indexOf("ros") >= 0 || sc.indexOf("champagne") >= 0) return "other";
      var nm = (best && best.name || "").toLowerCase();
      if (nameHasAny(nm, RED_KW)) return "red";
      if (nameHasAny(nm, WHITE_KW)) return "white";
      if (nameHasAny(nm, SPARK_KW)) return "other";
      return "red";
    }
    // Classify each chosen item into an allocation bucket. Within the "beer"
    // category we split beer vs. hard seltzer (vs. NA beer) so a stated seltzer
    // percentage can be honored separately from beer.
    function famOf(ch) {
      if (ch.catN !== "beer") return ch.catN; // wine / spirits
      var sc = String((ch.np && ch.np.subcategory) || "").toLowerCase();
      if (sc.indexOf("seltzer") >= 0) return "seltzer";
      if (sc.indexOf("na") >= 0 && sc.indexOf("beer") >= 0) return "nabeer";
      if (sc.indexOf("non") >= 0) return "nabeer";
      if (classifyOk("seltzer", ch.best)) return "seltzer";
      return "beer";
    }
    var availWineSub = { red: 0, white: 0, other: 0 };
    var availFam = { beer: 0, seltzer: 0, nabeer: 0, spirits: 0 };
    for (var wi = 0; wi < chosen.length; wi++) {
      var cw = chosen[wi];
      if (cw.catN === "wine") {
        cw.wsub = wineSubOf(cw.np, cw.best);
        availWineSub[cw.wsub]++;
      } else {
        cw.fam = famOf(cw);
        availFam[cw.fam] = (availFam[cw.fam] || 0) + 1;
      }
    }
    var availWineTotal = availWineSub.red + availWineSub.white + availWineSub.other;
    var wineSubsPresent = (availWineSub.red > 0 ? 1 : 0) + (availWineSub.white > 0 ? 1 : 0) + (availWineSub.other > 0 ? 1 : 0);

    // Category drink pools. hasPct -> use the stated percentages, renormalized over
    // only the categories that have available products (so the total-drink target is
    // preserved even when a requested category has nothing in range). Otherwise keep
    // the default even split (beer + seltzer share one bucket, as before).
    var poolWine, poolBeer, poolSeltzer, poolNabeer, poolSpirits, poolBeerFam;
    if (hasPct) {
      var pW = availWineTotal > 0 ? winePct : 0;
      var pB = availFam.beer > 0 ? beerPct : 0;
      var pS = availFam.seltzer > 0 ? seltzerPct : 0;
      var pSp = availFam.spirits > 0 ? spiritPct : 0;
      var pSum = pW + pB + pS + pSp;
      if (pSum <= 0) { pW = availWineTotal; pB = availFam.beer; pS = availFam.seltzer; pSp = availFam.spirits; pSum = pW + pB + pS + pSp || 1; }
      poolWine = totalDrinks * pW / pSum;
      poolBeer = totalDrinks * pB / pSum;
      poolSeltzer = totalDrinks * pS / pSum;
      poolNabeer = 0; // NA beer folds into beer share when percentages are used
      poolSpirits = totalDrinks * pSp / pSum;
      poolBeerFam = null;
    } else {
      poolWine = availWineTotal > 0 ? drinksPerCat : 0;
      poolBeerFam = availByCat.beer > 0 ? drinksPerCat : 0; // beer + seltzer combined
      poolSpirits = availByCat.spirits > 0 ? drinksPerCat : 0;
      poolBeer = poolSeltzer = poolNabeer = null;
    }
    var wineSubDrinks = wineSubsPresent ? poolWine / wineSubsPresent : poolWine;
    var availBeerFam = Math.max(1, availByCat.beer);

    // PASS 2 — size quantities off the ACTUAL pack the product ships in.
    for (var cj = 0; cj < chosen.length; cj++) {
      var ch = chosen[cj];
      var perProd, dpu, cap;
      if (ch.catN === "wine") {
        dpu = 5;
        var subN = Math.max(1, availWineSub[ch.wsub]);
        perProd = wineSubDrinks / subN;
        cap = Math.max(1, Math.ceil((guests * hoursEff * 0.6) / subN));
      } else if (ch.catN === "spirits") {
        dpu = 16;
        perProd = poolSpirits / Math.max(1, availFam.spirits);
        cap = Math.max(1, Math.ceil(((guests / 10 + 1) * Math.max(1, hoursEff / 3)) / Math.max(1, availFam.spirits))); // v2.4: hours-aware
      } else {
        // beer / seltzer / NA beer
        dpu = beerPackCount(ch.best.name, ch.best.sizeStr, ch.best.url, parseInt(ch.np.pack_size) || beerPackSize);
        if (hasPct) {
          var famPool = ch.fam === "seltzer" ? poolSeltzer : (ch.fam === "nabeer" ? poolNabeer : poolBeer);
          perProd = famPool / Math.max(1, availFam[ch.fam]);
        } else {
          perProd = poolBeerFam / availBeerFam; // beer + seltzer share the bucket
        }
        cap = Math.max(1, Math.ceil((guests * hoursEff * 0.5) / availBeerFam));
      }
      var qty = Math.max(1, Math.ceil(perProd / dpu));
      if (qty > cap) qty = cap;
      lineItems.push({ label: ch.np.name, name: ch.best.name, qty: qty, price: ch.best.price, size: ch.best.sizeStr, url: ch.best.url, product_id: ch.best.product_id, category: ch.catN, tier: "base" });
      lineMeta.push({ pool: ch.pool || [], ceil: ch.ceil || 0, baseQty: qty, qtyCap: cap, term: ch.term || "", slot: ch.slot || "" });
    }
    summaryBits.push("CUSTOM | " + guests + " guests | " + (drinksPerPerson > 0 ? (drinksPerPerson + " drinks/person") : (hours + "h")) + " | " + (hasPct ? ("mix W" + winePct + "/B" + beerPct + "/S" + seltzerPct + (spiritPct ? "/Sp" + spiritPct : "")) : "even split") + " | " + (isQuoteMode ? "QUOTE" : "$" + totalBudget));
    } else {
    // ================= STANDARD MODE (1-7) =================
    var dpp2 = baseDpp * mult;
    totalDrinks = drinksPerPerson > 0 ? Math.round(guests * drinksPerPerson) : Math.round(guests * dpp2);
    var splits = {
      1: { spirits: 1.00, wine: 0.00, beer: 0.00 }, 2: { spirits: 0.00, wine: 0.00, beer: 1.00 },
      3: { spirits: 0.00, wine: 1.00, beer: 0.00 }, 4: { spirits: 0.00, wine: 0.50, beer: 0.50 },
      5: { spirits: 0.40, wine: 0.30, beer: 0.30 }, 6: { spirits: 0.40, wine: 0.60, beer: 0.00 },
      7: { spirits: 0.40, wine: 0.00, beer: 0.60 }
    };
    var split = splits[packageType] || splits[5];
    // v2.1: percentage override for standard packages — when the customer states a
    // category drink-mix, reallocate this package's split to match, renormalized over
    // the categories THIS package actually includes. Beer and hard seltzer share the
    // beer category here, so the beer category share = beer% + seltzer%; the split
    // BETWEEN them is applied inside the beer-family block below.
    if (hasPct) {
      var oW = split.wine > 0 ? winePct : 0;
      var oSp = split.spirits > 0 ? spiritPct : 0;
      var oB = split.beer > 0 ? (beerPct + seltzerPct) : 0;
      // v2.7.17: a PARTIAL mix ("50% spirits") must not drop the other categories this package
      // includes — the unstated remainder is shared equally among them.
      var oStated = oW + oSp + oB, oZero = (split.wine > 0 && oW <= 0 ? 1 : 0) + (split.spirits > 0 && oSp <= 0 ? 1 : 0) + (split.beer > 0 && oB <= 0 ? 1 : 0);
      if (oZero > 0 && oStated > 0 && oStated < 100) {
        var oRest = (100 - oStated) / oZero;
        if (split.wine > 0 && oW <= 0) oW = oRest;
        if (split.spirits > 0 && oSp <= 0) oSp = oRest;
        if (split.beer > 0 && oB <= 0) oB = oRest;
      }
      var oSum = oW + oSp + oB;
      if (oSum > 0) split = { wine: oW / oSum, spirits: oSp / oSum, beer: oB / oSum };
    } else {
      // v2.7.17: mix_bias — "beer>wine" (more beer than wine), "spirits" (more liquor), etc.
      var mb = String(iv.mix_bias || "").toLowerCase().replace(/\s+/g, "");
      if (mb) {
        var wts = { wine: 1, beer: 1, spirits: 1 };
        var mbp = mb.split(">");
        if (mbp.length === 2 && wts[mbp[0]] !== undefined && wts[mbp[1]] !== undefined) { wts[mbp[0]] = 1.6; wts[mbp[1]] = 0.5; }
        else if (wts[mbp[0]] !== undefined) { for (var wk in wts) wts[wk] = (wk === mbp[0]) ? 1.8 : 0.7; }
        var nW = split.wine * wts.wine, nB = split.beer * wts.beer, nS = split.spirits * wts.spirits, nT = nW + nB + nS;
        if (nT > 0) split = { wine: nW / nT, beer: nB / nT, spirits: nS / nT };
      }
    }
    var spiritTypes = ["vodka", "rum", "bourbon", "gin", "tequila"];
    var spiritDrinks = Math.round(totalDrinks * split.spirits);
    var wineDrinks = Math.round(totalDrinks * split.wine);
    var beerDrinks = Math.round(totalDrinks * split.beer);
    var rawSB = split.spirits > 0 ? Math.ceil(spiritDrinks / 16) : 0;
    // v2.7.18: the 5-bottle floor (one of every type) only applies to bigger events. Small events
    // (<60 target drinks) get fewer spirit TYPES so quantity stays near the real drink target; the
    // leftover budget then goes into higher-priced bottles (spiritTarget = budget / bottles).
    var spiritFloor = totalDrinks >= 100 ? 5 : (totalDrinks >= 60 ? 4 : 3);
    var spiritBottles = split.spirits > 0 ? Math.max(rawSB, spiritFloor) : 0;
    var nSpiritTypes = spiritBottles >= 5 ? 5 : spiritBottles;
    var bottlesPerType = spiritBottles > 0 ? Math.ceil(spiritBottles / nSpiritTypes) : 0;
    // v2.7.17: "more liquor / heavy on the spirits" (mix_bias leads with spirits) — at least 2 bottles of each type
    if (spiritBottles > 0 && !hasPct && /^spirits(>|$)/.test(String(iv.mix_bias || "").toLowerCase().replace(/\s+/g, "")) && guests >= 20) { nSpiritTypes = 5; bottlesPerType = Math.max(bottlesPerType, 2); }
    var wineBottles = split.wine > 0 ? Math.ceil(wineDrinks / 5) : 0;
    var beerCases = split.beer > 0 ? Math.ceil(beerDrinks / beerPackSize) : 0;
    // v2.2: balanced red/white by default (was red 60/40). Even split is the safer
    // default — white is at least as popular as red at most events (e.g. summer work
    // happy hours), so a red-heavy default over-orders red. The odd bottle goes to
    // white (a slight white lean). Package 5 keeps a sparkling slice: 40/40/20.
    var redB = 0, whiteB = 0, sparkB = 0;
    if (wineBottles > 0) {
      // v2.7.16: wine_lean ("white" | "red") — the customer asked for more of one colour: 60/40 (package 5: 50/30/20)
      var wineLean = String(iv.wine_lean || "").toLowerCase().indexOf("white") >= 0 ? "white" : (String(iv.wine_lean || "").toLowerCase().indexOf("red") >= 0 ? "red" : "");
      if (packageType === 5) {
        var mainShare = wineLean ? 0.5 : 0.4, minorShare = wineLean ? 0.3 : 0.4;
        var leanRed = wineLean === "red" ? mainShare : (wineLean === "white" ? minorShare : 0.4);
        redB = Math.round(wineBottles * leanRed); sparkB = Math.round(wineBottles * 0.2); whiteB = wineBottles - redB - sparkB;
      }
      else if (wineLean === "white") { redB = Math.floor(wineBottles * 0.4); whiteB = wineBottles - redB; }
      else if (wineLean === "red") { whiteB = Math.floor(wineBottles * 0.4); redB = wineBottles - whiteB; }
      else { redB = Math.floor(wineBottles * 0.5); whiteB = wineBottles - redB; }
    }
    var pb = productBudget || (totalBudget);
    var spiritBudget = Math.round(pb * split.spirits * 100) / 100;
    var wineBudget = Math.round(pb * split.wine * 100) / 100;
    var beerBudget = Math.round(pb * split.beer * 100) / 100;
    var beerEst = beerCases * 63;
    var surplus = Math.max(0, beerBudget - beerEst);
    if (surplus > 50) {
      if (packageType === 4) wineBudget += surplus;
      else if (packageType === 5) { wineBudget += surplus * 0.6; spiritBudget += surplus * 0.4; }
      else if (packageType === 7) spiritBudget += surplus;
      beerBudget = beerEst;
    }
    var wineTarget = wineBottles ? wineBudget / wineBottles : 0;
    var spiritTarget = spiritBottles ? spiritBudget / (bottlesPerType * nSpiritTypes) : 0;
    var beerTarget = beerCases ? beerBudget / beerCases : 0;
    // v2.7: FLOOR CAPS. budget / bottle_count is a fine target for a tight budget but
    // runs away on a generous one ($4,000 / 11 bottles = $360 -> only Weller & Clase
    // Azul qualify; $1,000 / 2 wines = $168 -> no wine clears the floor). Cap the
    // per-bottle target; the spend-up pass below uses the leftover budget instead.
    var rawWineTarget = wineTarget, rawSpiritTarget = spiritTarget; // budget-implied price per bottle, uncapped
    if (wineTarget > WINE_TARGET_CAP) wineTarget = WINE_TARGET_CAP;
    if (spiritTarget > SPIRIT_TARGET_CAP) spiritTarget = SPIRIT_TARGET_CAP;
    // v2.7.1: per-build tier ceilings — budget-aware for wine and (non-mixing) spirits
    var tierCeil = {
      wine: isQuoteMode ? TIER_CEIL.wine : scaledCeil(TIER_CEIL.wine, rawWineTarget),
      spirits: (isQuoteMode || isMixing) ? TIER_CEIL.spirits : scaledCeil(TIER_CEIL.spirits, rawSpiritTarget),
      beer: TIER_CEIL.beer, mixers: 0
    };
    // v2.7: a customer MIN cap above the capped target ("premium: spirits from $90")
    // lifts the target and the max with it — otherwise min 90 / max 98 is an empty
    // band and the floor fallback quietly returns the same bottles as before.
    if (capWineMin > 0 && !isQuoteMode) { wineTarget = Math.max(wineTarget, capWineMin * 1.4); }
    if (capSpiritMin > 0 && !isQuoteMode) { spiritTarget = Math.max(spiritTarget, capSpiritMin * 1.4); }

    var wMin = capWineMin || wineTarget * 0.6, wMax = capWineMax || Math.max(wineTarget * 1.4, capWineMin * 1.6);
    var sMin = capSpiritMin || spiritTarget * 0.6, sMax = capSpiritMax || Math.max(spiritTarget * 1.4, capSpiritMin * 1.6);
    var bMin = capBeerMin || (beerTarget > 80 ? 0 : beerTarget * 0.6), bMax = capBeerMax || (beerTarget > 80 ? 999999 : beerTarget * 1.4);
    if (quoteDefaults) { wineTarget = QD.wineT; wMin = QD.wineMin; wMax = QD.wineMax; spiritTarget = QD.spiritT; sMin = QD.spiritMin; sMax = QD.spiritMax; bMin = 0; bMax = 999999; }
    if (isQuoteMode && hasPriceCaps) {
      wMin = capWineMin || 0; wMax = capWineMax || 999999; wineTarget = capWineMax || 0;
      sMin = capSpiritMin || 0; sMax = capSpiritMax || 999999; spiritTarget = capSpiritMax || 0;
      bMin = capBeerMin || 0; bMax = capBeerMax || 999999; beerTarget = capBeerMax || 0;
    }

    var hasCocktails = cocktailIngredients.length > 0;
    // v2.7.5: mixer-only ingredient lists (mocktails) must NOT replace the default spirits.
    var hasAlcCocktail = false;
    for (var hc = 0; hc < cocktailIngredients.length; hc++) { var hr = String(cocktailIngredients[hc].role || "mixer").toLowerCase(); if (hr === "base" || hr === "secondary") hasAlcCocktail = true; }

    var plan = [];
    if (wineBottles > 0) {
      if (redB > 0) plan.push({ term: "Red Wine", slot: "red", qty: redB, target: wineTarget, min: wMin, max: wMax, label: "Red Wine", cat: "wine", uniq: 2 });
      if (whiteB > 0) plan.push({ term: "White Wine", slot: "white", qty: whiteB, target: wineTarget, min: wMin, max: wMax, label: "White Wine", cat: "wine", uniq: 2 });
      if (sparkB > 0) plan.push({ term: "Sparkling Wine", slot: "sparkling", qty: sparkB, target: wineTarget, min: wMin, max: wMax, label: "Sparkling Wine", cat: "wine", uniq: 2 });
    }
    if (split.beer > 0 && beerDrinks > 0) {
      // Beer + Hard Seltzer (+ NA beer) share the SAME bucket (the beer allocation).
      // Split it EVENLY across whichever are requested — seltzer/NA are carved OUT of
      // the beer share, never added on top — and they inherit the beer price band.
      var beerFamily = ["beer"];
      if (hardSeltzer) beerFamily.push("seltzer");
      if (naBeer) beerFamily.push("nabeer");
      // Per-member drink shares: EVEN by default; when a percentage mix was given,
      // split beer vs. hard seltzer proportional to beer%/seltzer% (NA beer rides
      // the beer share). Each member's cases are sized off its own share.
      var famShares = {};
      if (hasPct && (beerPct > 0 || seltzerPct > 0)) {
        var fw = {}, wsum = 0;
        for (var fi = 0; fi < beerFamily.length; fi++) {
          var mk = beerFamily[fi];
          fw[mk] = (mk === "seltzer") ? seltzerPct : beerPct;
          wsum += fw[mk];
        }
        for (var fj = 0; fj < beerFamily.length; fj++) famShares[beerFamily[fj]] = wsum > 0 ? (beerDrinks * fw[beerFamily[fj]] / wsum) : (beerDrinks / beerFamily.length);
      } else {
        for (var fk0 = 0; fk0 < beerFamily.length; fk0++) famShares[beerFamily[fk0]] = beerDrinks / beerFamily.length;
      }
      var famMeta = {
        beer: { term: "Beer", label: "Beer" },
        seltzer: { term: "Hard Seltzer", label: "Hard Seltzer" },
        nabeer: { term: "Non Alcoholic Beer", label: "Non-Alcoholic Beer" }
      };
      for (var bf = 0; bf < beerFamily.length; bf++) {
        var fk = beerFamily[bf];
        var mCases = Math.max(1, Math.ceil(famShares[fk] / beerPackSize));
        // carry the DRINK target (drinksNeeded) so quantities can be re-sized off the
        // chosen product's ACTUAL pack size after it's picked (see resize below).
        plan.push({ term: famMeta[fk].term, slot: fk, qty: mCases, drinksNeeded: famShares[fk], target: beerTarget, min: bMin, max: bMax, label: famMeta[fk].label, cat: "beer", uniq: 2 });
      }
    }
    if (spiritBottles > 0 && !hasAlcCocktail) {
      var typePriority = ["tequila", "vodka", "bourbon", "gin", "rum"].slice(0, nSpiritTypes);
      for (var st = 0; st < spiritTypes.length; st++) {
        var nm = spiritTypes[st];
        if (typePriority.indexOf(nm) < 0) continue;
        plan.push({ term: nm.charAt(0).toUpperCase() + nm.slice(1), slot: nm, qty: bottlesPerType, target: spiritTarget, min: sMin, max: sMax, label: nm.charAt(0).toUpperCase() + nm.slice(1), cat: "spirits", uniq: 1 });
      }
    }
    if (hasCocktails) {
      var cocktailDrinks = (spiritBottles > 0 && hasAlcCocktail) ? spiritDrinks : Math.round(totalDrinks * 0.3);
      // v2.7: the cocktail drinks are SHARED across the base spirits (and across the
      // mixers), not duplicated per ingredient. v2.6 sized every base as if all the
      // cocktail drinks were made with it — 5 bases x 9 bottles for 30 guests — and
      // relied on the budget trim to hide it; with the budget now spent deliberately,
      // that over-count would have become real bottles.
      var nBase = 0, nMixer = 0;
      for (var c0 = 0; c0 < cocktailIngredients.length; c0++) {
        var r0 = String(cocktailIngredients[c0].role || "mixer").toLowerCase();
        if (r0 === "base") nBase++; else if (r0 === "mixer") nMixer++;
      }
      var perBaseDrinks = cocktailDrinks / Math.max(1, nBase);
      var perMixerDrinks = cocktailDrinks / Math.max(1, Math.ceil(nMixer / 2)); // v2.7.6: each mocktail/cocktail uses ~2 mixers, so a mixer serves ~2/nMixer of the drinks
      for (var c = 0; c < cocktailIngredients.length; c++) {
        var ing = cocktailIngredients[c];
        var role = (ing.role || "mixer").toLowerCase();
        var q;
        if (role === "base") q = Math.max(1, Math.ceil(perBaseDrinks * 2 / 25));
        else if (role === "secondary") q = Math.max(1, Math.ceil(perBaseDrinks * 1 / 25));
        else q = Math.max(1, Math.ceil(perMixerDrinks / 20));
        // v2.7: slot by ROLE. A base spirit whose search term is a known spirit type
        // ("Vodka") gets that type's classifier (so "Rum" can't return a rum-cask
        // bourbon); other base/secondary bottles use "cbase"; mixers use "mixer",
        // which is non-alcoholic only. Mixers carry NO price floor.
        var ingTerm = String(ing.search || "").toLowerCase().trim();
        var ingSlot = role === "mixer" ? "mixer" : "cbase";
        if (role !== "mixer") { for (var sk2 in SPIRIT_KW) { if (SPIRIT_KW[sk2].indexOf(ingTerm) >= 0) { ingSlot = sk2; break; } } }
        plan.push({ term: ing.search, slot: ingSlot, role: role, qty: q, target: role === "base" ? spiritTarget : 0, min: role === "base" ? sMin : 0, max: role === "base" ? sMax : 999999, label: ing.search, cat: role === "mixer" ? "mixers" : "spirits", uniq: 1, mixerDrinks: role === "mixer" ? perMixerDrinks : 0 });
      }
    }

    if (plan.length === 0) return fail("Nothing to search: package produced no slots");

    // v2.7: a slot is "hard-capped" when the customer gave ANY price cap for its
    // category (min or max). v2.6 only honored max caps here, so an "upgrade" rebuild
    // with spirit_min_price 90 fell back to $0 and returned the original bottles.
    function isHardCapped(pl) {
      return !!((pl.cat === "wine" && (capWineMax || capWineMin)) || (pl.cat === "beer" && (capBeerMax || capBeerMin)) || (pl.cat === "spirits" && (capSpiritMax || capSpiritMin)));
    }
    function capMinOf(pl) {
      return pl.cat === "wine" ? capWineMin : (pl.cat === "beer" ? capBeerMin : (pl.cat === "spirits" ? capSpiritMin : 0));
    }
    // v2.7: BANDED SEARCH. The API returns at most 100 products per search and the
    // wide (0-999999) slice is dominated by the cheapest bottles — a "Red Wine" search
    // at a big store comes back as 100 wines under $30, so neither the base pick nor
    // the spend-up pass ever sees the $40-$90 shelf. For wine and spirits slots with a
    // price target we search SERVER-SIDE in [0.35 x target, tier ceiling] instead; that
    // one call serves both the pick and the tier-up pool. Beer, mixers and quote-mode
    // slots keep the wide search. Hard-capped slots keep the customer's range.
    function bandedRange(pl) {
      if (isQuoteMode || pl.cat === "mixers" || pl.cat === "beer" || !(pl.target > 0)) return null;
      var ceil = tierCeil[pl.cat] || 0;
      if (!ceil) return null;
      return { min: Math.max(0.01, Math.round(pl.target * 0.35 * 100) / 100), max: ceil };
    }
    var resAll = await Promise.all(plan.map(function (pl) {
      if (isHardCapped(pl) && pl.cat !== "mixers") return search(pl.term, pl.min, pl.max);
      var br = bandedRange(pl);
      if (br) return search(pl.term, br.min, br.max);
      return search(pl.term, 0, 999999);
    }));

    for (var pIdx = 0; pIdx < plan.length; pIdx++) {
      var pl = plan[pIdx];
      curMixerTerm = String(pl.term || "").toLowerCase();
      var picks = pick(resAll[pIdx], pl.slot, pl.target, pl.min, pl.max, pl.qty, pl.uniq);
      // v2.7: the floor must never empty a category. Any slot that is not hard-capped
      // by the customer retries at $0 — first within what we already fetched, then with
      // a wide search if the banded slice had nothing — before being reported
      // unavailable. (v2.6 skipped this for cocktail slots, which is why Vodka/Rum/Gin
      // came back "unavailable" on a $4,000 build while Tito's sat on the shelf.)
      if (picks.length === 0 && !isHardCapped(pl)) {
        picks = pick(resAll[pIdx], pl.slot, 0, 0, 999999, pl.qty, pl.uniq);
        if (picks.length === 0 && bandedRange(pl)) {
          resAll[pIdx] = await search(pl.term, 0, 999999);
          picks = pick(resAll[pIdx], pl.slot, pl.target, pl.min, pl.max, pl.qty, pl.uniq);
          if (picks.length === 0) picks = pick(resAll[pIdx], pl.slot, 0, 0, 999999, pl.qty, pl.uniq);
        }
      }
      // customer gave only a MIN ("premium"): relax the max first; if the store has
      // nothing at all above that floor, take the priciest bottles it does carry rather
      // than dropping the category.
      var onlyMin = isHardCapped(pl) && capMinOf(pl) > 0 && !((pl.cat === "wine" && capWineMax) || (pl.cat === "beer" && capBeerMax) || (pl.cat === "spirits" && capSpiritMax));
      if (picks.length === 0 && onlyMin) {
        picks = pick(resAll[pIdx], pl.slot, 0, capMinOf(pl), 999999, pl.qty, pl.uniq);
        if (picks.length === 0) {
          resAll[pIdx] = await search(pl.term, 0, 999999);
          picks = pick(resAll[pIdx], pl.slot, capMinOf(pl), 0, 999999, pl.qty, pl.uniq);
        }
      }
      // v2.3: RE-SIZE beer/seltzer off the chosen product's ACTUAL pack size. The plan
      // sized cases with the nominal beer_pack_size (default 12), but the real product
      // may ship as a 24-pack — counting a 24-pack as 12 doubled the servings. Split the
      // slot's drink target across the picked products and size each by its true pack.
      if (pl.cat === "beer" && pl.drinksNeeded > 0 && picks.length > 0) {
        // v2.7.4: size off EACH product's own pack. Start at 1 case per pick (variety),
        // then add one case at a time to the pick with the SMALLEST pack until the slot
        // reaches the drinks it needs. (v2.3 used the first pick's pack for every pick, so a
        // 24-pack + 12-pack pair counted 48 servings but delivered 36.)
        var packs = picks.map(function (pk) { return beerPackCount(pk.product.name, pk.product.sizeStr, pk.product.url, beerPackSize); });
        var cases = picks.map(function () { return 1; });
        var gsz = 0;
        function slotServings() { var t = 0; for (var z = 0; z < cases.length; z++) t += cases[z] * packs[z]; return t; }
        while (slotServings() < pl.drinksNeeded && gsz < 200) {
          gsz++;
          var smallest = 0;
          for (var z2 = 1; z2 < packs.length; z2++) if (packs[z2] < packs[smallest]) smallest = z2;
          cases[smallest]++;
        }
        for (var qp = 0; qp < picks.length; qp++) picks[qp].qty = cases[qp];
      }
      // v2.7.6: size MIXERS off the picked product's real volume (drinks served x ml per drink),
      // instead of a flat 1 unit per 20 drinks. Unknown size keeps the plan quantity.
      if (pl.cat === "mixers" && pl.mixerDrinks > 0 && picks.length > 0) {
        var needMl = pl.mixerDrinks * mixerMlPerDrink(pl.term);
        for (var mq = 0; mq < picks.length; mq++) {
          var uMl = mixerUnitMl(picks[mq].product.name, picks[mq].product.sizeStr);
          if (uMl > 0) picks[mq].qty = Math.min(40, Math.max(1, Math.ceil(needMl / picks.length / uMl)));
        }
      }
      // v2.7: hand the spend-up pass this slot's candidate pool and tier ceiling.
      // Mixers are never tiered up; a customer hard cap is the ceiling when given.
      var plCeil = pl.cat === "mixers" ? 0 : (isHardCapped(pl) ? Math.max(pl.max || 0, capMinOf(pl) * 1.6, tierCeil[pl.cat] || 0) : (tierCeil[pl.cat] || 0));
      if (pl.cat !== "mixers" && isHardCapped(pl) && ((pl.cat === "wine" && capWineMax) || (pl.cat === "beer" && capBeerMax) || (pl.cat === "spirits" && capSpiritMax))) plCeil = pl.max; // a customer MAX is absolute
      addLines(picks, pl.label, pl.cat, { pool: plCeil ? tierPool(resAll[pIdx], pl.slot, plCeil) : [], ceil: plCeil, qtyCap: 0, term: pl.term, slot: pl.slot });
    }
    summaryBits.push("Package " + packageType + " | " + guests + " guests | " + (drinksPerPerson > 0 ? (drinksPerPerson + " drinks/person") : (hours + "h")) + (hasPct ? (" | mix W" + winePct + "/B" + beerPct + "/S" + seltzerPct + (spiritPct ? "/Sp" + spiritPct : "")) : "") + " | " + (isQuoteMode ? "QUOTE" : "$" + totalBudget) + " | drinks " + totalDrinks);
  }

  if (lineItems.length === 0) return fail("No products available for this package at " + locDisplay);

  function productTotal() {
    var t = 0;
    for (var i = 0; i < lineItems.length; i++) t += lineItems[i].qty * lineItems[i].price;
    return Math.round(t * 100) / 100;
  }
  // v2.6: remember what the FULL target build would cost, before any budget trim, so
  // we can tell the customer what budget the event actually calls for.
  var preTrimTotal = productTotal();

  // ============================================================
  // v2.7: SPEND-UP — aim for 90-97% of the product budget (non-quote builds).
  // The drinks math fixes QUANTITIES from guests x hours; before v2.7 the budget was
  // only a ceiling, so a generous budget came back half-spent ($525 of $1,000).
  //   PASS 1 (tier up): repeatedly take the cheapest line that still has pricier
  //     in-class stock under its ceiling and swap it for the next bottle up
  //     (a preferred brand within the next three steps wins). Beer/seltzer only swap
  //     within the SAME pack count so servings don't change. Stops at 90%.
  //   (v2.7.2: there is deliberately NO quantity pass — see header.)
  // Neither pass can push the product total past the budget; the trim below is
  // unchanged and still guards the ceiling.
  // ============================================================
  var upgradedLines = 0;
  if (!isQuoteMode && productBudget > 0 && lineItems.length > 0) {
    var bandLo = productBudget * SPEND_BAND_LO, bandHi = productBudget * SPEND_BAND_HI;
    var usedNames = {};
    for (var un = 0; un < lineItems.length; un++) usedNames[lineItems[un].name.toLowerCase()] = 1;

    // v2.7.1: PREMIUM POOL EXTENSION. The API returns only the 100 cheapest rows per
    // search, so the pool from the first search usually tops out close to the base pick.
    // When the build is under the band, fetch the shelf ABOVE each wine/spirit line
    // (price > current, <= its ceiling) in one parallel round and merge it into the pool.
    // Only runs when needed, never for beer/mixers, never in quote mode.
    if (productTotal() < bandLo) {
      var extIdx = [];
      for (var ei = 0; ei < lineItems.length; ei++) {
        var EM = lineMeta[ei];
        if (!EM || !EM.term || !EM.slot || !(EM.ceil > 0)) continue;
        if (lineItems[ei].category !== "wine" && lineItems[ei].category !== "spirits") continue;
        if (lineItems[ei].price >= EM.ceil) continue;
        extIdx.push(ei);
      }
      if (extIdx.length > 0) {
        var extRes = await Promise.all(extIdx.map(function (ix) {
          return search(lineMeta[ix].term, Math.round((lineItems[ix].price + 0.01) * 100) / 100, lineMeta[ix].ceil);
        }));
        for (var ej = 0; ej < extIdx.length; ej++) {
          var EMx = lineMeta[extIdx[ej]];
          var have = {};
          for (var eh = 0; eh < EMx.pool.length; eh++) have[EMx.pool[eh].name.toLowerCase()] = 1;
          var more = tierPool(extRes[ej], EMx.slot, EMx.ceil);
          for (var em = 0; em < more.length; em++) if (!have[more[em].name.toLowerCase()]) { EMx.pool.push(more[em]); have[more[em].name.toLowerCase()] = 1; }
          EMx.pool.sort(function (a, b) { return a.price - b.price; });
        }
      }
    }

    // PASS 1 — tier up
    var g1 = 0;
    while (productTotal() < bandLo && g1 < 200) {
      g1++;
      var curPT = productTotal();
      var order = [];
      for (var li1 = 0; li1 < lineItems.length; li1++) {
        if (lineMeta[li1] && lineMeta[li1].pool.length > 0 && lineMeta[li1].ceil > 0 && lineItems[li1].name.toLowerCase().indexOf("mi campo") < 0) order.push(li1); // v2.7.12: Mi Campo is never swapped for a pricier tequila
      }
      order.sort(function (a, b) { return lineItems[a].price - lineItems[b].price; });
      var swapped = false;
      for (var oi = 0; oi < order.length && !swapped; oi++) {
        var L = lineItems[order[oi]], M = lineMeta[order[oi]];
        var curPack = L.category === "beer" ? beerPackCount(L.name, L.size, L.url, beerPackSize) : 0;
        var above = M.pool.filter(function (p) {
          if (p.price <= L.price || p.price > M.ceil) return false;
          if (usedNames[p.name.toLowerCase()]) return false;
          if (curPT + L.qty * (p.price - L.price) > bandHi) return false;
          if (L.category === "beer" && beerPackCount(p.name, p.sizeStr, p.url, beerPackSize) !== curPack) return false;
          return true;
        });
        if (above.length === 0) continue;
        // avoid-list brands only when nothing else is left to step up to
        var okAbove = above.filter(function (p) { return brandRank(p.name) > 0; });
        if (okAbove.length > 0) above = okAbove;
        var next = above[0];
        for (var ai = 0; ai < Math.min(3, above.length); ai++) {
          if (brandRank(above[ai].name) === 2) { next = above[ai]; break; }
        }
        delete usedNames[L.name.toLowerCase()];
        usedNames[next.name.toLowerCase()] = 1;
        L.name = next.name; L.price = next.price; L.size = next.sizeStr; L.url = next.url; L.product_id = next.product_id;
        if (L.tier !== "upgraded") { L.tier = "upgraded"; upgradedLines++; }
        swapped = true;
      }
      if (!swapped) break;
    }

    // v2.7.2: NO quantity pass. Quantities come from guests x hours (plus the fixed
    // minimums) and are never raised to spend budget — DC: "I don't want to put more
    // drinks than necessary." Budget is spent on better bottles only; what the store's
    // shelf can't absorb at any price is reported in budget_remaining for Rachel to say.
  }

  // v2.7: TIER-DOWN — if the picks alone exceed the budget (every line already at
  // qty 1, e.g. a "premium" rebuild with high price floors on a small party), swap
  // the most over-weight line for the next CHEAPER in-class bottle in its pool
  // (never below a customer min — the pool was fetched above it) before the
  // quantity trim runs. The old trim could only cut quantities, so a 135%-of-budget
  // package used to go out as-is.
  if (!isQuoteMode && productBudget > 0) {
    var g3 = 0;
    while (productTotal() > productBudget && g3 < 200) {
      g3++;
      var canTrim = false;
      for (var tq = 0; tq < lineItems.length; tq++) if (lineItems[tq].qty > 1) { canTrim = true; break; }
      if (canTrim) break; // let the proportional trim handle quantities first
      var bestD = -1, bestSave = 0, bestNext = null;
      for (var ld = 0; ld < lineItems.length; ld++) {
        var LD = lineItems[ld], MD = lineMeta[ld];
        if (!MD || !MD.pool || MD.pool.length === 0) continue;
        var below = MD.pool.filter(function (p) { return p.price < LD.price && !(LD.category === "beer" && beerPackCount(p.name, p.sizeStr, p.url, beerPackSize) !== beerPackCount(LD.name, LD.size, LD.url, beerPackSize)); });
        if (below.length === 0) continue;
        var nxt = below[below.length - 1]; // the next step down
        var save = LD.qty * (LD.price - nxt.price);
        if (LD.price > bestSave) { bestSave = LD.price; bestD = ld; bestNext = nxt; } // most expensive line steps down first
      }
      if (bestD < 0) break;
      var LX = lineItems[bestD];
      LX.name = bestNext.name; LX.price = bestNext.price; LX.size = bestNext.sizeStr; LX.url = bestNext.url; LX.product_id = bestNext.product_id;
      if (LX.tier === "upgraded") { LX.tier = "base"; upgradedLines = Math.max(0, upgradedLines - 1); }
    }
  }

  if (!isQuoteMode) {
    // v2.4: when the budget binds, scale EVERY line down proportionally first so the
    // requested category ratios survive (the old largest-line-first trim skewed them),
    // then use largest-first only to close the last few dollars.
    var pt0 = productTotal();
    if (pt0 > productBudget && productBudget > 0) {
      var scale = productBudget / pt0;
      var ideal = [];
      for (var si2 = 0; si2 < lineItems.length; si2++) {
        ideal[si2] = lineItems[si2].qty * scale;
        lineItems[si2].qty = Math.max(1, Math.floor(ideal[si2]));
      }
      // Largest-remainder fill: flooring leaves budget on the table, so add units back
      // to the lines that were rounded down the most — as long as each still fits — until
      // we're within one unit of the budget. Keeps the category ratios intact.
      var guardF = 0;
      while (guardF < 500) {
        var bestI = -1, bestRem = 0, curPT = productTotal();
        for (var fi2 = 0; fi2 < lineItems.length; fi2++) {
          var rem = ideal[fi2] - lineItems[fi2].qty;
          if (rem > bestRem && curPT + lineItems[fi2].price <= productBudget) { bestRem = rem; bestI = fi2; }
        }
        if (bestI < 0) break;
        lineItems[bestI].qty += 1;
        guardF++;
      }
    }
    var guard = 0;
    while (productTotal() > productBudget && guard < 50) {
      var idx = -1, best = 0;
      for (var i2 = 0; i2 < lineItems.length; i2++) {
        var sub = lineItems[i2].qty * lineItems[i2].price;
        if (lineItems[i2].qty > 1 && sub > best) { best = sub; idx = i2; }
      }
      if (idx < 0) break;
      lineItems[idx].qty -= 1;
      guard++;
    }
  }

  // v2.6: BUDGET-LIMITED detection. Count the drinks actually delivered (units x
  // servings) and compare to the duration/drinks-per-person target. If the budget
  // forced a meaningfully smaller package, surface it so Rachel can warn the customer
  // and offer to raise the budget instead of silently under-delivering.
  function servingsOf(li) {
    if (li.category === "wine") return li.qty * 5;
    if (li.category === "spirits") return li.qty * 16;
    if (li.category === "mixers") return 0;
    return li.qty * beerPackCount(li.name, li.size, li.url, beerPackSize);
  }
  var deliveredDrinks = 0;
  for (var dd = 0; dd < lineItems.length; dd++) deliveredDrinks += servingsOf(lineItems[dd]);
  var deliveredPerPerson = guests > 0 ? Math.round((deliveredDrinks / guests) * 10) / 10 : 0;
  var targetPerPerson = guests > 0 ? Math.round((totalDrinks / guests) * 10) / 10 : 0;
  var budgetLimited = (!isQuoteMode && totalDrinks > 0 && deliveredDrinks < totalDrinks * 0.9);
  // Budget needed to buy the full target at the chosen products' prices, rounded up to $25.
  var suggestedBudget = 0;
  if (budgetLimited && preTrimTotal > 0) {
    suggestedBudget = Math.ceil((preTrimTotal * 1.25 + 25) / 25) * 25;
  }

  // v2.7.3: ready-made, numbers-only sentence for the customer. Rachel pastes this
  // verbatim instead of stating a drinks-per-person rate of her own.
  var dppRound = Math.max(1, Math.round(deliveredPerPerson)); // v2.7.18: whole numbers only
  var dppFmt = String(dppRound);
  var hoursFmt = (Math.round(hours * 10) / 10).toString();
  var drinksStatement = "This package delivers about " + dppFmt + " drinks per person for your " + guests + " guests" +
    (drinksPerPerson > 0 ? "" : (" over " + hoursFmt + " hour" + (hours === 1 ? "" : "s"))) +
    " (about " + (dppRound * guests) + " drinks total).";

  // v2.7.19: why_drinks_statement — shown ONLY if the customer asks why the drinks number is what it is.
  var whyDrinksStatement = (!isQuoteMode && deliveredDrinks > totalDrinks * 1.15)
    ? ("Your package includes at least one bottle or pack of each type so there's real variety for your " + guests + " guests, which is why it covers about " + dppRound + " drinks per person. The rest of your budget goes into premium selections rather than extra quantity.")
    : ("This package is sized for about " + dppRound + " drinks per person for your " + guests + " guests, and any remaining budget goes into premium selections rather than extra quantity.");

  // v2.7.20: wine_heading — the full WINE heading with red/white/sparkling counts (sparkling was being dropped).
  var wRed = 0, wWhite = 0, wSpark = 0, wOther = 0, wTot = 0;
  for (var wq = 0; wq < lineItems.length; wq++) {
    if (lineItems[wq].category !== "wine") continue;
    var wl = String(lineItems[wq].label || "").toLowerCase(), wqty = parseInt(lineItems[wq].qty, 10) || 0;
    wTot += wqty;
    if (/spark|champ|prosecco|cava|brut/.test(wl)) wSpark += wqty;
    else if (/white/.test(wl)) wWhite += wqty;
    else if (/red/.test(wl)) wRed += wqty;
    else wOther += wqty;
  }
  var wParts = [];
  if (wRed > 0) wParts.push(wRed + " red");
  if (wWhite > 0) wParts.push(wWhite + " white");
  if (wSpark > 0) wParts.push(wSpark + " sparkling");
  if (wOther > 0) wParts.push(wOther + " other");
  var wineHeading = wTot > 0 ? ("WINE — " + wTot + " bottle" + (wTot === 1 ? "" : "s") + (wParts.length ? " (" + wParts.join(", ") + ")" : "")) : "";

  var pt = productTotal();
  var tax = Math.round(pt * 0.10 * 100) / 100;
  var svc = Math.round(pt * 0.10 * 100) / 100;
  var tip = Math.round(pt * 0.05 * 100) / 100;
  var delivery = 25.00;
  var grand = Math.round((pt + tax + svc + tip + delivery) * 100) / 100;
  var usedPct = productBudget > 0 ? Math.round(pt / productBudget * 100) : 0;
  // v2.7: what the customer has left of THEIR number (total budget minus estimated grand total).
  var budgetRemaining = isQuoteMode ? 0 : Math.max(0, Math.round((totalBudget - grand) * 100) / 100);

  var prefSeen = {};
  var prefList = [];
  for (var i3 = 0; i3 < lineItems.length; i3++) {
    var lbl = preferredLabel(lineItems[i3].name);
    if (lbl && !prefSeen[lbl]) { prefSeen[lbl] = 1; prefList.push(lineItems[i3].name.split(/ \d|—|-/)[0].trim()); }
  }

  var disp = [];
  for (var i4 = 0; i4 < lineItems.length; i4++) {
    var li = lineItems[i4];
    disp.push(li.label + ": " + li.qty + "x " + li.name + (li.size ? " — " + li.size : "") + " — $" + li.price.toFixed(2) + " ea = $" + (li.qty * li.price).toFixed(2) + " | " + li.url);
  }

  var summary = summaryBits.join(" ") + " | items " + lineItems.length + " | product $" + pt + " | grand $" + grand + (productBudget ? " | " + usedPct + "% of product budget" : "") + " | delivered " + deliveredDrinks + " of target " + totalDrinks + " drinks" + (budgetLimited ? (" | BUDGET-LIMITED (need ~$" + suggestedBudget + " for full target)") : "") + (upgradedLines ? (" | spend-up: " + upgradedLines + " lines tiered up") : "") + (!isQuoteMode ? (" | $" + budgetRemaining.toFixed(2) + " of budget left") : "") + (unavailable.length ? " | UNAVAILABLE: " + unavailable.join(", ") : "");

  return {
    outputVars: {
      success: "true",
      error: "",
      is_custom_mode: isCustom ? "true" : "false",
      line_items: JSON.stringify(lineItems),
      line_items_display: disp.join("\n"),
      product_total: pt.toFixed(2),
      estimated_tax: tax.toFixed(2),
      estimated_service: svc.toFixed(2),
      estimated_tip: tip.toFixed(2),
      delivery_fee: delivery.toFixed(2),
      estimated_grand_total: grand.toFixed(2),
      product_budget: String(productBudget),
      budget_used_pct: String(usedPct),
      preferred_brands: prefList.join(", "),
      unavailable: unavailable.join(", "),
      total_drinks: String(totalDrinks),
      delivered_drinks: String(deliveredDrinks),
      delivered_per_person: String(deliveredPerPerson),
      target_per_person: String(targetPerPerson),
      budget_limited: budgetLimited ? "true" : "false",
      suggested_budget: String(suggestedBudget),
      budget_remaining: budgetRemaining.toFixed(2),
      upgraded_lines: String(upgradedLines),
      drinks_statement: drinksStatement,
      why_drinks_statement: whyDrinksStatement,
      wine_heading: wineHeading,
      summary: summary
    },
    paths: ["success"]
  };
}
