export default async function main(args) {
  // ============================================================
  // SearchProducts v2.6 — composite product search.
  // One call handles: multiple queries in parallel, server-side
  // fallback terms, SERVER-SIDE price filtering (min/max), miniature
  // exclusion, and code-verified preferred-brand flags (Section 8.2).
  // v1.3: progressive name-narrowing (drop trailing words).
  // v1.4: price range pushed to the API via &min=&max=.
  // v1.5: strip volume/size tokens from the search term.
  // v1.6: default min = 0.01 (API's documented default).
  // v1.7: size-aware results (requested size ranked first).
  // v1.8: RESULTS-based broadening (broaden multi-word terms under top_n).
  // v1.9: kitchen_location may be a location name OR a full street address.
  // v2.0: location (name) vs zipcode — send ONE or the other.
  // v2.1: apostrophe-insensitive brand search.
  // v2.2: cap results at 3 per query.
  // v2.3: include minis when explicitly requested.
  // v2.4: (a) PACK-SIZE AWARE — "6 pack / 6pk / 12-pack / case of 24" is pulled out
  //           of the term and used as a filter+rank on the real container count
  //           ("6x12 OZ", "12pk", URL slug "-12pk-"), so a 6-pack ranks first instead
  //           of being cut off by top_n, and "12 pack" no longer literally matches
  //           "Rita Party 12 Pack" / seltzer variety packs.
  //       (b) ALIAS UNION — common shorthand is expanded (Stoli→Stolichnaya, sav/sauv/SV
  //           blanc→Sauvignon Blanc, cab→Cabernet, champaign→Champagne, handle→1.75 L,
  //           Titos→Tito's, Veuve→Veuve Clicquot…) and alias results are MERGED with
  //           the primary results instead of only being tried when the primary is empty.
  //       (c) VARIANT PENALTY — products carrying flavour/variant words the customer did
  //           not say (Lime, Platinum, Rita, Seltzer, Variety, Blueberi, Ohranj, Rose,
  //           0.0, Non Alcoholic, Light…) rank BELOW the plain product, so "Bud Light
  //           12 pack" returns the regular 12x12 before the Seltzer variety pack and
  //           "Stoli" returns Stolichnaya Vodka before Stoli Blueberi.
  //       (d) other_sizes — per query, the distinct sizes/packs that exist beyond the
  //           top_n shown, so Rachel can say "also in 12 and 18-packs" instead of
  //           "not in stock" when the wanted variant is simply ranked lower.
  //       (e) accent/hyphen normalisation (Rosé→Rose, Laurent-Perrier→Laurent Perrier).
  // v2.6: Mi Campo is exempt from the min_price floor. v2.5: Casa Noble dropped from the preferred list. A GENERIC tequila query ("tequila",
  //       "reposado tequila", "good tequila") also pulls Mi Campo by name (a plain "Tequila"
  //       search never returns it) and lists it FIRST. Branded requests are left alone.
  // Returns top N per query — small context footprint.
  // ============================================================

  var iv = args.inputVars;
  function resolveLocation(raw) {
    var s = String(raw || "").replace(/–/g, "-").trim();
    var zips = s.match(/\b\d{5}\b/g);
    if (zips && zips.length) return { location: "", zipcode: zips[zips.length - 1] };
    return { location: s, zipcode: "" };
  }
  var loc = resolveLocation(iv.kitchen_location);
  var locDisplay = loc.location || loc.zipcode;
  var clientName = String(iv.client_name || "");
  var topN = Math.min(parseInt(iv.top_n) || 3, 3);

  var queries = [];
  if (iv.queries) {
    try { queries = JSON.parse(iv.queries) || []; } catch (e) { queries = []; }
  }
  if (!Array.isArray(queries)) queries = [];

  function fail(msg) {
    return { outputVars: { success: "false", error: msg, results: "[]", found_count: "0", summary: "" }, paths: ["error"] };
  }
  if (!locDisplay || !clientName) return fail("Missing kitchen_location or client_name");
  if (queries.length === 0) return fail("queries must be a non-empty JSON array");
  if (queries.length > 12) queries = queries.slice(0, 12);

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

  function isMiCampo(name) { return /mi[ -]campo/i.test(name || ""); }
  function isGenericTequila(term) {
    var t = deaccent(String(term || "")).toLowerCase();
    if (t.indexOf("tequila") < 0) return false;
    var rest = t.replace(/\b(tequila|tequilas|blanco|silver|plata|reposado|anejo|extra|cristalino|joven|premium|top|shelf|good|best|nice|great|a|an|the|some|recommend|recommendation|me|for|of|and|or|bottle|bottles|\d+(?:\.\d+)?\s*(?:ml|l|oz))\b/g, " ").replace(/[^a-z]+/g, " ").trim();
    return rest === "";
  }
  function isPreferred(name) {
    var n = (name || "").toLowerCase();
    for (var i = 0; i < NOT_PREFERRED.length; i++) if (n.indexOf(NOT_PREFERRED[i]) >= 0) return false;
    for (var j = 0; j < PREFERRED.length; j++) if (n.indexOf(PREFERRED[j]) >= 0) return true;
    return false;
  }

  var MINI_WORDS = ["miniature", "sample", " nip", "airline"];
  function isMini(p) {
    var s = ((p.name || "") + " " + (p.sizeStr || "")).toLowerCase();
    for (var i = 0; i < MINI_WORDS.length; i++) if (s.indexOf(MINI_WORDS[i]) >= 0) return true;
    if (/(^|[^a-z])mini([^a-z]|$)/.test(s)) return true;
    if (/(^|[^0-9])(50|100|200)\s?ml/.test(s)) return true;
    return false;
  }

  // ---------- v2.4: text normalisation + aliases ----------
  function deaccent(s) {
    return String(s || "").replace(/[éèêë]/g, "e").replace(/[áàâä]/g, "a").replace(/[íìîï]/g, "i").replace(/[óòôö]/g, "o").replace(/[úùûü]/g, "u").replace(/ñ/g, "n").replace(/ç/g, "c").replace(/[’`´]/g, "'");
  }
  var FILLER = /\b(regular|plain|standard|normal|bottle|bottles|btl|btls|can|cans|of|a|an|some|please|pls|need|want|get|me|i|we|for|with|in|size|sized|version|type|kind|just|only|any)\b/gi;
  function normText(s) {
    return deaccent(s).replace(/(\w)-(\w)/g, "$1 $2").replace(/[,;:!?()\[\]"]/g, " ").replace(/\s+/g, " ").trim();
  }
  // drop filler words the catalog never contains ("regular Stoli vodka" -> "Stoli vodka");
  // keep the term if stripping would empty it
  function stripFiller(term) {
    var t = String(term || "").replace(FILLER, " ").replace(/\s+/g, " ").trim();
    return t || term;
  }
  // alias -> canonical (applied to the whole lower-cased term, word-bounded)
  var ALIASES = [
    [/\bstoli\b/, "stolichnaya"],
    [/\btitos\b/, "tito's"],
    [/\bveuve(?:\s+cli\w*)?\b/, "veuve clicquot"],
    [/\bdom(?:\s+per\w*)?\b/, "dom perignon"],
    [/\bmoet(?:\s+(?:&|and)?\s*chand\w*)?\b/, "moet"],
    [/\bjohnnie(?:\s+walk\w*)?\b/, "johnnie walker"],
    [/\bgrey\s+goo\w*\b|\bgray\s+goose\b/, "grey goose"],
    [/\bmich(?:elob)?\s+ultra\b/, "michelob ultra"],
    [/\bjack\s+daniels\b/, "jack daniel's"],
    [/\bjohnny\s+walker\b|\bjw\b/, "johnnie walker"],
    [/\b(?:sav|sauv|sv)\.?\s*blanc\b/, "sauvignon blanc"],
    [/\bsauvignon\s+blanc\b/, "sauvignon blanc"],
    [/\bcab\b(?!\s*sauv)/, "cabernet"],
    [/\bcab\s+sauv\b/, "cabernet sauvignon"],
    [/\bchampaign\b|\bchampange\b/, "champagne"],
    [/\bprosseco\b|\bprosecco\b/, "prosecco"],
    [/\bpinot\s+grigio\b|\bpinot\s+gris\b/, "pinot grigio"],
    [/\bclass\s+azul\b|\bclase\s+azul\b/, "clase azul"],
    [/\bbud\s+lite\b/, "bud light"],
    [/\bmiller\s+light\b/, "miller lite"],
    [/\bcoors\s+lite\b/, "coors light"],
    [/\bpatron\b/, "patron"]
  ];
  function aliasTerm(term) {
    var t = String(term || "").toLowerCase();
    var out = t;
    for (var i = 0; i < ALIASES.length; i++) out = out.replace(ALIASES[i][0], ALIASES[i][1]);
    return out !== t ? out : "";
  }
  // "handle" = 1.75 L
  function expandHandle(term) {
    return /\bhandle\b/i.test(term) ? String(term).replace(/\bhandle\s+of\s+/i, "").replace(/\bhandle\b/i, "1.75l") : term;
  }

  // ---------- size handling (unchanged) ----------
  function normSize(s) {
    var m = String(s || "").toLowerCase().replace(/\s+/g, "").match(/(\d+(?:\.\d+)?)(ml|l|cl|liter|litre|lt)/);
    if (!m) return "";
    var u = m[2];
    if (u === "liter" || u === "litre" || u === "lt") u = "l";
    return m[1] + u;
  }
  function extractSize(term) {
    var m = String(term || "").match(/\b(\d+(?:\.\d+)?)\s*(ml|l|cl|liter|litre|lt)\b/i);
    if (!m) return "";
    var u = m[2].toLowerCase();
    if (u === "liter" || u === "litre" || u === "lt") u = "l";
    return m[1].toLowerCase() + u;
  }
  function sizeMatches(sizeStr, req) { return !!req && normSize(sizeStr) === req; }
  function poolHasSize(pool, req) {
    for (var i = 0; i < pool.length; i++) if (sizeMatches(pool[i].sizeStr, req)) return true;
    return false;
  }

  // ---------- v2.4: pack-size handling ----------
  var WORDNUM = { two: 2, four: 4, six: 6, eight: 8, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20, thirty: 30 };
  // Requested pack count from the customer's term: "6 pack", "6pk", "6-pack", "six pack",
  // "case of 24", "24 case", "12 bottles", "12 cans". Returns 0 when none.
  function extractPack(term) {
    var t = String(term || "").toLowerCase();
    var m = t.match(/\b(\d{1,2})\s*-?\s*(?:pk|pack|packs)\b/) || t.match(/\bcase\s+of\s+(\d{1,2})\b/) || t.match(/\b(\d{1,2})\s*(?:bottles|btls|cans)\b/) || t.match(/\b(\d{1,2})\s*x\s*\d{1,2}\b/);
    if (m) return parseInt(m[1], 10) || 0;
    var w = t.match(/\b(two|four|six|eight|twelve|fifteen|eighteen|twenty|thirty)\s*-?\s*(?:pk|pack|packs)\b/);
    if (w) return WORDNUM[w[1]] || 0;
    return 0;
  }
  function stripPack(term) {
    return String(term || "")
      .replace(/\b\d{1,2}\s*-?\s*(?:pk|pack|packs)\b/gi, " ")
      .replace(/\b(?:two|four|six|eight|twelve|fifteen|eighteen|twenty|thirty)\s*-?\s*(?:pk|pack|packs)\b/gi, " ")
      .replace(/\bcase\s+of\s+\d{1,2}\b/gi, " ")
      .replace(/\b\d{1,2}\s*(?:bottles|btls|cans)\b/gi, " ")
      .replace(/\b\d{1,2}\s*x\s*\d{1,2}\s*(?:oz)?\b/gi, " ")
      .replace(/\b\d{1,2}\s*oz\b/gi, " ")
      .replace(/\s+/g, " ").trim();
  }
  // Actual container count of a product (same logic BuildPackage uses). 0 = unknown/single.
  function packCount(p) {
    var s = ((p.sizeStr || "") + " " + (p.name || "")).toLowerCase();
    var m = s.match(/(\d+)\s*x\s*\d+/); if (m) return parseInt(m[1]) || 0;
    m = s.match(/(\d+)\s*[- ]?\s*(?:pk|pack)\b/); if (m) return parseInt(m[1]) || 0;
    var u = String(p.url || "").toLowerCase();
    m = u.match(/(\d+)\s*pk\b/); if (m) return parseInt(m[1]) || 0;
    m = u.match(/(\d+)\s*x\s*\d+/); if (m) return parseInt(m[1]) || 0;
    return 0;
  }
  function containerOz(p) {
    var m = ((p.sizeStr || "") + " " + (p.name || "")).toLowerCase().match(/\d+\s*x\s*(\d+(?:\.\d+)?)\s*oz/);
    return m ? parseFloat(m[1]) : 0;
  }
  function packLabel(p) { var c = packCount(p); return c ? (c + "-pack") : ""; }

  // ---------- v2.4: variant penalty ----------
  var VARIANT_WORDS = ["lime", "platinum", "rita", "ritas", "seltzer", "variety", "next", "chelada", "zero", "0.0", "non alcoholic", "non-alcoholic", "n/a", "cider", "light", "lite", "ultra", "rose", "rosé", "blueberi", "raspberry", "razberi", "ohranj", "vanil", "citros", "peach", "cherry", "mango", "pineapple", "grapefruit", "cucumber", "citron", "orange", "apple", "honey", "fire", "flavored", "flavoured", "spiced", "coconut", "watermelon", "strawberry", "lemonade", "iced tea", "hard tea", "sangria", "party", "pack bottles", "elite", "gold", "premium", "reserve", "reserva", "anejo", "añejo", "reposado", "cristalino", "luminous", "nectar", "ice imperial", "grande dame", "la grande", "vintage", "cuvee", "brut nature", "demi sec", "extra dry", "nv"];
  // number of variant words in the product name that the customer did NOT type
  function variantPenalty(name, queryLo) {
    var n = deaccent(name).toLowerCase();
    var c = 0;
    for (var i = 0; i < VARIANT_WORDS.length; i++) {
      var w = VARIANT_WORDS[i];
      if (n.indexOf(w) >= 0 && queryLo.indexOf(w) < 0) c++;
    }
    return c;
  }
  function relevance(name, words) {
    if (!words) return 0;
    var n = deaccent(name).toLowerCase();
    var c = 0;
    for (var i = 0; i < words.length; i++) if (words[i] && n.indexOf(words[i]) >= 0) c++;
    return c;
  }

  async function search(term, minP, maxP) {
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
      } catch (e) { /* transient error -> retry once */ }
    }
    return [];
  }

  // Dedupe by name, then rank: requested pack/size first, fewest unasked-for variant
  // words, relevance, preferred, price desc. Emits other_sizes for what wasn't shown.
  function buildResult(label, pool, usedTerm, req, reqPack, relWords, queryLo) {
    var seenAll = {}; var uniqPool = [];
    for (var i = 0; i < pool.length; i++) {
      var kk = (pool[i].name || "").toLowerCase();
      if (!seenAll[kk]) { seenAll[kk] = 1; uniqPool.push(pool[i]); }
    }
    pool = uniqPool;
    // v2.4: if the customer named a pack count and we have products with that count, keep only those
    if (reqPack) {
      var exact = pool.filter(function (p) { return packCount(p) === reqPack; });
      if (exact.length > 0) pool = exact;
    }
    pool.sort(function (a, b) {
      var ma = isMiCampo(a.name) ? 0 : 1, mb = isMiCampo(b.name) ? 0 : 1;
      if (ma !== mb) return ma - mb;                       // v2.5: Mi Campo always first
      if (req) {
        var sa = sizeMatches(a.sizeStr, req) ? 0 : 1;
        var sb = sizeMatches(b.sizeStr, req) ? 0 : 1;
        if (sa !== sb) return sa - sb;
      }
      if (reqPack) {
        var ka = packCount(a) === reqPack ? 0 : 1, kb = packCount(b) === reqPack ? 0 : 1;
        if (ka !== kb) return ka - kb;
      }
      var va = variantPenalty(a.name, queryLo || ""), vb = variantPenalty(b.name, queryLo || "");
      if (va !== vb) return va - vb;                   // plain product before flavoured/variety
      if (reqPack) {                                     // multi-packs: 12 oz containers before 16/25 oz unless asked
        var oa = containerOz(a) === 12 ? 0 : 1, ob = containerOz(b) === 12 ? 0 : 1;
        if (oa !== ob) return oa - ob;
      }
      if (relWords) {
        var ra = relevance(a.name, relWords), rb = relevance(b.name, relWords);
        if (ra !== rb) return rb - ra;
      }
      var pa = isPreferred(a.name) ? 1 : 0, pb = isPreferred(b.name) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.price - a.price;
    });
    var top = []; var shownKeys = {};
    for (var j = 0; j < pool.length && top.length < topN; j++) {
      top.push({ name: pool[j].name, price: pool[j].price, size: pool[j].sizeStr, url: pool[j].url, product_id: pool[j].product_id, preferred: isPreferred(pool[j].name) });
      shownKeys[(packLabel(pool[j]) || normSize(pool[j].sizeStr) || "").toLowerCase()] = 1;
    }
    // v2.4: distinct sizes/packs that exist but were not shown
    var others = []; var seenO = {};
    for (var o = top.length; o < pool.length && others.length < 6; o++) {
      var lab = packLabel(pool[o]) || normSize(pool[o].sizeStr) || "";
      if (!lab || seenO[lab] || shownKeys[lab.toLowerCase()]) continue;
      seenO[lab] = 1; others.push(lab);
    }
    return { label: label, used_term: usedTerm, found: true, in_range_count: pool.length, products: top, other_sizes: others.join(", ") };
  }
  function stripSize(term) {
    return String(term || "").replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|cl|oz|liter|litre|lt)\b/gi, " ").replace(/\s+/g, " ").trim();
  }
  function narrow(term) {
    var w = String(term || "").trim().split(/\s+/).filter(Boolean);
    var out = [];
    for (var n = w.length - 1; n >= 2; n--) out.push(w.slice(0, n).join(" "));
    return out;
  }
  function apostropheVariants(term) {
    var t = String(term || "");
    var out = [];
    var noApos = t.replace(/[’']/g, "");
    if (noApos && noApos !== t) out.push(noApos);
    var ins = t.replace(/\b([A-Za-z]{2,})s\b/g, "$1's");
    if (ins && ins !== t) out.push(ins);
    return out;
  }
  async function runQuery(q) {
    var label = q.label || q.term || "";
    var minP = parseFloat(q.min_price) || 0;
    var maxP = parseFloat(q.max_price) || 999999;
    var raw = normText(expandHandle(q.term));                 // v2.4: accents/hyphens/handle normalised
    var req = extractSize(raw);
    var reqPack = parseInt(q.pack_size, 10) || extractPack(raw); // v2.4: explicit pack_size or parsed from the term
    var primary = stripFiller(stripPack(stripSize(raw))) || stripSize(raw) || raw;
    var narrowed = narrow(primary);
    var brandVariants = apostropheVariants(primary);
    var alias = aliasTerm(primary);                            // v2.4: "stoli vodka" -> "stolichnaya vodka"
    var primaryWords = primary.toLowerCase().split(/\s+/).filter(Boolean);
    var queryLo = deaccent(String(q.term || "")).toLowerCase() + " " + (alias || "");
    var provided = Array.isArray(q.fallback_terms) ? q.fallback_terms : [];
    var allowMini = (q.allow_minis === true || q.allow_minis === "true");
    if (!allowMini) {
      var rawLo = String(raw || "").toLowerCase();
      if (/(^|[^0-9])(50|100|200)\s?ml\b/.test(rawLo) || /\bmini\b|\bminis\b|\bnip\b|\bminiature\b|\bsample\b/.test(rawLo)) allowMini = true;
    }
    function poolOf(rawArr) { return rawArr.filter(function (p) { return (allowMini || !isMini(p)) && p.price >= minP && p.price <= maxP; }); }

    // v2.4: primary and alias run together and are merged (union), so Stolichnaya shows
    // up next to Stoli instead of being skipped because a flavoured Stoli answered first.
    var firstTerms = [primary];
    if (alias && alias !== primary.toLowerCase()) firstTerms.push(alias);
    var firstRaws = await Promise.all(firstTerms.map(function (tm) { return search(tm, minP, maxP); }));
    var pool0 = [];
    for (var f = 0; f < firstRaws.length; f++) pool0 = pool0.concat(poolOf(firstRaws[f]));

    if (isGenericTequila(raw)) {                                // v2.5: always offer Mi Campo
      // Mi Campo is exempt from the min_price floor (Rachel passes one for tequila); a max still applies.
      var mcPool = (await search("Mi Campo", 0, maxP)).filter(function (p) { return isMiCampo(p.name) && /tequila/i.test(p.name) && (allowMini || !isMini(p)) && p.price <= maxP; });
      pool0 = pool0.concat(mcPool);
    }

    if (pool0.length === 0 && brandVariants.length > 0) {
      for (var bvi = 0; bvi < brandVariants.length; bvi++) {
        var bvPool = poolOf(await search(brandVariants[bvi], minP, maxP));
        if (bvPool.length > 0) {
          pool0 = bvPool; primary = brandVariants[bvi]; narrowed = narrow(primary);
          primaryWords = primary.toLowerCase().split(/\s+/).filter(Boolean);
          break;
        }
      }
    }
    if (pool0.length > 0) {
      // Broaden when few results, OR the requested size/pack is absent from what came back.
      var needPack = reqPack && !pool0.some(function (p) { return packCount(p) === reqPack; });
      var doBroaden = narrowed.length > 0 && (pool0.length < topN || (req && !poolHasSize(pool0, req)) || needPack);
      if (doBroaden) {
        var raws2 = await Promise.all(narrowed.map(function (tm) { return search(tm, minP, maxP); }));
        for (var b = 0; b < raws2.length; b++) pool0 = pool0.concat(poolOf(raws2[b]));
        return buildResult(label, pool0, primary, req, reqPack, primaryWords, queryLo);
      }
      return buildResult(label, pool0, primary, req, reqPack, firstTerms.length > 1 ? primaryWords : null, queryLo);
    }

    var terms = [].concat(narrowed).concat(provided.map(function (t) { return stripPack(stripSize(normText(t))) || t; }));
    if (String(raw).toLowerCase() !== String(primary).toLowerCase()) terms.push(raw);
    var seenT = {}; var uniqT = [];
    for (var ti = 0; ti < terms.length && uniqT.length < 8; ti++) {
      if (!terms[ti]) continue;
      var k = String(terms[ti]).toLowerCase();
      if (!seenT[k]) { seenT[k] = 1; uniqT.push(terms[ti]); }
    }
    terms = uniqT;
    if (terms.length === 0) return { label: label, used_term: primary, found: false, in_range_count: 0, products: [], other_sizes: "" };
    var raws = await Promise.all(terms.map(function (tm) { return search(tm, minP, maxP); }));
    for (var t = 0; t < terms.length; t++) {
      var pool = poolOf(raws[t]);
      if (pool.length > 0) return buildResult(label, pool, terms[t], req, reqPack, primaryWords, queryLo);
    }
    return { label: label, used_term: terms[terms.length - 1], found: false, in_range_count: 0, products: [], other_sizes: "" };
  }

  var results = await Promise.all(queries.map(runQuery));

  var foundCount = results.filter(function (r) { return r.found; }).length;
  var summary = results.map(function (r) {
    return r.label + ": " + (r.found ? (r.products.length + " shown of " + r.in_range_count + " in range (term: " + r.used_term + ")" + (r.other_sizes ? " also: " + r.other_sizes : "")) : "NOT FOUND");
  }).join(" | ");

  return {
    outputVars: { success: "true", error: "", results: JSON.stringify(results), found_count: String(foundCount), summary: summary },
    paths: ["success"]
  };
}
