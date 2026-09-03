/**
 * Rachel Functions — Node.js port of Voiceflow function calls
 * GetProductURL, AddToCart, CalculateQuantities, CalculateBasket
 */

// ─── GET PRODUCT URL ─────────────────────────────────────────────────────────

async function getProductURL({ product_name, kitchen_location, client_id, min_price = 0, max_price = 999999, limit = 100 }) {
  if (!product_name || !kitchen_location) {
    return { product_found: false, product_id: "", products_json: "[]", result_count: 0, debug_info: "Missing product_name or kitchen_location" };
  }

  kitchen_location = kitchen_location.replace(/–/g, '-');

  try {
    // kitchen_location may be a 'zip:XXXXX' sentinel for zips with no hardcoded
    // kitchen_location mapping (see shopping-agent.js resolveLocation) — the search
    // API supports resolving directly from zipcode, so use that param instead.
    const isZipSentinel = kitchen_location.indexOf('zip:') === 0;
    const url = isZipSentinel
      ? `https://api.getbevvi.com/api/corpproducts/searchCorpProducts?zipcode=${encodeURIComponent(kitchen_location.slice(4))}&searchBy=${encodeURIComponent(product_name)}&limit=${limit}&client=${encodeURIComponent(client_id || '')}${min_price > 0 ? '&min='+min_price : ''}${max_price < 999999 ? '&max='+max_price : ''}`
      : `https://api.getbevvi.com/api/corpproducts/searchCorpProducts?location=${encodeURIComponent(kitchen_location)}&searchBy=${encodeURIComponent(product_name)}&limit=${limit}&client=${encodeURIComponent(client_id || '')}${min_price > 0 ? '&min='+min_price : ''}${max_price < 999999 ? '&max='+max_price : ''}`;
    const response = await fetch(url);
    if (!response.ok) return { product_found: false, product_id: "", products_json: "[]", result_count: 0, debug_info: `API HTTP error: ${response.status}` };

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return { product_found: false, product_id: "", products_json: "[]", result_count: 0, debug_info: "No results" };

    const filtered = data.filter(p => {
      const price = p.salePrice || p.price || 0;
      return price >= min_price && price <= max_price;
    }).slice(0, limit);

    if (filtered.length === 0) return { product_found: false, product_id: "", products_json: "[]", result_count: 0, debug_info: `${data.length} results but 0 in price range $${min_price}-$${max_price}` };

    const products = filtered.map(p => {
      const price = p.salePrice || p.price || 0;
      const size = p.size && p.units ? `${p.size}${p.units}` : "";
      const url = p.url || (p.slug ? `https://airculinaire.getbevvi.com/productdetail/${p.slug}` : "");
      const product_id = (p.corpProductFilter && p.corpProductFilter.corpProductId) || p.id || "";
      return { name: p.name || "", price: price ? `$${price}` : "", size, url, product_id, upc: p.upc || "" };
    });

    return {
      product_found: true,
      result_count: products.length,
      products_json: JSON.stringify(products),
      product_id: products[0]?.product_id || "",
      debug_info: `${data.length} → filter:${filtered.length}`
    };
  } catch (err) {
    return { product_found: false, product_id: "", products_json: "[]", result_count: 0, debug_info: `Error: ${err.message}` };
  }
}

// ─── ADD TO CART ──────────────────────────────────────────────────────────────

async function addToCart({ accountId, client, location, quantity = 1, product_id }) {
  try {
    const url = `https://api.getbevvi.com/api/bevvibot/addToShoppingCart?accountId=${encodeURIComponent(accountId)}&client=${encodeURIComponent(client)}&location=${encodeURIComponent(location)}&quantity=${encodeURIComponent(quantity)}&corpproduct=${encodeURIComponent(product_id)}`;
    const response = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    const data = await response.json();
    if (!response.ok) return { success: false, error: `API error: ${response.status} - ${data?.message || 'Unknown error'}` };
    return { success: true, cartData: JSON.stringify(data) };
  } catch (err) {
    return { success: false, error: err.message || 'Network error' };
  }
}

// ─── CALCULATE QUANTITIES ─────────────────────────────────────────────────────

function calculateQuantities({ guests, hours, total_budget, package_type, named_products, cocktail_mode = false, cocktail_names = [], beer_pack_size = 24 }) {
  guests = parseInt(guests) || 0;
  hours = parseFloat(hours) || 0;
  total_budget = parseFloat(total_budget) || 0;
  beer_pack_size = parseInt(beer_pack_size) || 24;

  const isCustom = (package_type === "CUSTOM" || package_type === "custom");
  const packageType = isCustom ? "CUSTOM" : (parseInt(package_type) || 5);

  let namedProducts = null;
  if (isCustom) {
    try {
      namedProducts = typeof named_products === 'string' ? JSON.parse(named_products) : named_products;
    } catch (e) {
      return emptyOutput(`Failed to parse named_products JSON: ${e.message}`);
    }
    if (!Array.isArray(namedProducts) || namedProducts.length === 0) {
      return emptyOutput("package_type=CUSTOM requires a non-empty named_products array");
    }
  }

  if (guests <= 0 || hours <= 0) return emptyOutput(`Missing required inputs: guests=${guests} hours=${hours}`);

  const isQuoteMode = total_budget >= 999999;
  if (total_budget <= 0) return emptyOutput(`Missing required input: budget=${total_budget}`);
  if (total_budget < 150 && !isQuoteMode) return emptyOutput(`Budget $${total_budget} is below the $150 minimum.`);

  // Tapering drinks model
  let baseDrinksPerPerson;
  if (hours <= 1)      baseDrinksPerPerson = 1.5;
  else if (hours <= 2) baseDrinksPerPerson = 2.25;
  else if (hours <= 3) baseDrinksPerPerson = 2.90;
  else if (hours <= 4) baseDrinksPerPerson = 3.45;
  else if (hours <= 5) baseDrinksPerPerson = 3.90;
  else                 baseDrinksPerPerson = Math.min(4.5, 3.90 + (hours - 5) * 0.30);

  let consumptionMultiplier = 1.0;
  if (!isCustom) {
    if (packageType === 3)      consumptionMultiplier = 0.80;
    else if (packageType === 6) consumptionMultiplier = 0.90;
  }

  const productBudget = isQuoteMode ? 0 : Math.round(((total_budget - 25) / 1.25) * 100) / 100;
  const estimatedTax     = isQuoteMode ? 0 : Math.round(productBudget * 0.10 * 100) / 100;
  const estimatedService = isQuoteMode ? 0 : Math.round(productBudget * 0.10 * 100) / 100;
  const estimatedTip     = isQuoteMode ? 0 : Math.round(productBudget * 0.05 * 100) / 100;
  const deliveryFee      = 25.00;
  const estimatedFeesTotal = isQuoteMode ? deliveryFee : Math.round((estimatedTax + estimatedService + estimatedTip + deliveryFee) * 100) / 100;

  if (isCustom) {
    return runCustomMode({ guests, hours, baseDrinksPerPerson, namedProducts, beerPackSize: beer_pack_size, productBudget, estimatedTax, estimatedService, estimatedTip, deliveryFee, estimatedFeesTotal, totalBudget: total_budget, isQuoteMode });
  }

  // Standard mode (package_type 1-7)
  const drinksPerPerson = baseDrinksPerPerson * consumptionMultiplier;
  const totalDrinks = Math.round(guests * drinksPerPerson);

  const splits = {
    1: { spirits: 1.00, wine: 0.00, beer: 0.00 },
    2: { spirits: 0.00, wine: 0.00, beer: 1.00 },
    3: { spirits: 0.00, wine: 1.00, beer: 0.00 },
    4: { spirits: 0.00, wine: 0.50, beer: 0.50 },
    5: { spirits: 0.32, wine: 0.62, beer: 0.05 },  // learned from 8,772 real orders
    6: { spirits: 0.32, wine: 0.68, beer: 0.00 },
    7: { spirits: 0.32, wine: 0.00, beer: 0.05 }
  };

  // Use learned splits if provided (from Shopping Agent package model)
  let split = splits[packageType] || splits[5];
  if (learned_splits && Object.keys(learned_splits).length > 0) {
    const ls = learned_splits;
    const wine = (ls.wine || ls.champagne || 0) / 100;
    const beer = (ls.beer || 0) / 100;
    const spirits = (ls.spirits || ls.liquor || 0) / 100;
    const total = wine + beer + spirits;
    if (total > 0) {
      split = { wine: wine/total, beer: beer/total, spirits: spirits/total };
      console.log('[buildPackage] using learned splits:', JSON.stringify(split));
    }
  }
  const spiritTypes = ["vodka", "rum", "bourbon", "gin", "tequila"];
  const SPIRIT_TYPE_COUNT = spiritTypes.length;

  const spiritDrinks = Math.round(totalDrinks * split.spirits);
  const wineDrinks   = Math.round(totalDrinks * split.wine);
  const beerDrinks   = Math.round(totalDrinks * split.beer);

  const rawSpiritBottles  = split.spirits > 0 ? Math.ceil(spiritDrinks / 16) : 0;
  const spiritBottles     = split.spirits > 0 ? Math.max(rawSpiritBottles, SPIRIT_TYPE_COUNT) : 0;
  const bottlesPerType    = spiritBottles > 0 ? Math.ceil(spiritBottles / SPIRIT_TYPE_COUNT) : 0;
  const spiritBottlesActual = bottlesPerType * SPIRIT_TYPE_COUNT;

  const wineBottles = split.wine > 0 ? Math.ceil(wineDrinks / 5) : 0;
  const beerCases   = split.beer > 0 ? Math.ceil(beerDrinks / beer_pack_size) : 0;

  let redBottles = 0, whiteBottles = 0, sparklingBottles = 0;
  if (wineBottles > 0) {
    if (packageType === 5) {
      redBottles      = Math.round(wineBottles * 0.50);
      whiteBottles    = Math.round(wineBottles * 0.30);
      sparklingBottles = wineBottles - redBottles - whiteBottles;
    } else {
      redBottles   = Math.round(wineBottles * 0.60);
      whiteBottles = wineBottles - redBottles;
    }
  }

  let spiritBudget = Math.round(productBudget * split.spirits * 100) / 100;
  let wineBudget   = Math.round(productBudget * split.wine   * 100) / 100;
  let beerBudget   = Math.round(productBudget * split.beer   * 100) / 100;

  const avgBeerPrice = 63;
  const beerEstSpend = beerCases * avgBeerPrice;
  const beerSurplus  = Math.max(0, beerBudget - beerEstSpend);

  if (beerSurplus > 50) {
    if (packageType === 4)      { wineBudget   += beerSurplus; }
    else if (packageType === 5) { wineBudget += Math.round(beerSurplus * 0.60 * 100) / 100; spiritBudget += Math.round(beerSurplus * 0.40 * 100) / 100; }
    else if (packageType === 7) { spiritBudget += beerSurplus; }
    beerBudget = beerEstSpend;
  }

  const wineTargetPrice   = wineBottles > 0         ? Math.round(wineBudget / wineBottles * 100) / 100 : 0;
  const spiritTargetPrice = spiritBottlesActual > 0  ? Math.round(spiritBudget / spiritBottlesActual * 100) / 100 : 0;
  const beerTargetPrice   = beerCases > 0            ? Math.round(beerBudget / beerCases * 100) / 100 : 0;

  const wineMinPrice   = Math.round(wineTargetPrice   * 0.60 * 100) / 100;
  const wineMaxPrice   = Math.round(wineTargetPrice   * 1.40 * 100) / 100;
  const spiritMinPrice = Math.round(spiritTargetPrice * 0.60 * 100) / 100;
  const spiritMaxPrice = Math.round(spiritTargetPrice * 1.40 * 100) / 100;
  const beerMinPrice   = beerTargetPrice > 80 ? 0      : Math.round(beerTargetPrice * 0.60 * 100) / 100;
  const beerMaxPrice   = beerTargetPrice > 80 ? 999999 : Math.round(beerTargetPrice * 1.40 * 100) / 100;

  return {
    success: "true", error: "", is_custom_mode: "false",
    total_drinks: String(totalDrinks),
    drinks_per_person: String(Math.round(drinksPerPerson * 100) / 100),
    wine_bottles: String(wineBottles), red_bottles: String(redBottles),
    white_bottles: String(whiteBottles), sparkling_bottles: String(sparklingBottles),
    beer_cases: String(beerCases), spirit_bottles: String(spiritBottlesActual),
    bottles_per_type: String(bottlesPerType), spirit_types: spiritTypes.join(","),
    product_budget: String(productBudget),
    wine_budget: String(wineBudget), beer_budget: String(beerBudget), spirit_budget: String(spiritBudget),
    estimated_tax: String(estimatedTax), estimated_service: String(estimatedService),
    estimated_tip: String(estimatedTip), delivery_fee: String(deliveryFee),
    estimated_fees_total: String(estimatedFeesTotal),
    wine_min_price: String(wineMinPrice), wine_max_price: String(wineMaxPrice),
    beer_min_price: String(beerMinPrice), beer_max_price: String(beerMaxPrice),
    spirit_min_price: String(spiritMinPrice), spirit_max_price: String(spiritMaxPrice),
    custom_allocations: ""
  };
}

function runCustomMode(ctx) {
  const { guests, hours, baseDrinksPerPerson, namedProducts, defaultBeerPackSize, productBudget, totalBudget, isQuoteMode } = ctx;

  function drinksPerUnit(product) {
    const category    = (product.category || "").toLowerCase();
    const size        = (product.size || "750ml").toLowerCase();
    const packSize    = parseInt(product.pack_size) || 0;
    if (category === "wine") {
      if (size.includes("1.5l") || size.includes("magnum")) return 10;
      if (size.includes("375")) return 2.5;
      return 5;
    }
    if (category === "spirits") {
      if (size.includes("1.75l")) return 39;
      if (size.includes("1l") || size === "1000ml") return 22;
      if (size.includes("375")) return 8;
      return 16;
    }
    if (category === "beer") return packSize > 0 ? packSize : (ctx.beerPackSize || 24);
    return 1;
  }

  const byCategory = { wine: [], beer: [], spirits: [] };
  const unknown = [];
  for (const p of namedProducts) {
    const cat = (p.category || "").toLowerCase();
    if (cat === "wine") byCategory.wine.push(p);
    else if (cat === "beer") byCategory.beer.push(p);
    else if (cat === "spirits") byCategory.spirits.push(p);
    else unknown.push(p);
  }
  if (unknown.length > 0) return emptyOutput(`Unknown category: ${unknown.map(p => p.name).join(", ")}`);

  let consumptionMultiplier = 1.0;
  if (byCategory.wine.length > 0 && byCategory.beer.length === 0 && byCategory.spirits.length === 0) consumptionMultiplier = 0.80;
  else if (byCategory.wine.length > 0 && byCategory.spirits.length > 0 && byCategory.beer.length === 0) consumptionMultiplier = 0.90;

  const drinksPerPerson = baseDrinksPerPerson * consumptionMultiplier;
  const totalDrinks     = Math.round(guests * drinksPerPerson);
  const representedCategories = [byCategory.wine, byCategory.beer, byCategory.spirits].filter(c => c.length > 0).length;
  const drinksPerCategory = representedCategories > 0 ? totalDrinks / representedCategories : 0;
  // QUANTITY allocation fix — this is the code path custom_list ACTUALLY runs (an
  // earlier patch landed in a dead inline block and never executed). The even 1/3
  // split above underweights wine badly (menu_build uses the learned 62/32/5 split;
  // the same 150-guest event sized 26 wine bottles one way, 12 the other). Use the
  // learned split as the base, floor every explicitly-requested category at 20% (so
  // beer isn't starved to ~1 case when the customer asked for it), then renormalize.
  const CATEGORY_FLOOR = 0.20;
  const baseSplit = { wine: 0.62, spirits: 0.32, beer: 0.05 };
  const catShare = {};
  let shareSum = 0;
  for (const c of ['wine', 'spirits', 'beer']) {
    if (byCategory[c].length > 0) { catShare[c] = Math.max(baseSplit[c], CATEGORY_FLOOR); shareSum += catShare[c]; }
  }
  if (shareSum > 0) for (const c in catShare) catShare[c] = catShare[c] / shareSum;
  console.log('[runCustomMode] runCustomMode category shares (learned split + 20% floor):', JSON.stringify(catShare));

  const allocations = [];

  function perProductCap(catName, product, n) {
    n = Math.max(1, n);
    if (catName === "wine")    return Math.max(1, Math.ceil((guests * hours * 0.6) / n));
    if (catName === "beer")    return Math.max(1, Math.ceil((guests * hours * 0.5) / n));
    if (catName === "spirits") return Math.max(1, Math.ceil((guests / 10 + 1) / n));
    return 999;
  }

  function allocateCategory(catName, products) {
    if (products.length === 0) return;
    const catDrinks = (catShare[catName] !== undefined) ? totalDrinks * catShare[catName] : drinksPerCategory;
    const drinksPerProduct = catDrinks / products.length;
    for (const product of products) {
      const dpu      = drinksPerUnit(product);
      // Honor a quantity ONLY when the customer explicitly stated it (qty_from_customer
      // true). An LLM-invented qty is ignored so the calculator sizes the item; this
      // path previously ignored qty entirely, so it could never honor "3 bottles of X".
      const qtyFromCustomer = product.qty_from_customer === true || product.qty_from_customer === 'true';
      const statedQty = parseInt(product.qty) || 0;
      let quantity   = Math.max(1, Math.ceil(drinksPerProduct / dpu));
      let capApplied = false;
      if (qtyFromCustomer && statedQty > 0) {
        quantity = statedQty;
      } else {
        if (statedQty > 0) console.log('[runCustomMode] ignoring LLM-supplied qty', statedQty, 'for', JSON.stringify(product.name), '(no qty_from_customer) — using calculator', quantity);
        const cap = perProductCap(catName, product, products.length);
        if (quantity > cap) { quantity = cap; capApplied = true; }
      }
      allocations.push({
        name: product.name, category: catName,
        subcategory: product.subcategory || "",
        product_id: product.product_id || "",
        price: product.price || 0, quantity,
        drinks_per_unit: dpu,
        drinks_delivered: quantity * dpu,
        drinks_target: Math.round(drinksPerProduct * 100) / 100,
        cap_applied: capApplied,
        subtotal: Math.round((product.price || 0) * quantity * 100) / 100
      });
    }
  }

  allocateCategory("wine",    byCategory.wine);
  allocateCategory("beer",    byCategory.beer);
  allocateCategory("spirits", byCategory.spirits);

  return {
    success: "true", error: "", is_custom_mode: "true",
    total_drinks: String(totalDrinks),
    drinks_per_person: String(Math.round(drinksPerPerson * 100) / 100),
    wine_bottles: "0", red_bottles: "0", white_bottles: "0", sparkling_bottles: "0",
    beer_cases: "0", spirit_bottles: "0", bottles_per_type: "0", spirit_types: "",
    product_budget: String(productBudget),
    wine_budget: "0", beer_budget: "0", spirit_budget: "0",
    estimated_tax: String(ctx.estimatedTax), estimated_service: String(ctx.estimatedService),
    estimated_tip: String(ctx.estimatedTip), delivery_fee: String(ctx.deliveryFee),
    estimated_fees_total: String(ctx.estimatedFeesTotal),
    wine_min_price: "0", wine_max_price: "0",
    beer_min_price: "0", beer_max_price: "0",
    spirit_min_price: "0", spirit_max_price: "0",
    custom_allocations: JSON.stringify(allocations)
  };
}

// ─── CALCULATE BASKET ─────────────────────────────────────────────────────────

function calculateBasket({ total_budget, line_items }) {
  total_budget = parseFloat(total_budget) || 0;

  let products = line_items;
  if (typeof products === 'string') {
    try { products = JSON.parse(products); } catch (e) {
      return { success: "false", error: "Invalid line_items JSON: " + e.message };
    }
  }

  if (!Array.isArray(products) || products.length === 0) {
    return { success: "false", error: "No line_items provided" };
  }

  const isQuoteMode = total_budget >= 999999;
  const lineItems = [];
  let subtotal = 0;

  for (const p of products) {
    const qty       = parseInt(p.qty || p.quantity) || 1;
    const priceRaw  = p.price || p.unit_price || 0;
    const price     = typeof priceRaw === 'string' ? parseFloat(priceRaw.replace(/[^0-9.]/g, '')) || 0 : parseFloat(priceRaw) || 0;
    const lineTotal = Math.round(qty * price * 100) / 100;
    subtotal += lineTotal;
    lineItems.push({ name: p.name || "Unknown", product_id: p.product_id || "", category: p.category || "", qty, unit_price: price.toFixed(2), line_total: lineTotal.toFixed(2) });
  }

  subtotal = Math.round(subtotal * 100) / 100;

  const productBudget    = isQuoteMode ? subtotal : Math.round(((total_budget - 25) / 1.25) * 100) / 100;
  const estimatedTax     = Math.round(subtotal * 0.10 * 100) / 100;
  const serviceCharge    = Math.round(subtotal * 0.10 * 100) / 100;
  const tip              = Math.round(subtotal * 0.05 * 100) / 100;
  const delivery         = 25.00;
  const feesTotal        = Math.round((estimatedTax + serviceCharge + tip + delivery) * 100) / 100;
  const estimatedGrandTotal = Math.round((subtotal + feesTotal) * 100) / 100;
  const utilizationPct   = productBudget > 0 ? Math.round((subtotal / productBudget) * 100) : 0;

  let status = "PASS";
  if (!isQuoteMode) {
    if (utilizationPct < 75)  status = "WARN_UNDERSPEND";
    if (utilizationPct > 100) status = "WARN_OVERSPEND";
    if (utilizationPct > 115) status = "FAIL_CRITICAL_OVERSPEND";
  }

  return {
    success: "true", error: "",
    status,
    product_budget:         String(productBudget),
    product_total:          String(subtotal),
    utilization_pct:        String(utilizationPct),
    fees: {
      estimated_tax:   String(estimatedTax),
      service_charge:  String(serviceCharge),
      tip:             String(tip),
      delivery:        String(delivery),
      fees_total:      String(feesTotal)
    },
    estimated_grand_total: String(estimatedGrandTotal),
    total_budget:          String(total_budget),
    line_items_validated:  JSON.stringify(lineItems)
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function emptyOutput(errorMessage) {
  return {
    success: "false", error: errorMessage, is_custom_mode: "false",
    total_drinks: "0", drinks_per_person: "0",
    wine_bottles: "0", red_bottles: "0", white_bottles: "0", sparkling_bottles: "0",
    beer_cases: "0", spirit_bottles: "0", bottles_per_type: "0", spirit_types: "",
    product_budget: "0", wine_budget: "0", beer_budget: "0", spirit_budget: "0",
    estimated_tax: "0", estimated_service: "0", estimated_tip: "0",
    delivery_fee: "0", estimated_fees_total: "0",
    wine_min_price: "0", wine_max_price: "0",
    beer_min_price: "0", beer_max_price: "0",
    spirit_min_price: "0", spirit_max_price: "0",
    custom_allocations: ""
  };
}



// --- CREATE ORDER ---
async function createOrder({ products, customerData, tipAmount, deliveryDateTime, deliveryInstructions, client }) {
  tipAmount = parseFloat(tipAmount) || 0;
  // deliveryDateTime is required — convert to ISO or default to tomorrow 10am
  if (!deliveryDateTime || isNaN(new Date(deliveryDateTime).getTime())) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    deliveryDateTime = tomorrow.toISOString();
  } else {
    deliveryDateTime = new Date(deliveryDateTime).toISOString();
  }
  deliveryInstructions = deliveryInstructions || '';

  try {
    if (!products || products.length === 0) {
      return { success: false, order_id: '', payment_url: '', error: 'No products provided' };
    }

    const orderProducts = products.map(function(p) {
      return {
        name: p.name || '',
        upc: p.upc || '',
        qty: parseInt(p.qty) || parseInt(p.quantity) || 1
      };
    });

    const body = {
      products: orderProducts,
      client: client || 'airculinaire',
      customerData: {
        firstName: (customerData && customerData.firstName) || '',
        lastName:  (customerData && customerData.lastName)  || '',
        email:     (customerData && customerData.email)     || '',
        address:   (customerData && customerData.address)   || '',
        suiteNumber: '',
        streetAddress: '',
        city:      (customerData && customerData.city)      || '',
        state:     (customerData && customerData.state)     || '',
        zipcode:   (customerData && customerData.zipcode)   || '',
        phoneNumber: ((customerData && customerData.phoneNumber) || (customerData && customerData.phone) || '').replace(/[^0-9]/g, ''),
        companyName: ''
      },
      tipAmount: tipAmount,
      deliveryDateTime: deliveryDateTime,
      deliveryInstructions: deliveryInstructions
    };

    console.log('[createOrder] sending:', JSON.stringify(body).slice(0, 500));
    const response = await fetch('https://api.getbevvi.com/api/bevvibot/createOrder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    var data = await response.json();
    console.log('[createOrder] response:', JSON.stringify(data).slice(0, 300));
    if (typeof data === 'string') { data = JSON.parse(data); }
    if (Array.isArray(data)) { data = data[0] || {}; }

    const orderId    = data.orderNumber || data.order_id || data.orderId || data.id || '';
    const paymentUrl = data.orderLink   || data.payment_url || data.paymentUrl || data.checkoutUrl || '';
    const apiSuccess = data.success === true || data.success === 'true';

    if (apiSuccess && (orderId || paymentUrl)) {
      return { success: true, order_id: String(orderId), payment_url: String(paymentUrl), error: '' };
    } else {
      return { success: false, order_id: String(orderId), payment_url: String(paymentUrl), error: data.message || 'Order creation failed' };
    }
  } catch (err) {
    return { success: false, order_id: '', payment_url: '', error: 'Request failed: ' + err.message };
  }
}



// --- GET PRODUCTS BY ZIP (new API) ---
async function getProductURLByZip({ product_name, zipcode, client_id, min_price, max_price, limit, exclude_sparkling }) {
  min_price = parseFloat(min_price) || 0;
  max_price = parseFloat(max_price) || 999999;
  limit = parseInt(limit) || 10;
  const doExcludeSparkling = exclude_sparkling === true || exclude_sparkling === 'true';

  if (!zipcode) {
    return { product_found: false, products_json: '[]', result_count: 0, debug_info: 'Missing zipcode' };
  }

  const sparklingKeywords = ['brut','champagne','prosecco','cava','cremant','sparkling','ruinart','veuve clicquot','dom perignon','moet','krug','taittinger','bollinger','mumm'];

  try {
    let data = [];
    console.log('[getProductURLByZip] zipcode:', zipcode, 'product_name:', product_name);
    {
      // Direct zipcode-based search — API now resolves the store from zipcode itself,
      // no kitchen_location mapping needed.
      const effectiveClient = client_id || 'airculinaire';
      const scUrl = 'https://api.getbevvi.com/api/corpproducts/searchCorpProducts?zipcode=' + encodeURIComponent(zipcode) + '&searchBy=' + encodeURIComponent(product_name || '') + '&limit=100&client=' + encodeURIComponent(effectiveClient) + (min_price > 0.01 ? '&min='+min_price : '') + (max_price < 9999 ? '&max='+max_price : '');
      const scRes = await fetch(scUrl);
      if (scRes.ok) {
        const scData = await scRes.json();
        if (Array.isArray(scData) && scData.length > 0) {
          // searchCorpProducts already filtered by name — return directly
          const mapped = scData.slice(0, limit).map(p => ({
            name: p.name || '',
            price: p.salePrice || p.price ? '$' + (p.salePrice || p.price) : '',
            size: p.size && p.units ? p.size + ' ' + p.units : '',
            url: p.url || (p.slug ? 'https://airculinaire.getbevvi.com/productdetail/' + p.slug : ''),
            product_id: (p.corpProductFilter && p.corpProductFilter.corpProductId) || p.id || '',
            upc: p.upc || ''
          }));
          return { product_found: true, result_count: mapped.length, products_json: JSON.stringify(mapped), product_id: mapped[0]?.product_id || '', upc: mapped[0]?.upc || '', debug_info: 'zip:' + zipcode };
        }
      }
    }
    {
      // Fall back to getProducts API for unmapped zips
      const url = 'https://api.getbevvi.com/api/corpproducts/getProducts?zipcode=' + encodeURIComponent(zipcode);
      const response = await fetch(url);
      if (!response.ok) return { product_found: false, products_json: '[]', result_count: 0, debug_info: 'API error: ' + response.status };
      const json = await response.json();
      data = json.products || [];
    }
    if (!Array.isArray(data) || data.length === 0) {
      // Fallback: try searchCorpProducts with mapped kitchen location
      
  // Zip to kitchen location mapping (fallback when getProducts returns nothing)
  const ZIP_TO_KITCHEN = {
    '07608': 'Teterboro - NJ', '07631': 'Teterboro - NJ', '07652': 'Teterboro - NJ',
    '07666': 'Teterboro - NJ', '07670': 'Teterboro - NJ', '07024': 'Teterboro - NJ',
    '07010': 'Teterboro - NJ', '07026': 'Teterboro - NJ', '07047': 'Teterboro - NJ',
    '07072': 'Teterboro - NJ', '07073': 'Teterboro - NJ', '07074': 'Teterboro - NJ',
    '10001': 'Celonis - NYC', '10002': 'Celonis - NYC', '10003': 'Celonis - NYC',
    '10004': 'Celonis - NYC', '10005': 'Celonis - NYC', '10006': 'Celonis - NYC',
    '10007': 'Celonis - NYC', '10008': 'Celonis - NYC', '10009': 'Celonis - NYC',
    '10010': 'Celonis - NYC', '10011': 'Celonis - NYC', '10012': 'Celonis - NYC',
    '10013': 'Celonis - NYC', '10014': 'Celonis - NYC', '10016': 'Celonis - NYC',
    '10017': 'Celonis - NYC', '10018': 'Celonis - NYC', '10019': 'Celonis - NYC',
    '10020': 'Celonis - NYC', '10021': 'Celonis - NYC', '10022': 'Celonis - NYC',
    '10023': 'Celonis - NYC', '10024': 'Celonis - NYC', '10025': 'Celonis - NYC',
    '10026': 'Celonis - NYC', '10027': 'Celonis - NYC', '10028': 'Celonis - NYC'
  };

      const kitchenLoc = ZIP_TO_KITCHEN[zipcode];
      if (kitchenLoc) {
        console.log('[getProducts] fallback to searchCorpProducts for', zipcode, '→', kitchenLoc);
        const fallbackUrl = 'https://api.getbevvi.com/api/corpproducts/searchCorpProducts?location=' + encodeURIComponent(kitchenLoc) + '&searchBy=' + encodeURIComponent(product_name || '') + '&limit=100&client=' + encodeURIComponent(client_id || 'airculinaire');
        const fbRes = await fetch(fallbackUrl);
        if (fbRes.ok) {
          const fbData = await fbRes.json();
          if (Array.isArray(fbData) && fbData.length > 0) {
            const mapped = fbData.map(p => ({
              name: p.name, upc: p.upc || '', price: p.salePrice || p.price || 0,
              size: p.size && p.units ? p.size + p.units : '',
              url: p.url || (p.slug ? 'https://airculinaire.getbevvi.com/productdetail/' + p.slug : ''),
              product_id: (p.corpProductFilter && p.corpProductFilter.corpProductId) || p.id || '',
              category: p.category || '', in_stock: true
            }));
            return { product_found: true, products_json: JSON.stringify(mapped), result_count: mapped.length, debug_info: 'fallback:' + kitchenLoc };
          }
        }
      }
      return { product_found: false, products_json: '[]', result_count: 0, debug_info: 'No inventory at this zip' };
    }

    let filtered = data;
    if (product_name) {
      const searchTerms = product_name.toLowerCase().split(/\s+/);
      filtered = data.filter(function(p) {
        const haystack = ((p.name || '') + ' ' + (p.category || '') + ' ' + (p.subCategory || '') + ' ' + (p.varietal || '') + ' ' + (p.brandinfo || '')).toLowerCase();
        return searchTerms.some(function(term) { return haystack.indexOf(term) !== -1; });
      });
    }

    filtered = filtered.filter(function(p) {
      const price = p.salePrice || p.price || 0;
      return price >= min_price && price <= max_price;
    });

    if (doExcludeSparkling) {
      filtered = filtered.filter(function(p) {
        const n = (p.name || '').toLowerCase();
        return !sparklingKeywords.some(function(kw) { return n.indexOf(kw) !== -1; });
      });
    }

    if (filtered.length === 0) return { product_found: false, products_json: '[]', result_count: 0, debug_info: 'No results matching: ' + product_name };

    filtered.sort(function(a, b) { return (b.salePrice || b.price || 0) - (a.salePrice || a.price || 0); });

    const products = filtered.slice(0, limit).map(function(p) {
      const price = p.salePrice || p.price || 0;
      const size = p.size && p.units ? p.size + ' ' + p.units : '';
      return {
        name: p.name || '',
        price: price ? '$' + price : '',
        size: size,
        url: p.url || '',
        product_id: (p.corpProductFilter && p.corpProductFilter.corpProductId) || p.id || '',
        upc: p.upc || p.origanlUpc || ''
      };
    });

    // If no filtered results, try searchCorpProducts fallback
    if (products.length === 0) {
      const ZIP_TO_KITCHEN2 = {
        '07608': 'Teterboro - NJ', '07631': 'Teterboro - NJ', '07652': 'Teterboro - NJ',
        '07666': 'Teterboro - NJ', '07670': 'Teterboro - NJ', '07024': 'Teterboro - NJ',
        '07010': 'Teterboro - NJ', '07026': 'Teterboro - NJ', '07047': 'Teterboro - NJ',
        '07072': 'Teterboro - NJ', '07073': 'Teterboro - NJ', '07074': 'Teterboro - NJ',
        '10001': 'Celonis - NYC', '10002': 'Celonis - NYC', '10003': 'Celonis - NYC',
        '10010': 'Celonis - NYC', '10011': 'Celonis - NYC', '10016': 'Celonis - NYC',
        '10019': 'Celonis - NYC', '10022': 'Celonis - NYC', '10028': 'Celonis - NYC'
      };
      const kitchenLoc = ZIP_TO_KITCHEN2[zipcode];
      if (kitchenLoc && product_name) {
        try {
          console.log('[getProducts] fallback searchCorpProducts:', zipcode, '->', kitchenLoc);
          const fbUrl = 'https://api.getbevvi.com/api/corpproducts/searchCorpProducts?location=' + encodeURIComponent(kitchenLoc) + '&searchBy=' + encodeURIComponent(product_name) + '&limit=20&client=' + encodeURIComponent(client_id || 'airculinaire');
          const fbRes = await fetch(fbUrl);
          if (fbRes.ok) {
            const fbData = await fbRes.json();
            if (Array.isArray(fbData) && fbData.length > 0) {
              const fbProducts = fbData.slice(0, limit).map(function(p) {
                return {
                  name: p.name || '',
                  price: p.salePrice || p.price ? '$' + (p.salePrice || p.price) : '',
                  size: p.size && p.units ? p.size + ' ' + p.units : '',
                  url: p.url || (p.slug ? 'https://airculinaire.getbevvi.com/productdetail/' + p.slug : ''),
                  product_id: (p.corpProductFilter && p.corpProductFilter.corpProductId) || p.id || '',
                  upc: p.upc || ''
                };
              });
              return { product_found: true, result_count: fbProducts.length, products_json: JSON.stringify(fbProducts), product_id: fbProducts[0]?.product_id || '', upc: fbProducts[0]?.upc || '', debug_info: 'fallback:' + kitchenLoc };
            }
          }
        } catch(e) { console.error('[getProducts] fallback error:', e.message); }
      }
      return { product_found: false, products_json: '[]', result_count: 0, debug_info: 'No match at zip ' + zipcode };
    }
  } catch(err) {
    return { product_found: false, products_json: '[]', result_count: 0, debug_info: 'Error: ' + err.message };
  }
  return { product_found: false, products_json: '[]', result_count: 0, debug_info: 'No result' };
}

async function buildPackage(iv) {
  var guests = parseInt(iv.guests) || 0;
  var hours = parseFloat(iv.hours) || 0;
  var drinksPerPersonInput = parseFloat(iv.drinks_per_person) || 0;
  var rawPackageType = iv.package_type;
  var isCustom = (rawPackageType === "CUSTOM" || rawPackageType === "custom");
  var isSplit = (rawPackageType === "SPLIT" || rawPackageType === "split");
  var packageType = isCustom ? "CUSTOM" : (isSplit ? "SPLIT" : (parseInt(rawPackageType) || 5));
  var totalBudget = parseFloat(iv.total_budget) || 0;
  var learned_splits = iv.learned_splits || null;
  var beerPackSize = parseInt(iv.beer_pack_size) || 12;
  var kitchenLocation = String(iv.kitchen_location || "").replace(/\u2013/g, "-");
  var clientName = String(iv.client_name || "");
  var hardSeltzer = String(iv.hard_seltzer || "") === "true";
  var naBeer = String(iv.na_beer || "") === "true";
  var capWineMin = parseFloat(iv.wine_min_price) || 0;
  var capWineMax = parseFloat(iv.wine_max_price) || 0;
  var capBeerMin = parseFloat(iv.beer_min_price) || 0;
  var capBeerMax = parseFloat(iv.beer_max_price) || 0;
  var capSpiritMin = parseFloat(iv.spirit_min_price) || 0;
  var capSpiritMax = parseFloat(iv.spirit_max_price) || 0;
  var hasPriceCaps = !!(capWineMax || capBeerMax || capSpiritMax || capWineMin || capBeerMin || capSpiritMin);
  var cocktailIngredients = [];
  if (iv.cocktail_ingredients) { try { cocktailIngredients = JSON.parse(iv.cocktail_ingredients) || []; } catch(e) { cocktailIngredients = []; } }
  if (!Array.isArray(cocktailIngredients)) cocktailIngredients = [];
  var namedProducts = [];
  if (iv.named_products) { try { namedProducts = JSON.parse(iv.named_products) || []; } catch(e) { namedProducts = []; } }
  if (!Array.isArray(namedProducts)) namedProducts = [];

  function fail(msg) {
    return { success:"false", error:msg, line_items:"[]", line_items_display:"",
      product_total:"0", estimated_tax:"0", estimated_service:"0", estimated_tip:"0",
      delivery_fee:"25", estimated_grand_total:"0", product_budget:"0", budget_used_pct:"0",
      preferred_brands:"", unavailable:"", total_drinks:"0", summary:"", is_custom_mode:isCustom?"true":"false" };
  }

  // Resolve kitchen_location from zipcode if not provided
  if (!kitchenLocation && iv.zipcode) {
    const ZIP_MAP = {
      '07608': 'Teterboro - NJ', '07631': 'Teterboro - NJ', '07652': 'Teterboro - NJ',
      '07666': 'Teterboro - NJ', '07670': 'Teterboro - NJ', '07024': 'Teterboro - NJ',
      '07010': 'Teterboro - NJ', '07026': 'Teterboro - NJ', '07047': 'Teterboro - NJ',
      '07072': 'Teterboro - NJ', '07073': 'Teterboro - NJ', '07074': 'Teterboro - NJ',
      '10001': 'Celonis - NYC', '10002': 'Celonis - NYC', '10003': 'Celonis - NYC',
      '10010': 'Celonis - NYC', '10011': 'Celonis - NYC', '10016': 'Celonis - NYC',
      '10019': 'Celonis - NYC', '10022': 'Celonis - NYC', '10028': 'Celonis - NYC'
    };
    const CLIENT_MAP = { 'Teterboro - NJ': 'airculinaire', 'Celonis - NYC': 'fooda' };
    kitchenLocation = ZIP_MAP[iv.zipcode] || '';
    if (kitchenLocation) clientName = CLIENT_MAP[kitchenLocation] || 'airculinaire'; // always use mapped client
  }

  if (guests <= 0 || (hours <= 0 && drinksPerPersonInput <= 0)) return fail("Missing guests, and neither hours nor drinks_per_person was given");
  if (totalBudget <= 0 && !isSplit) return fail("Missing total_budget");
  var isQuoteMode = (totalBudget >= 999999) || isSplit;
  if (totalBudget < 150 && !isQuoteMode) return fail("Budget $" + totalBudget + " is below the $150 minimum.");
  if (!kitchenLocation || !clientName) return fail("Missing kitchen_location or client_name");
  if (isCustom && namedProducts.length === 0) return fail("package_type=CUSTOM requires named_products");

  var baseDpp;
  if (drinksPerPersonInput > 0) {
    // Customer specified drinks-per-person directly — use it as-is rather than
    // deriving it from event duration. This is what actually drives quantity
    // calculations everywhere downstream (totalDrinks, category splits, custom
    // mode caps), so no other logic needs to change once this is set correctly.
    baseDpp = drinksPerPersonInput;
  } else if (hours <= 1) baseDpp = 1.5;
  else if (hours <= 2) baseDpp = 2.25;
  else if (hours <= 3) baseDpp = 2.90;
  else if (hours <= 4) baseDpp = 3.45;
  else if (hours <= 5) baseDpp = 3.90;
  else baseDpp = Math.min(4.5, 3.90 + (hours - 5) * 0.30);

  var mult = 1.0;
  if (!isCustom) {
    if (packageType === 3) mult = 0.80;
    else if (packageType === 6) mult = 0.90;
  }

  var productBudget = isQuoteMode ? 0 : Math.round(((totalBudget - 25) / 1.25) * 100) / 100;

  var NOT_PREFERRED = ["woodbridge","meiomi","robert mondavi private selection","cook's","cooks","simi","j. roget","caymus","cakebread","opus one","silver oak","far niente","duckhorn","stag's leap","stags leap"];
  var PREFERRED = ["moet & chandon","moet and chandon","dom perignon","veuve clicquot","krug","ruinart","mercier",
    "chandon","cloudy bay","terrazas","cape mentelle","newton vineyard","chateau d'yquem","chateau cheval blanc","colgin","joseph phelps",
    "hennessy","glenmorangie","ardbeg","belvedere","corona","modelo","pacifico","victoria",
    "robert mondavi winery","schrader","mount veeder","the prisoner","kim crawford","ruffino","sea smoke","lingua franca",
    "high west","nelson's green brier","casa noble","mi campo",
    "kendall-jackson","kendall jackson","la crema","cambria","carmel road","matanzas creek","murphy-goode","murphy goode","freemark abbey",
    "cardinale","lokoya","mt. brave","mt brave","gran moraine","bardstown bourbon","green river distilling"];

  function brandStatus(name) {
    var n = (name||"").toLowerCase();
    for (var i=0;i<NOT_PREFERRED.length;i++) if (n.indexOf(NOT_PREFERRED[i])>=0) return "other";
    for (var j=0;j<PREFERRED.length;j++) if (n.indexOf(PREFERRED[j])>=0) return "preferred";
    return "other";
  }
  function preferredLabel(name) {
    var n = (name||"").toLowerCase();
    for (var i=0;i<NOT_PREFERRED.length;i++) if (n.indexOf(NOT_PREFERRED[i])>=0) return "";
    for (var j=0;j<PREFERRED.length;j++) if (n.indexOf(PREFERRED[j])>=0) return PREFERRED[j];
    return "";
  }

  var MINI_WORDS = ["miniature","sample"," nip","airline"];
  function isMini(p) {
    var s = ((p.name||"")+" "+(p.sizeStr||"")).toLowerCase();
    for (var i=0;i<MINI_WORDS.length;i++) if (s.indexOf(MINI_WORDS[i])>=0) return true;
    if (/(^|[^a-z])mini([^a-z]|$)/.test(s)) return true;
    if (/(^|[^0-9])(50|100|200)\s?ml/.test(s)) return true;
    return false;
  }

  var RED_KW=["cabernet","merlot","pinot noir","malbec","syrah","shiraz","zinfandel","tempranillo","sangiovese","grenache","nebbiolo","mourvedre","petit verdot","carmenere","gamay","barbera","red blend","chianti","cotes du rhone","rioja","red wine","bordeaux","brunello","barolo","amarone","montepulciano"];
  var WHITE_KW=["sauvignon blanc","chardonnay","pinot grigio","pinot gris","riesling","moscato","muscat","viognier","gewurztraminer","albarino","chenin blanc","gruner","semillon","torrontes","white blend","chablis","white burgundy","sancerre","pouilly","white wine","vermentino","soave","gavi"];
  var SPARK_KW=["sparkling","champagne","prosecco","cava","brut","franciacorta","lambrusco","spumante","cremant","nectar imperial"];
  var NON_WINE=["vermouth","sake","port","sherry","rose","ros\u00e9"];
  var SPIRIT_KW={vodka:["vodka"],rum:["rum"],bourbon:["bourbon","whiskey","whisky"],gin:["gin"],tequila:["tequila"]};
  var ALL_SPIRIT_WORDS=["vodka","rum","bourbon","whiskey","whisky","gin","tequila","scotch","cognac","brandy","mezcal","liqueur"];

  function nameHasAny(name,kws) { var n=(name||"").toLowerCase(); for (var i=0;i<kws.length;i++) if (n.indexOf(kws[i])>=0) return true; return false; }
  function classifyOk(slotType,p) {
    var name=(p.name||"").toLowerCase();
    if (isMini(p)) return false;
    if (slotType==="red") return nameHasAny(name,RED_KW)&&!nameHasAny(name,WHITE_KW)&&!nameHasAny(name,SPARK_KW)&&!nameHasAny(name,NON_WINE)&&!nameHasAny(name,ALL_SPIRIT_WORDS)&&name.indexOf("beer")<0;
    if (slotType==="white") return nameHasAny(name,WHITE_KW)&&!nameHasAny(name,SPARK_KW)&&!nameHasAny(name,NON_WINE)&&!nameHasAny(name,ALL_SPIRIT_WORDS);
    if (slotType==="sparkling") return nameHasAny(name,SPARK_KW)&&!nameHasAny(name,NON_WINE)&&!nameHasAny(name,ALL_SPIRIT_WORDS);
    if (slotType==="beer") return !nameHasAny(name,ALL_SPIRIT_WORDS.concat(RED_KW).concat(WHITE_KW).concat(SPARK_KW));
    if (slotType==="seltzer") return name.indexOf("seltzer")>=0||name.indexOf("claw")>=0||name.indexOf("truly")>=0||name.indexOf("high noon")>=0;
    if (slotType==="nabeer") return name.indexOf("non alcoholic")>=0||name.indexOf("non-alcoholic")>=0||name.indexOf("0.0")>=0||name.indexOf("athletic")>=0||name.indexOf("na beer")>=0;
    if (SPIRIT_KW[slotType]) {
      if (!nameHasAny(name,SPIRIT_KW[slotType])) return false;
      for (var t in SPIRIT_KW) {
        if (t===slotType) continue;
        for (var k=0;k<SPIRIT_KW[t].length;k++) { var w=SPIRIT_KW[t][k]; if (SPIRIT_KW[slotType].indexOf(w)>=0) continue; if (name.indexOf(w)>=0) return false; }
      }
      return true;
    }
    return true;
  }

  // Strip trailing size/pack/volume wording from a search term before hitting the
  // catalog API — confirmed via direct testing that the search does literal text
  // matching against catalog product names, and shorthand size notation the customer
  // or LLM might naturally use ("750mL", "1L", "6 pack") does NOT match the catalog's
  // actual format ("750 ML", "1 L", "6x12 OZ Bottle"), silently returning zero results
  // for genuinely available products. Rather than trying to normalize every possible
  // shorthand to the exact right catalog format (error-prone — many unit/pack
  // conventions), stripping size wording entirely is simpler and was confirmed to work
  // just as reliably as an exactly-matching size in every case tested.
  function stripSizeFromSearchTerm(term) {
    return String(term || '')
      .replace(/\b\d+(\.\d+)?\s*m?[lL]\b/g, '')       // 750mL, 1L, 1.75L, 750 ml
      .replace(/\b\d+(\.\d+)?\s*(oz|OZ)\b/g, '')       // 12oz, 12 OZ
      .replace(/\b\d+\s*x\s*\d+\s*(oz|OZ|m?[lL])?\b/g, '') // 6x12, 24x12oz
      .replace(/\b(\d+[\s-]?)?pack\b/gi, '')             // 6 pack, 6-pack, pack
      .replace(/\bcase\s+of\b/gi, '')                     // case of
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  async function rawSearch(term) {
    var isZipSentinel = kitchenLocation.indexOf('zip:') === 0;
    var url = isZipSentinel
      ? "https://api.getbevvi.com/api/corpproducts/searchCorpProducts?zipcode="+encodeURIComponent(kitchenLocation.slice(4))+"&searchBy="+encodeURIComponent(term)+"&limit=100&client="+encodeURIComponent(clientName)
      : "https://api.getbevvi.com/api/corpproducts/searchCorpProducts?location="+encodeURIComponent(kitchenLocation)+"&searchBy="+encodeURIComponent(term)+"&limit=100&client="+encodeURIComponent(clientName);
    var res=await fetch(url);
    if (!res.ok) return [];
    var data=await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(function(p) {
      var price=p.salePrice||p.price||0;
      var sizeStr=p.size&&p.units?String(p.size)+String(p.units):"";
      var purl=p.url?p.url:(p.slug?"https://airculinaire.getbevvi.com/productdetail/"+p.slug:"");
      var pid=(p.corpProductFilter&&p.corpProductFilter.corpProductId)||p.id||"";
      return {name:p.name||"",price:parseFloat(price)||0,sizeStr:sizeStr,url:purl,product_id:pid,upc:p.upc||p.origanlUpc||"",establishmentId:p.establishmentId||""};
    }).filter(function(p){return p.price>0&&p.name;});
  }

  // Strip accented characters (ò, ä, é, etc.) to their plain ASCII equivalents —
  // confirmed via direct testing that the catalog's exact-match search fails when
  // the search term has a diacritic the specific catalog entry doesn't (e.g.
  // "Espolòn" with the accent found nothing, while "Espolon" without it matched
  // immediately) — real catalog data is inconsistent about which entries carry
  // accents at all, so stripping them from the search term is the reliable fix.
  function stripDiacritics(term) {
    return String(term || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // Expand common colloquial brand nicknames to their formal catalog name — confirmed
  // via direct testing that "Sam Adams" (how most people naturally refer to the brand)
  // returns nothing, while "Samuel Adams" (the catalog's formal name) matches. Substring
  // replacement (not exact-match), since the nickname is usually embedded within a
  // longer product name ("Sam Adams Summer Ale"), not the whole search term.
  var BRAND_NICKNAMES = [
    [/\bsam\s+adams\b/i, 'Samuel Adams']
  ];
  function expandBrandNicknames(term) {
    var result = String(term || '');
    BRAND_NICKNAMES.forEach(function(pair) { result = result.replace(pair[0], pair[1]); });
    return result;
  }

  // Generalized fuzzy fallback — a last resort when NO exact-match retry (original,
  // size-stripped, diacritic-stripped, brand-nickname-expanded, combined) found
  // anything at all. Rather than maintaining an ever-growing hardcoded list of every
  // brand nickname/abbreviation/misspelling we happen to encounter (Sam/Samuel Adams,
  // Jack/Jack Daniel's, etc.), this searches broadly using just the first significant
  // word (usually the brand), then scores every candidate's name against the cleaned
  // search term using token overlap (same scoring formula already used elsewhere in
  // this codebase for low_confidence_match detection), keeping only genuinely close
  // matches above a confidence threshold — generalizes to any brand-naming mismatch
  // without needing to know about it in advance.
  function tokenOverlapScore(a, b) {
    var norm = function(s) { return (s || '').toLowerCase().replace(/[^a-z0-9%.\s]/g, ' ').split(/\s+/).filter(Boolean); };
    var ta = {}; norm(a).forEach(function(t){ ta[t] = true; });
    var tbArr = norm(b);
    var taSize = Object.keys(ta).length;
    if (taSize === 0 || tbArr.length === 0) return 0;
    var tb = {}; tbArr.forEach(function(t){ tb[t] = true; });
    var tbSize = Object.keys(tb).length;
    var overlap = 0;
    for (var t in ta) if (tb[t]) overlap++;
    return overlap / Math.min(taSize, tbSize);
  }
  var FUZZY_MATCH_THRESHOLD = 0.5; // at least half the smaller token set must overlap

  function scoreCandidates(cleanedTerm, candidates, excludeWord) {
    var termForScoring = cleanedTerm;
    if (excludeWord) {
      termForScoring = cleanedTerm.replace(new RegExp('\\b' + excludeWord + '\\b', 'gi'), '').trim();
    }
    return candidates
      .map(function(p) {
        var nameForScoring = excludeWord ? p.name.replace(new RegExp('\\b' + excludeWord + '\\b', 'gi'), '').trim() : p.name;
        return { product: p, score: tokenOverlapScore(termForScoring, nameForScoring) };
      })
      .filter(function(s) { return s.score >= FUZZY_MATCH_THRESHOLD; })
      .sort(function(a, b) { return b.score - a.score; });
  }

  // Coarse category fields ("spirits"/"wine"/"beer") aren't searchable text — no
  // product is literally named "spirits". Extract the SPECIFIC type keyword actually
  // present in the term itself (vodka, gin, whiskey, etc.) to use as a real, searchable
  // broadening term instead.
  var TYPE_KEYWORDS = [
    'vodka', 'gin', 'rum', 'tequila', 'whiskey', 'whisky', 'bourbon', 'scotch',
    'cognac', 'brandy', 'liqueur', 'wine', 'beer', 'seltzer', 'champagne', 'cider'
  ];
  function extractTypeKeyword(term) {
    var lower = String(term || '').toLowerCase();
    for (var i = 0; i < TYPE_KEYWORDS.length; i++) {
      if (new RegExp('\\b' + TYPE_KEYWORDS[i] + '\\b').test(lower)) return TYPE_KEYWORDS[i];
    }
    return null;
  }

  async function fuzzyFallbackSearch(cleanedTerm, category) {
    var words = cleanedTerm.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    // Tier 1: broad search on just the first word (usually the brand name) — helps
    // when the brand word itself is correct but other words in the query are wrong.
    var broadResults = await rawSearch(words[0]);
    if (broadResults.length > 0) {
      var scored = scoreCandidates(cleanedTerm, broadResults, null);
      if (scored.length > 0) {
        console.log('[doSearch] fuzzy fallback (brand-word broad search) matched:', JSON.stringify(cleanedTerm), '->', scored.map(function(s){return s.product.name + ' (' + s.score.toFixed(2) + ')';}).join(', '));
        return scored.map(function(s) { return s.product; });
      }
    }

    // Tier 2: if the brand word itself might be misspelled (tier 1 found nothing at
    // all — the API requires exact token spelling, so no query variation of a
    // misspelled word will ever match), broaden using the SPECIFIC type keyword
    // actually present in the term (e.g. "vodka" extracted from "Absolute Vodka") —
    // NOT the coarse category bucket ("spirits"), which isn't literal searchable text
    // and returns nothing. The type keyword is excluded from scoring on both sides —
    // otherwise every candidate of that type would share the word and inflate scores
    // regardless of actual relevance.
    var typeKeyword = extractTypeKeyword(cleanedTerm) || (category && TYPE_KEYWORDS.indexOf(String(category).toLowerCase()) >= 0 ? category : null);
    if (typeKeyword) {
      var categoryResults = await rawSearch(typeKeyword);
      if (categoryResults.length > 0) {
        var categoryScored = scoreCandidates(cleanedTerm, categoryResults, typeKeyword);
        if (categoryScored.length > 0) {
          console.log('[doSearch] fuzzy fallback (type-keyword broad search) matched:', JSON.stringify(cleanedTerm), '->', categoryScored.map(function(s){return s.product.name + ' (' + s.score.toFixed(2) + ')';}).join(', '));
          return categoryScored.map(function(s) { return s.product; });
        }
      }
    }

    return [];
  }

  // Generalized fuzzy fallback — a last resort when NO exact-match retry (original,
  // size-stripped, diacritic-stripped, brand-nickname-expanded, combined) found
  // anything at all. Rather than maintaining an ever-growing hardcoded list of every
  // brand nickname/abbreviation/misspelling we happen to encounter (Sam/Samuel Adams,
  // Jack/Jack Daniel's, etc.), this searches broadly using just the first significant
  // word (usually the brand), then scores every candidate's name against the cleaned
  // search term using token overlap (same scoring formula already used elsewhere in
  // this codebase for low_confidence_match detection), keeping only genuinely close
  // matches above a confidence threshold — generalizes to any brand-naming mismatch
  // without needing to know about it in advance.
  function tokenOverlapScore(a, b) {
    var norm = function(s) { return (s || '').toLowerCase().replace(/[^a-z0-9%.\s]/g, ' ').split(/\s+/).filter(Boolean); };
    var ta = {}; norm(a).forEach(function(t){ ta[t] = true; });
    var tbArr = norm(b);
    var taSize = Object.keys(ta).length;
    if (taSize === 0 || tbArr.length === 0) return 0;
    var tb = {}; tbArr.forEach(function(t){ tb[t] = true; });
    var tbSize = Object.keys(tb).length;
    var overlap = 0;
    for (var t in ta) if (tb[t]) overlap++;
    return overlap / Math.min(taSize, tbSize);
  }
  var FUZZY_MATCH_THRESHOLD = 0.5; // at least half the smaller token set must overlap

  function scoreCandidates(cleanedTerm, candidates, excludeWord) {
    var termForScoring = cleanedTerm;
    if (excludeWord) {
      termForScoring = cleanedTerm.replace(new RegExp('\\b' + excludeWord + '\\b', 'gi'), '').trim();
    }
    return candidates
      .map(function(p) {
        var nameForScoring = excludeWord ? p.name.replace(new RegExp('\\b' + excludeWord + '\\b', 'gi'), '').trim() : p.name;
        return { product: p, score: tokenOverlapScore(termForScoring, nameForScoring) };
      })
      .filter(function(s) { return s.score >= FUZZY_MATCH_THRESHOLD; })
      .sort(function(a, b) { return b.score - a.score; });
  }

  // Coarse category fields ("spirits"/"wine"/"beer") aren't searchable text — no
  // product is literally named "spirits". Extract the SPECIFIC type keyword actually
  // present in the term itself (vodka, gin, whiskey, etc.) to use as a real, searchable
  // broadening term instead.
  var TYPE_KEYWORDS = [
    'vodka', 'gin', 'rum', 'tequila', 'whiskey', 'whisky', 'bourbon', 'scotch',
    'cognac', 'brandy', 'liqueur', 'wine', 'beer', 'seltzer', 'champagne', 'cider'
  ];
  function extractTypeKeyword(term) {
    var lower = String(term || '').toLowerCase();
    for (var i = 0; i < TYPE_KEYWORDS.length; i++) {
      if (new RegExp('\\b' + TYPE_KEYWORDS[i] + '\\b').test(lower)) return TYPE_KEYWORDS[i];
    }
    return null;
  }

  async function fuzzyFallbackSearch(cleanedTerm, category) {
    var words = cleanedTerm.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    // Tier 1: broad search on just the first word (usually the brand name) — helps
    // when the brand word itself is correct but other words in the query are wrong.
    var broadResults = await rawSearch(words[0]);
    if (broadResults.length > 0) {
      var scored = scoreCandidates(cleanedTerm, broadResults, null);
      if (scored.length > 0) {
        console.log('[doSearch] fuzzy fallback (brand-word broad search) matched:', JSON.stringify(cleanedTerm), '->', scored.map(function(s){return s.product.name + ' (' + s.score.toFixed(2) + ')';}).join(', '));
        return scored.map(function(s) { return s.product; });
      }
    }

    // Tier 2: if the brand word itself might be misspelled (tier 1 found nothing at
    // all — the API requires exact token spelling, so no query variation of a
    // misspelled word will ever match), broaden using the SPECIFIC type keyword
    // actually present in the term (e.g. "vodka" extracted from "Absolute Vodka") —
    // NOT the coarse category bucket ("spirits"), which isn't literal searchable text
    // and returns nothing. The type keyword is excluded from scoring on both sides —
    // otherwise every candidate of that type would share the word and inflate scores
    // regardless of actual relevance.
    var typeKeyword = extractTypeKeyword(cleanedTerm) || (category && TYPE_KEYWORDS.indexOf(String(category).toLowerCase()) >= 0 ? category : null);
    if (typeKeyword) {
      var categoryResults = await rawSearch(typeKeyword);
      if (categoryResults.length > 0) {
        var categoryScored = scoreCandidates(cleanedTerm, categoryResults, typeKeyword);
        if (categoryScored.length > 0) {
          console.log('[doSearch] fuzzy fallback (type-keyword broad search) matched:', JSON.stringify(cleanedTerm), '->', categoryScored.map(function(s){return s.product.name + ' (' + s.score.toFixed(2) + ')';}).join(', '));
          return categoryScored.map(function(s) { return s.product; });
        }
      }
    }

    return [];
  }

  // Extract a requested size like "1 L", "750mL", "1.75 L" from a raw search term,
  // normalized to a comparable form (digits + unit, no space/case sensitivity) —
  // used to verify a retry step's results actually match what was asked for, not
  // just that SOME product came back. This is what catches the case where a
  // size-stripped-but-still-accented retry "succeeds" by matching a narrower,
  // wrong-size catalog entry, instead of continuing on to a broader retry that
  // would have found the actually-requested size.
  function extractRequestedSize(term) {
    var m = String(term || '').match(/\b(\d+(\.\d+)?)\s*(m?l|oz)\b/i);
    if (!m) return null;
    return (m[1] + m[3]).toLowerCase().replace(/\s+/g, '');
  }
  function normalizeSizeStr(sizeStr) {
    return String(sizeStr || '').toLowerCase().replace(/\s+/g, '');
  }
  function resultsMatchRequestedSize(results, requestedSize) {
    if (!requestedSize) return true; // no specific size was requested — anything counts
    return results.some(function(p) { return normalizeSizeStr(p.sizeStr).indexOf(requestedSize) >= 0; });
  }

  async function doSearch(term, searchCategory) {
    try {
      // Expand any colloquial brand nickname to the catalog's formal name up front —
      // safe no-op if absent, fixes the search immediately if present (e.g. "Sam
      // Adams" -> "Samuel Adams"), before any size/diacritic retry logic runs.
      term = expandBrandNicknames(term);
      var requestedSize = extractRequestedSize(term);
      var bestSoFar = [];

      // Try the term exactly as given first — this preserves precise size-matching
      // when the format happens to be correct (e.g. "Angel's Envy Bourbon 750 ML").
      var results = await rawSearch(term);
      if (results.length > 0) {
        bestSoFar = results;
        if (resultsMatchRequestedSize(results, requestedSize)) return results;
      }

      // Size-stripped retry — confirmed via direct testing that shorthand size
      // notation ("750mL", "1L", "6 pack") does NOT match the catalog's actual
      // format and silently returns zero results even for genuinely available
      // products. Only accept this result immediately if it actually contains the
      // requested size (or none was requested) — otherwise keep it as a fallback
      // candidate but keep trying broader retries, since a "successful" match here
      // can still be the WRONG size if the still-accented term matches a narrower,
      // different catalog subset than a fully-cleaned search would.
      var cleanTerm = stripSizeFromSearchTerm(term);
      if (cleanTerm && cleanTerm !== term) {
        var fallbackResults = await rawSearch(cleanTerm);
        if (fallbackResults.length > 0) {
          if (bestSoFar.length === 0) bestSoFar = fallbackResults;
          if (resultsMatchRequestedSize(fallbackResults, requestedSize)) {
            console.log('[doSearch] size-stripped retry succeeded (size match):', JSON.stringify(term), '->', JSON.stringify(cleanTerm));
            return fallbackResults;
          }
        }
      }

      // Diacritic-stripped retry — confirmed via direct testing that accented
      // characters ("Espolòn") don't match catalog entries stored without the
      // accent, and the catalog is inconsistent about which entries carry accents.
      var diacriticTerm = stripDiacritics(term);
      if (diacriticTerm && diacriticTerm !== term) {
        var diacriticResults = await rawSearch(diacriticTerm);
        if (diacriticResults.length > 0) {
          if (bestSoFar.length === 0) bestSoFar = diacriticResults;
          if (resultsMatchRequestedSize(diacriticResults, requestedSize)) {
            console.log('[doSearch] diacritic-stripped retry succeeded (size match):', JSON.stringify(term), '->', JSON.stringify(diacriticTerm));
            return diacriticResults;
          }
        }
        // Both fixes combined — broadest retry, most likely to surface the full
        // candidate set (all sizes, no accent) if a term has both issues at once.
        var bothStrippedTerm = stripSizeFromSearchTerm(diacriticTerm);
        if (bothStrippedTerm && bothStrippedTerm !== diacriticTerm) {
          var bothResults = await rawSearch(bothStrippedTerm);
          if (bothResults.length > 0) {
            if (resultsMatchRequestedSize(bothResults, requestedSize)) {
              console.log('[doSearch] size+diacritic-stripped retry succeeded (size match):', JSON.stringify(term), '->', JSON.stringify(bothStrippedTerm));
              return bothResults;
            }
            // Even without an exact size match, the broadest search is the best
            // candidate set to fall back to — it has the most complete results.
            bestSoFar = bothResults;
          }
        }
      }

      // If NOTHING at all was found by any exact-match retry, try the generalized
      // fuzzy fallback before giving up entirely — catches brand-naming mismatches
      // we haven't seen before, without needing to hardcode each one.
      if (bestSoFar.length === 0) {
        var fuzzyResults = await fuzzyFallbackSearch(stripSizeFromSearchTerm(stripDiacritics(term)) || term, searchCategory);
        if (fuzzyResults.length > 0) return fuzzyResults;
      }

      // If NOTHING at all was found by any exact-match retry, try the generalized
      // fuzzy fallback before giving up entirely — catches brand-naming mismatches
      // we haven't seen before, without needing to hardcode each one.
      if (bestSoFar.length === 0) {
        var fuzzyResults = await fuzzyFallbackSearch(stripSizeFromSearchTerm(stripDiacritics(term)) || term, searchCategory);
        if (fuzzyResults.length > 0) return fuzzyResults;
      }

      // No retry step found an exact size match — return the best (most complete)
      // candidate set found so far rather than nothing, so the item still shows up
      // even if the specific size isn't available (existing size-substitution/
      // "closest available" messaging in the prompt handles telling the customer).
      return bestSoFar;
    } catch(e){return [];}
  }

  function pick(cands,slotType,targetPrice,minP,maxP,totalQty,maxUnique,allowedBrands) {
    var pool=cands.filter(function(p){
      var ok = classifyOk(slotType,p)&&p.price<=(maxP||999999)&&p.price>=(minP||0);
      if (ok && allowedBrands && allowedBrands.length > 0) {
        var nmB=(p.name||"").toLowerCase();
        ok = allowedBrands.some(function(b){ return nmB.indexOf(String(b).toLowerCase()) >= 0; });
      }
      return ok;
    });
    if (pool.length===0) return [];
    var steps=[0.50,0.35,0.20,0];
    var chosenPool=null;
    for (var s=0;s<steps.length;s++) {
      var floor=Math.max(minP||0,(targetPrice||0)*steps[s]);
      var sub=pool.filter(function(p){return p.price>=floor;});
      if (sub.length>0){chosenPool=sub;break;}
    }
    if (!chosenPool) chosenPool=pool;
    // Priority: 1) Price (closest to target) 2) Sponsored brand 3) Preferred brand
    const SPONSORED_PARENTS = ['LVMH','Constellation Brands','Breckenridge Distillery'];
    const BRAND_KEYWORD_MAP = {
      'veuve clicquot':'LVMH','moet':'LVMH','moët':'LVMH','dom perignon':'LVMH','hennessy':'LVMH','belvedere':'LVMH','krug':'LVMH','armand de brignac':'LVMH','chandon':'LVMH',
      'corona':'Constellation Brands','modelo':'Constellation Brands','robert mondavi':'Constellation Brands','kim crawford':'Constellation Brands','meiomi':'Constellation Brands','prisoner':'Constellation Brands','svedka':'Constellation Brands','high west':'Constellation Brands','mi campo':'Constellation Brands','ruffino':'Constellation Brands','woodbridge':'Constellation Brands',
      'breckenridge':'Breckenridge Distillery'
    };
    function isSponsoredProduct(p) {
      const name = (p.name || '').toLowerCase();
      const pb = (p.parentBrand || '').toLowerCase();
      const bi = (p.brandInfo || '').toLowerCase();
      for (const kw of Object.keys(BRAND_KEYWORD_MAP)) {
        if (name.includes(kw) || pb.includes(kw) || bi.includes(kw)) return true;
      }
      return false;
    }
    chosenPool.sort(function(a,b){
      // 1) Price proximity to target (within 20% tolerance = same tier)
      const tgt = targetPrice || 0;
      const aTier = tgt > 0 ? Math.floor(a.price / (tgt * 0.2)) : 0;
      const bTier = tgt > 0 ? Math.floor(b.price / (tgt * 0.2)) : 0;
      if (aTier !== bTier) return bTier - aTier; // higher price tier first
      // 2) Sponsored brand
      const aSponsored = isSponsoredProduct(a) ? 1 : 0;
      const bSponsored = isSponsoredProduct(b) ? 1 : 0;
      if (aSponsored !== bSponsored) return bSponsored - aSponsored;
      // 3) Preferred brand from order/swap history
      const pa = brandStatus(a.name) === 'preferred' ? 1 : 0;
      const pb2 = brandStatus(b.name) === 'preferred' ? 1 : 0;
      if (pa !== pb2) return pb2 - pa;
      // 4) Tiebreak: higher price
      return b.price - a.price;
    });
    var seen={};var uniq=[];
    for (var i=0;i<chosenPool.length&&uniq.length<(maxUnique||2);i++) {
      var key=chosenPool[i].name.toLowerCase();
      if (!seen[key]){seen[key]=1;uniq.push(chosenPool[i]);}
    }
    var out=[];var remaining=totalQty;
    for (var j=0;j<uniq.length;j++) {
      var share=(j===uniq.length-1)?remaining:Math.ceil(totalQty/uniq.length);
      if (share>remaining) share=remaining;
      if (share<=0) break;
      out.push({product:uniq[j],qty:share});
      remaining-=share;
    }
    return out;
  }

  var lineItems=[];var unavailable=[];var summaryBits=[];var totalDrinks=0;

  function addLines(picks,label,category) {
    if (picks.length===0){unavailable.push(label);return;}
    for (var i=0;i<picks.length;i++) {
      var finalQty = picks[i].qty;
      // Beer quantity was computed assuming a generic beerPackSize (default 12
      // cans/bottles per case), BEFORE the actual product was selected — real
      // beer products come in varying pack sizes (12, 18, 24, 30, 36...). If we
      // don't rescale, a product that's actually packaged in 24s gets the same
      // "qty" that was meant for 12s, silently doubling the real can/bottle
      // count delivered vs. what totalDrinks/beerDrinks actually called for.
      if (category === 'beer' || category === 'seltzer') {
        var sizeStr = picks[i].product.sizeStr || '';
        var packMatch = sizeStr.match(/^(\d+)\s*x/i);
        var realPackSize = packMatch ? parseInt(packMatch[1]) : null;
        if (realPackSize && realPackSize > 0 && realPackSize !== beerPackSize) {
          var impliedDrinks = picks[i].qty * beerPackSize;
          finalQty = Math.max(1, Math.ceil(impliedDrinks / realPackSize));
        }
      }
      lineItems.push({label:label,name:picks[i].product.name,qty:finalQty,upc:picks[i].product.upc||'',
        price:picks[i].product.price,size:picks[i].product.sizeStr,
        url:picks[i].product.url,product_id:picks[i].product.product_id,category:category});
    }
  }

  if (isCustom) {
    // MIXER category: cocktail mixers (lime juice, bitters, ginger beer, tonic...) are
    // now accepted. Previously any non wine/beer/spirits category hard-failed
    // ("Unknown category"), so the LLM learned to drop mixers entirely and cocktails
    // shipped incomplete (Margarita with no lime, Old Fashioned with no bitters).
    // Mixers are deliberately kept OUT of the drink-share allocation (they aren't
    // drinks) and sized on their own rule at push time.
    var byCat={wine:[],beer:[],spirits:[],mixer:[]};
    for (var i=0;i<namedProducts.length;i++) {
      var cat=(namedProducts[i].category||"").toLowerCase();
      if (cat==="mixers") cat="mixer";
      if (byCat[cat]) byCat[cat].push(namedProducts[i]);
      else return fail("Unknown category: "+namedProducts[i].name);
    }
    var cmult=1.0;
    if (byCat.wine.length>0&&byCat.beer.length===0&&byCat.spirits.length===0) cmult=0.80;
    else if (byCat.wine.length>0&&byCat.spirits.length>0&&byCat.beer.length===0) cmult=0.90;
    totalDrinks=Math.round(guests*baseDpp*cmult);
    // Allocation fix (real bug from a live 150-guest event): this path used to split
    // drinks EVENLY across represented categories (1/3 each), while menu_build uses the
    // learned split (62% wine / 32% spirits / 5% beer). The same event therefore sized
    // 26 wine bottles via menu_build but only 10 via custom_list — two calculators, two
    // answers. Align custom_list to the learned split so both paths agree.
    // BUT the learned 5% beer share reflects wine-heavy corporate orders and gives ~1
    // case for 150 people when the customer explicitly asked for beer — clearly wrong.
    // So: learned split as the base, then floor every explicitly-requested category at
    // CATEGORY_FLOOR (20%, per business judgment), then renormalize to sum to 1.
    var CATEGORY_FLOOR=0.20;
    var baseSplit={wine:0.62,spirits:0.32,beer:0.05};
    var catShare={};
    var shareSum=0;
    ['wine','spirits','beer'].forEach(function(c){
      if(byCat[c].length>0){
        catShare[c]=Math.max(baseSplit[c],CATEGORY_FLOOR);
        shareSum+=catShare[c];
      }
    });
    if(shareSum>0){ Object.keys(catShare).forEach(function(c){ catShare[c]=catShare[c]/shareSum; }); }
    console.log('[buildPackage] custom_list category shares (learned split + '+(CATEGORY_FLOOR*100)+'% floor):', JSON.stringify(catShare));
    var repCats=(byCat.wine.length?1:0)+(byCat.beer.length?1:0)+(byCat.spirits.length?1:0);
    var drinksPerCat=repCats?totalDrinks/repCats:0; // legacy fallback, superseded below per-category
    // Build search terms with variations for each product
    async function doSearchWithFallbacks(name, category) {
      // Try original name first
      var results = await doSearch(name, category);
      if (results.length > 0) return results;
      // Try without apostrophes and special chars
      var simplified = name.replace(/[''']/g, '').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (simplified !== name) {
        results = await doSearch(simplified);
        if (results.length > 0) return results;
      }
      // Try first 2-3 words only
      var words = name.split(' ');
      if (words.length > 2) {
        results = await doSearch(words.slice(0, 2).join(' '));
        if (results.length > 0) return results;
      }
      // Try brand name only (first word)
      if (words.length > 1) {
        results = await doSearch(words[0]);
        if (results.length > 0) return results;
      }
      // Try common name corrections
      var corrections = {
        'titos': "tito's", 'titos vodka': "tito's", 'makers mark': "maker's mark",
        'baileys': "bailey's", 'hendricks': "hendrick's", 'mcallans': "macallan",
        'clase azul': 'clase azul', 'don julio': 'don julio'
      };
      var lower = name.toLowerCase().trim();
      if (corrections[lower]) {
        results = await doSearch(corrections[lower]);
      }
      return results;
    }
    var results=await Promise.all(namedProducts.map(function(np){return doSearchWithFallbacks(np.name, np.category);}));
    for (var n=0;n<namedProducts.length;n++) {
      var np=namedProducts[n];
      var catN=(np.category||"").toLowerCase();
      var found=results[n].filter(function(p){return !isMini(p);});
      if (found.length===0){unavailable.push(np.name);continue;}
      var capMin=0,capMax=0;
      if (catN==="wine"){capMin=capWineMin;capMax=capWineMax;}
      else if (catN==="beer"){capMin=capBeerMin;capMax=capBeerMax;}
      else if (catN==="spirits"){capMin=capSpiritMin;capMax=capSpiritMax;}
      if (capMin||capMax) {
        var inRange=found.filter(function(p){return p.price>=(capMin||0)&&p.price<=(capMax||999999);});
        if (inRange.length>0) found=inRange;
        else{unavailable.push(np.name+" (none within caps)");continue;}
      }
      var terms=np.name.toLowerCase().split(/\s+/);
      found.sort(function(a,b) {
        function score(x){var s=0;var ln=x.name.toLowerCase();for(var t=0;t<terms.length;t++) if(ln.indexOf(terms[t])>=0) s++;return s;}
        var d=score(b)-score(a);if(d) return d;
        var pa=brandStatus(a.name)==="preferred"?1:0;
        var pb2=brandStatus(b.name)==="preferred"?1:0;
        if(pa!==pb2) return pb2-pa;
        return b.price-a.price;
      });
      var best=found[0];
      // Real bug found tonight: when a requested size ("New Amsterdam Gin 750 mL")
      // isn't available and search returns a DIFFERENT size instead (e.g. 1.75L), that
      // wrong-size item was silently added to the basket, and the "size mismatch, want
      // a different size/brand?" flagging was purely the LLM noticing it in raw search
      // results and mentioning it in text — with NO structured backend signal, meaning
      // a confirmed size-substitute choice (e.g. "yes find a 750mL gin instead" ->
      // customer picks Bombay) never got persisted the same way an unavailable-item
      // substitute does, leaving the order-confirmation loop bug from earlier tonight
      // effectively unfixed for this specific trigger. Fix: treat a genuine size
      // mismatch exactly like "not found" — push to the same `unavailable` array
      // (reusing the entire already-built and verified pendingSubstitutes -> search ->
      // merge pipeline) instead of silently adding the wrong-size item to the basket.
      var requestedSizeMatch = np.name.match(/\d+(\.\d+)?\s*(mL|ML|L|oz|OZ)\b/i);
      if (requestedSizeMatch && best.sizeStr) {
        var reqSizeNorm = requestedSizeMatch[0].toLowerCase().replace(/\s+/g, '');
        var foundSizeNorm = String(best.sizeStr).toLowerCase().replace(/\s+/g, '');
        if (reqSizeNorm !== foundSizeNorm) {
          unavailable.push(np.name);
          continue;
        }
      }
      var dpu=catN==="wine"?5:catN==="spirits"?16:(parseInt(np.pack_size)||beerPackSize);
      // Use the blended per-category share (learned split + floor) instead of the
      // legacy even split, so this path agrees with menu_build.
      var catDrinks=(catShare[catN]!==undefined)?totalDrinks*catShare[catN]:drinksPerCat;
      var perProd=catDrinks/byCat[catN].length;
      // Option C fix (real bug from a live 150-guest event): the LLM was passing
      // INVENTED qty values the customer never stated (8, 6, 13...), and any supplied
      // qty bypassed the calculator entirely — so a package the calculator would size
      // at ~54 wine bottles shipped with 14. A customer-stated qty ("3 bottles of Grey
      // Goose") must still be honored, so the fix distinguishes the two: only honor
      // np.qty when qty_from_customer is explicitly true. The flag defaults to false,
      // so if the LLM forgets it (the common failure) the calculator runs — the safe
      // outcome. Log every override so invented quantities are visible in the logs.
      var qtyFromCustomer = np.qty_from_customer === true || np.qty_from_customer === 'true';
      var hasExplicitQty = qtyFromCustomer && np.qty && parseInt(np.qty) > 0;
      var computedQty = Math.max(1,Math.ceil(perProd/dpu));
      if (catN==="mixer") {
        // Mixer sizing: tied to the cocktail spirit volume, not the drink share.
        // Bitters: ~1 bottle per 60 cocktails (dashes). Juice/soda/tonic: ~1 bottle
        // per 15 cocktails (~750ml serves ~15). Cocktail count ≈ the spirits' share.
        var cocktailDrinksM=Math.round(totalDrinks*(catShare.spirits||0.28));
        var nm=String(np.name||'').toLowerCase();
        var isBitters=/bitter|amaro|vermouth/.test(nm);
        computedQty=Math.max(1,Math.ceil(cocktailDrinksM/(isBitters?60:15)));
      }
      if (np.qty && parseInt(np.qty) > 0 && !qtyFromCustomer) {
        console.log('[buildPackage] qty override: LLM supplied qty', np.qty, 'for', JSON.stringify(np.name), 'without qty_from_customer — using calculator value', computedQty);
      }
      var qty=hasExplicitQty ? parseInt(np.qty) : computedQty;
      var n2=Math.max(1,byCat[catN].length);
      var cap2=catN==="wine"?Math.max(1,Math.ceil((guests*baseDpp*0.6)/n2)):catN==="beer"?Math.max(1,Math.ceil((guests*baseDpp*0.5)/n2)):Math.max(1,Math.ceil((guests/10+1)/n2));
      if(!hasExplicitQty && catN!=="mixer" && qty>cap2) qty=cap2;
      lineItems.push({label:np.name,name:best.name,qty:qty,price:best.price,size:best.sizeStr,url:best.url,product_id:best.product_id,upc:best.upc||"",establishmentId:best.establishmentId||"",category:catN});
    }
    var durationLabel = hours > 0 ? (hours+"h") : (baseDpp+" drinks/person");
    summaryBits.push("CUSTOM | "+guests+" guests | "+durationLabel+" | "+(isQuoteMode?"QUOTE":"$"+totalBudget));
  } else if (isSplit) {
    // Customer-driven category percentages (e.g. "20% wine, 30% beer, 50% hard
    // seltzer") with optional per-category brand allowlists (e.g. red wine =
    // Cabernet or Pinot Noir only) and direct per-unit price targets/caps,
    // instead of a fixed total budget. category_splits keys: wine, beer,
    // hard_seltzer (or seltzer), spirits. category_brands keys: red, white,
    // beer, seltzer (or hard_seltzer), spirits — each an array of allowed
    // brand/varietal keywords; omit for "any product in that category".
    var categorySplits={};
    try { categorySplits=JSON.parse(iv.category_splits||"{}"); } catch(e){}
    var categoryBrands={};
    try { categoryBrands=JSON.parse(iv.category_brands||"{}"); } catch(e){}
    var splitSum=0;
    for (var ckKey in categorySplits) splitSum+=(parseFloat(categorySplits[ckKey])||0);
    if (splitSum<=0) return fail('category_splits required (e.g. {"wine":0.2,"beer":0.3,"hard_seltzer":0.5}) and must sum to a positive value for package_type=SPLIT');
    var normSplits={};
    for (var ckKey2 in categorySplits) normSplits[ckKey2]=(parseFloat(categorySplits[ckKey2])||0)/splitSum;

    // Critical: totalDrinks was declared as 0 at the top of buildPackage and
    // only ever assigned inside the OTHER branches (CUSTOM / standard) — must
    // set it here too before deriving per-category drink counts from it, or
    // every category silently computes against zero.
    totalDrinks=Math.round(guests*baseDpp);

    var wineTargetInput=parseFloat(iv.wine_price_target)||0;
    var beerMaxInput=parseFloat(iv.beer_max_price)||capBeerMax||0;
    var seltzerMaxInput=parseFloat(iv.seltzer_max_price)||beerMaxInput||0;

    var winePct=normSplits.wine||0;
    var beerPct=normSplits.beer||0;
    var seltzerPct=normSplits.hard_seltzer||normSplits.seltzer||0;
    var spiritPctS=normSplits.spirits||0;

    var planS=[];

    if (winePct>0) {
      var wineDrinksS=Math.round(totalDrinks*winePct);
      var wineBottlesS=Math.max(1,Math.ceil(wineDrinksS/5));
      var redRatioS=(categoryBrands.red_ratio!==undefined)?parseFloat(categoryBrands.red_ratio):0.5;
      var redBottlesS=Math.round(wineBottlesS*redRatioS);
      var whiteBottlesS=wineBottlesS-redBottlesS;
      var redBrandsS=categoryBrands.red||[];
      var whiteBrandsS=categoryBrands.white||[];
      var wMinS=wineTargetInput?wineTargetInput*0.5:0;
      var wMaxS=wineTargetInput?wineTargetInput*1.5:999999;
      if (redBottlesS>0) planS.push({term:"Red Wine",slot:"red",qty:redBottlesS,target:wineTargetInput,min:wMinS,max:wMaxS,label:"Red Wine",cat:"wine",uniq:Math.max(1,redBrandsS.length||2),brands:redBrandsS});
      if (whiteBottlesS>0) planS.push({term:"White Wine",slot:"white",qty:whiteBottlesS,target:wineTargetInput,min:wMinS,max:wMaxS,label:"White Wine",cat:"wine",uniq:Math.max(1,whiteBrandsS.length||2),brands:whiteBrandsS});
    }

    if (beerPct>0) {
      var beerDrinksS=Math.round(totalDrinks*beerPct);
      var beerCasesS=Math.max(1,Math.ceil(beerDrinksS/beerPackSize));
      var beerBrandsS=categoryBrands.beer||[];
      planS.push({term:"Beer",slot:"beer",qty:beerCasesS,target:beerMaxInput||0,min:0,max:beerMaxInput||999999,label:"Beer",cat:"beer",uniq:Math.max(1,beerBrandsS.length||2),brands:beerBrandsS});
    }

    if (seltzerPct>0) {
      var seltzerDrinksS=Math.round(totalDrinks*seltzerPct);
      var seltzerCasesS=Math.max(1,Math.ceil(seltzerDrinksS/beerPackSize));
      var seltzerBrandsS=categoryBrands.seltzer||categoryBrands.hard_seltzer||[];
      planS.push({term:"Hard Seltzer",slot:"seltzer",qty:seltzerCasesS,target:seltzerMaxInput||0,min:0,max:seltzerMaxInput||999999,label:"Hard Seltzer",cat:"seltzer",uniq:Math.max(1,seltzerBrandsS.length||2),brands:seltzerBrandsS});
    }

    if (spiritPctS>0) {
      var spiritDrinksS=Math.round(totalDrinks*spiritPctS);
      var spiritBottlesS=Math.max(1,Math.ceil(spiritDrinksS/16));
      var spiritBrandsS=categoryBrands.spirits||[];
      planS.push({term:"Spirits",slot:"vodka",qty:spiritBottlesS,target:0,min:0,max:999999,label:"Spirits",cat:"spirits",uniq:Math.max(1,spiritBrandsS.length||2),brands:spiritBrandsS});
    }

    if (planS.length===0) return fail("category_splits produced no recognized categories — keys must be among wine/beer/hard_seltzer(or seltzer)/spirits");

    var brandSubstitutions=[];
    var resAllS=await Promise.all(planS.map(function(pl){ return doSearch(pl.term); }));
    for (var pIdxS=0;pIdxS<planS.length;pIdxS++) {
      var plS=planS[pIdxS];
      var picksS=pick(resAllS[pIdxS],plS.slot,plS.target,plS.min,plS.max,plS.qty,plS.uniq,plS.brands);
      if (picksS.length===0) {
        // Relax price caps first (same fallback pattern used in the standard
        // non-SPLIT path) but keep the brand filter.
        picksS=pick(resAllS[pIdxS],plS.slot,0,0,999999,plS.qty,plS.uniq,plS.brands);
      }
      if (picksS.length===0 && plS.brands && plS.brands.length>0) {
        // None of the customer's named brands are carried at this location —
        // fall back to any product in the category rather than silently
        // failing, but record it so the customer is told what was substituted
        // (never silently swap a named brand without saying so).
        picksS=pick(resAllS[pIdxS],plS.slot,0,0,999999,plS.qty,plS.uniq,null);
        if (picksS.length>0) {
          brandSubstitutions.push(plS.label+': none of your requested brands ('+plS.brands.join(', ')+') are available at this location — substituted '+picksS.map(function(pk){return pk.product.name;}).join(', ')+' instead');
        }
      }
      addLines(picksS,plS.label,plS.cat);
    }
    var durationLabelS = hours > 0 ? (hours+"h") : (baseDpp+" drinks/person");
    summaryBits.push("SPLIT | "+guests+" guests | "+durationLabelS+" | drinks "+totalDrinks);
  } else {
    var dpp2=baseDpp*mult;
    totalDrinks=Math.round(guests*dpp2);
    var splits={1:{spirits:1.00,wine:0.00,beer:0.00},2:{spirits:0.00,wine:0.00,beer:1.00},
      3:{spirits:0.00,wine:1.00,beer:0.00},4:{spirits:0.00,wine:0.50,beer:0.50},
      5:{spirits:0.40,wine:0.30,beer:0.30},6:{spirits:0.40,wine:0.60,beer:0.00},
      7:{spirits:0.40,wine:0.00,beer:0.60}};
    var split=splits[packageType]||splits[5];
    var spiritTypes2=["vodka","rum","bourbon","gin","tequila"];
    var spiritDrinks=Math.round(totalDrinks*split.spirits);
    var wineDrinks=Math.round(totalDrinks*split.wine);
    var beerDrinks=Math.round(totalDrinks*split.beer);
    var rawSB=split.spirits>0?Math.ceil(spiritDrinks/16):0;
    var spiritBottles=split.spirits>0?Math.max(rawSB,5):0;
    var bottlesPerType=spiritBottles>0?Math.ceil(spiritBottles/5):0;
    var wineBottles=split.wine>0?Math.ceil(wineDrinks/5):0;
    var beerCases=split.beer>0?Math.ceil(beerDrinks/beerPackSize):0;
    var redB=0,whiteB=0,sparkB=0;
    if (wineBottles>0) {
      if (packageType===5){redB=Math.round(wineBottles*0.5);whiteB=Math.round(wineBottles*0.3);sparkB=wineBottles-redB-whiteB;}
      else{redB=Math.round(wineBottles*0.6);whiteB=wineBottles-redB;}
    }
    var pb=productBudget||totalBudget;
    var spiritBudget=Math.round(pb*split.spirits*100)/100;
    var wineBudget=Math.round(pb*split.wine*100)/100;
    var beerBudget=Math.round(pb*split.beer*100)/100;
    var beerEst=beerCases*63;
    var surplus=Math.max(0,beerBudget-beerEst);
    if (surplus>50) {
      if (packageType===4) wineBudget+=surplus;
      else if (packageType===5){wineBudget+=surplus*0.6;spiritBudget+=surplus*0.4;}
      else if (packageType===7) spiritBudget+=surplus;
      beerBudget=beerEst;
    }
    var wineTarget=wineBottles?wineBudget/wineBottles:0;
    var spiritTarget2=spiritBottles?spiritBudget/(bottlesPerType*5):0;
    var beerTarget=beerCases?beerBudget/beerCases:0;
    var wMin=capWineMin||wineTarget*0.6,wMax=capWineMax||wineTarget*1.4;
    var sMin=capSpiritMin||spiritTarget2*0.6,sMax=capSpiritMax||spiritTarget2*1.4;
    var bMin=capBeerMin||(beerTarget>80?0:beerTarget*0.6),bMax=capBeerMax||(beerTarget>80?999999:beerTarget*1.4);
    if (isQuoteMode&&!hasPriceCaps){wMin=0;wMax=999999;sMin=0;sMax=999999;bMin=0;bMax=999999;}
    if (isQuoteMode&&hasPriceCaps){
      wMin=capWineMin||0;wMax=capWineMax||999999;wineTarget=capWineMax||0;
      sMin=capSpiritMin||0;sMax=capSpiritMax||999999;spiritTarget2=capSpiritMax||0;
      bMin=capBeerMin||0;bMax=capBeerMax||999999;beerTarget=capBeerMax||0;
    }
    var hasCocktails=cocktailIngredients.length>0;
    var plan=[];
    if (wineBottles>0) {
      if (redB>0) plan.push({term:"Red Wine",slot:"red",qty:redB,target:wineTarget,min:wMin,max:wMax,label:"Red Wine",cat:"wine",uniq:2});
      if (whiteB>0) plan.push({term:"White Wine",slot:"white",qty:whiteB,target:wineTarget,min:wMin,max:wMax,label:"White Wine",cat:"wine",uniq:2});
      if (sparkB>0) plan.push({term:"Sparkling Wine",slot:"sparkling",qty:sparkB,target:wineTarget,min:wMin,max:wMax,label:"Sparkling Wine",cat:"wine",uniq:2});
    }
    if (beerCases>0) {
      plan.push({term:"Beer",slot:"beer",qty:beerCases,target:beerTarget,min:bMin,max:bMax,label:"Beer",cat:"beer",uniq:2});
      if (hardSeltzer) plan.push({term:"Hard Seltzer",slot:"seltzer",qty:Math.max(1,Math.round(beerCases/2)),target:beerTarget,min:0,max:999999,label:"Hard Seltzer",cat:"beer",uniq:2});
      if (naBeer) plan.push({term:"Non Alcoholic Beer",slot:"nabeer",qty:Math.max(1,Math.round(beerCases/2)),target:beerTarget,min:0,max:999999,label:"Non-Alcoholic Beer",cat:"beer",uniq:2});
    }
    if (spiritBottles>0&&!hasCocktails) {
      for (var st=0;st<spiritTypes2.length;st++) {
        var nm=spiritTypes2[st];
        plan.push({term:nm.charAt(0).toUpperCase()+nm.slice(1),slot:nm,qty:bottlesPerType,target:spiritTarget2,min:sMin,max:sMax,label:nm.charAt(0).toUpperCase()+nm.slice(1),cat:"spirits",uniq:1});
      }
    }
    if (hasCocktails) {
      var cocktailDrinks=spiritBottles>0?spiritDrinks:Math.round(totalDrinks*0.3);
      for (var c=0;c<cocktailIngredients.length;c++) {
        var ing=cocktailIngredients[c];
        var role=(ing.role||"mixer").toLowerCase();
        var q=role==="base"?Math.max(1,Math.ceil(cocktailDrinks*2/25)):role==="secondary"?Math.max(1,Math.ceil(cocktailDrinks*1/25)):Math.max(1,Math.ceil(cocktailDrinks/20));
        plan.push({term:ing.search,slot:"mixer",qty:q,target:role==="base"?spiritTarget2:0,min:role==="base"?sMin:0,max:role==="base"?sMax:999999,label:ing.search,cat:role==="mixer"?"mixers":"spirits",uniq:1});
      }
    }
    if (plan.length===0) return fail("Nothing to search");
    var resAll=await Promise.all(plan.map(function(pl){return doSearch(pl.term);}));
    for (var pIdx=0;pIdx<plan.length;pIdx++) {
      var pl=plan[pIdx];
      var picks=pick(resAll[pIdx],pl.slot,pl.target,pl.min,pl.max,pl.qty,pl.uniq);
      if (picks.length===0&&pl.slot!=="mixer"&&!(pl.cat==="wine"&&capWineMax)&&!(pl.cat==="beer"&&capBeerMax)&&!(pl.cat==="spirits"&&capSpiritMax)) {
        picks=pick(resAll[pIdx],pl.slot,0,0,999999,pl.qty,pl.uniq);
      }
      addLines(picks,pl.label,pl.cat);
    }
    var durationLabel2 = hours > 0 ? (hours+"h") : (baseDpp+" drinks/person");
    summaryBits.push("Package "+packageType+" | "+guests+" guests | "+durationLabel2+" | "+(isQuoteMode?"QUOTE":"$"+totalBudget)+" | drinks "+totalDrinks);
  }

  if (lineItems.length===0) return fail("No products available at "+kitchenLocation);

  function productTotal() {
    var t=0;
    for (var i=0;i<lineItems.length;i++) t+=lineItems[i].qty*lineItems[i].price;
    return Math.round(t*100)/100;
  }
  if (!isQuoteMode) {
    // QUANTITY-FIRST budget fit (business rule: quantity always wins, price tier
    // flexes). This was the real cause of a 150-guest event getting 14 wine bottles:
    // the calculator correctly sized 35+35, then this loop repeatedly decremented the
    // line with the largest subtotal (the ~$55 Prisoner) to fit budget — fewer bottles
    // of pricier wine, the opposite of what an event needs. Now: when over budget,
    // first DOWNGRADE the highest-subtotal item to a cheaper product (quantity kept);
    // only decrement quantity as a last resort once no cheaper product exists.
    var downgraded={};
    var guard=0;
    while (productTotal()>productBudget&&guard<50) {
      guard++;
      // Iterate: each pass re-derives ceilings from the now-cheaper basket, so the tier
      // converges on one that actually fits. An item is only marked exhausted (skipped)
      // when a search finds no cheaper same-type product, not after a single attempt.
      var idx=-1,best2=0;
      for (var i2=0;i2<lineItems.length;i2++) {
        var sub=lineItems[i2].qty*lineItems[i2].price;
        if (!downgraded[i2]&&sub>best2){best2=sub;idx=i2;}
      }
      if (idx>=0) {
        var li=lineItems[idx];
        var cheaperFound=false;
        try {
          // Search by the ORIGINAL label (e.g. "White Wine", "Corona Beer"), not the
          // matched product's name — the product name pulls in cross-category matches
          // (a white wine "downgraded" to Champagne; bitters to an amaro). And prefer
          // the CHEAPEST same-type product, not the next-cheapest: a $55->$50 step is a
          // useless downgrade that just falls through to a quantity trim anyway.
          var term=li.label||li.name;
          var cands=await doSearch(term, li.category);
          var liPack=(String(li.size||'').match(/(\d+)\s*x/i)||[])[1];
          // Option C: target a price tier. Compute the max unit price at which this
          // item's FULL quantity still fits within the budget (budget minus everything
          // else already in the basket), then pick the most expensive same-type product
          // at or below that ceiling. Single pass, spends the budget, no oscillation.
          // Fair ceiling: budget share for this item = its fraction of the current total
          // spend, applied to productBudget. Computing "budget minus everything else at
          // current prices" goes negative when the whole basket is over budget (nothing
          // qualifies, so it silently fell through to quantity trims). Proportional
          // allocation gives every item an achievable price tier in a single pass.
          var grandTot=0;
          for (var oi=0;oi<lineItems.length;oi++) grandTot+=lineItems[oi].qty*lineItems[oi].price;
          var mySub=li.qty*li.price;
          var myBudget=grandTot>0?productBudget*(mySub/grandTot):0;
          var maxUnit=li.qty>0?myBudget/li.qty:0;
          // Wine color guard: "Red Wine" must not resolve to a rosé/white and vice versa.
          var lbl=String(li.label||'').toLowerCase();
          var wantRed=lbl.indexOf('red')>=0, wantWhite=lbl.indexOf('white')>=0;
          function isSparkling(n){n=String(n||'').toLowerCase();return /champagne|prosecco|sparkling|brut|cava|cremant|spumante/.test(n);}
          function isRoseOrWhite(n){n=String(n||'').toLowerCase();return /ros[eé]|white zinfand|\bwhite\b|blanc|chardonnay|pinot grigio|pinot gris|riesling|moscato|sauvignon blanc|albari|vermentino|gruner/.test(n);}
          function isRed(n){n=String(n||'').toLowerCase();return /\bred\b|cabernet|merlot|pinot noir|malbec|syrah|shiraz|nebbiolo|sangiovese|tempranillo|zinfandel(?! white)|red blend/.test(n);}
          // Normalize a size string to a comparable key: "24x12 Oz Bottle" -> "24x12", "750 ML" -> "750ml".
          function sizeKey(s){s=String(s||'').toLowerCase().replace(/\s+/g,'');var m=s.match(/(\d+)x(\d+)/);if(m)return m[1]+'x'+m[2];m=s.match(/(\d+(?:\.\d+)?)(ml|l)/);return m?(m[1]+m[2]):s;}
          var liKey=sizeKey(li.size);
          var cheaper=(cands||[]).filter(function(p){
              if(!(p.price>0&&p.price<li.price&&p.price<=maxUnit)) return false;
              // Same size/pack REQUIRED for a downgrade — a 6-pack is not a cheaper 24-pack,
              // and a 375ml is not a cheaper 750ml. Different size = different product.
              if(liKey&&sizeKey(p.sizeStr)!==liKey) return false;
              if(li.category==='wine'){
                // Still vs sparkling must match; red/white must match the requested color.
                if(isSparkling(p.name)!==isSparkling(li.name)) return false;
                if(wantRed&&(isRoseOrWhite(p.name)||isSparkling(p.name))) return false;
                if(wantWhite&&(isRed(p.name)||isSparkling(p.name))) return false;
              }
              return true;})
            .sort(function(a,b){return b.price-a.price;}); // most expensive under the ceiling first
          if (cheaper.length>0) {
            var c=cheaper[0];
            console.log('[buildPackage] QUANTITY-FIRST budget fit: downgrade',li.name,'$'+li.price,'->',c.name,'$'+c.price,'(qty kept:',li.qty+')');
            li.name=c.name;li.price=c.price;li.size=c.sizeStr||li.size;li.url=c.url||li.url;
            li.product_id=c.product_id||li.product_id;li.upc=c.upc||li.upc;li.establishmentId=c.establishmentId||li.establishmentId;
            cheaperFound=true;
          }
        } catch(e) {}
        if (cheaperFound) continue;
        downgraded[idx]=true; // no cheaper same-type product exists — exhausted
        continue;
      }
      // Last resort: no un-downgraded item had a cheaper alternative — decrement qty
      var idxQ=-1,bestQ=0;
      for (var i3=0;i3<lineItems.length;i3++) {
        var subQ=lineItems[i3].qty*lineItems[i3].price;
        if (lineItems[i3].qty>1&&subQ>bestQ){bestQ=subQ;idxQ=i3;}
      }
      if (idxQ<0) break;
      console.log('[buildPackage] QUANTITY-FIRST last-resort qty trim',lineItems[idxQ].name,lineItems[idxQ].qty,'->',lineItems[idxQ].qty-1);
      lineItems[idxQ].qty-=1;
    }
  }

  var pt=productTotal();
  var tax=Math.round(pt*0.10*100)/100;
  var svc=Math.round(pt*0.10*100)/100;
  var tip=Math.round(pt*0.05*100)/100;
  var delivery=25.00;
  var grand=Math.round((pt+tax+svc+tip+delivery)*100)/100;
  var usedPct=productBudget>0?Math.round(pt/productBudget*100):0;

  var prefSeen={};var prefList=[];
  for (var i3=0;i3<lineItems.length;i3++) {
    var lbl=preferredLabel(lineItems[i3].name);
    if (lbl&&!prefSeen[lbl]){prefSeen[lbl]=1;prefList.push(lineItems[i3].name.split(/ \d|\u2014|-/)[0].trim());}
  }
  var disp=[];
  for (var i4=0;i4<lineItems.length;i4++) {
    var li=lineItems[i4];
    var viewLink=li.url?"[View]("+li.url+")":"";
    disp.push(li.qty+"x "+li.name.replace(/ \*$/,"")+(li.size?" \u2014 "+li.size:"")+" \u2014 $"+li.price.toFixed(2)+" ea = $"+(li.qty*li.price).toFixed(2)+(viewLink?" | "+viewLink:""));
  }
  var summary=summaryBits.join(" ")+" | items "+lineItems.length+" | product $"+pt+" | grand $"+grand+(unavailable.length?" | UNAVAILABLE: "+unavailable.join(", "):"");

  return { success:"true", error:"", is_custom_mode:isCustom?"true":"false",
    line_items:JSON.stringify(lineItems), line_items_display:disp.join("\n"),
    product_total:pt.toFixed(2), estimated_tax:tax.toFixed(2), estimated_service:svc.toFixed(2),
    estimated_tip:tip.toFixed(2), delivery_fee:delivery.toFixed(2), estimated_grand_total:grand.toFixed(2),
    product_budget:String(productBudget), budget_used_pct:String(usedPct),
    preferred_brands:prefList.join(", "), unavailable:unavailable.join(", "),
    brand_substitutions:(typeof brandSubstitutions!=='undefined'?brandSubstitutions:[]).join("; "),
    total_drinks:String(totalDrinks), summary:summary };
}


module.exports = { getProductURL, getProductURLByZip, searchProducts, buildPackage, shoppingAgent, addToCart, calculateQuantities, calculateBasket, createOrder };

// --- SEARCH PRODUCTS (B2B by kitchen location) ---
async function searchProducts({ queries, kitchen_location, client_name, top_n }) {
  const results = [];
  for (const q of (queries || [])) {
    const terms = [q.term, ...(q.fallback_terms || [])];
    let found = false;
    for (const term of terms) {
      if (found) break;
      try {
        const result = await getProductURL({
          product_name: term,
          kitchen_location: kitchen_location || '',
          client_id: client_name || '',
          min_price: q.min_price || 0,
          max_price: q.max_price || 999999,
          limit: top_n || 5
        });
        if (result.product_found) {
          const products = JSON.parse(result.products_json).map(p => ({
            name: p.name, price: p.price, size: p.size,
            url: p.url, product_id: p.product_id, upc: p.upc, preferred: false
          }));
          results.push({ label: q.label, used_term: term, found: true, products });
          found = true;
        }
      } catch(e) {}
    }
    if (!found) results.push({ label: q.label, used_term: q.term, found: false, products: [] });
  }
  return { success: true, found_count: results.filter(r => r.found).length, results };
}

// --- SHOPPING AGENT ---
async function shoppingAgent(message) {
  return { success: false, response: 'Shopping agent not available' };
}
