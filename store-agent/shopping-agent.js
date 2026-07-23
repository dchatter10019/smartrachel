/**
 * Bevvi Shopping Agent v2 (port 8300)
 */

const http = require('http');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PORT = 8300;
const GBRAIN_URL = 'http://127.0.0.1:7700';
const GBRAIN_TOKEN = 'gbrain_71d7392edf8a722d8816739407f1455d13fff00a0c7b12e3afa208b4d081ebf4';
const BEVVI_API = 'https://api.getbevvi.com';
const packageModel = require('/home/ubuntu/rachel/package-model.js');
const { classifyProduct } = require('/home/ubuntu/rachel/brand-lists.js');

const ZIP_MAP = {
  '07608':'Teterboro - NJ','07631':'Teterboro - NJ','07652':'Teterboro - NJ',
  '07666':'Teterboro - NJ','07670':'Teterboro - NJ','07024':'Teterboro - NJ',
  '07010':'Teterboro - NJ','07026':'Teterboro - NJ','07047':'Teterboro - NJ',
  '07072':'Teterboro - NJ','07073':'Teterboro - NJ','07074':'Teterboro - NJ',
  '10001':'Celonis - NYC','10002':'Celonis - NYC','10003':'Celonis - NYC',
  '10010':'Celonis - NYC','10011':'Celonis - NYC','10016':'Celonis - NYC',
  '10019':'Celonis - NYC','10022':'Celonis - NYC','10028':'Celonis - NYC'
};

const CLIENT_MAP = {
  'Teterboro - NJ': 'airculinaire',
  'Celonis - NYC': 'fooda'
};

function resolveLocation(zip) {
  const kitchen = ZIP_MAP[zip] || '';
  const client = CLIENT_MAP[kitchen] || 'airculinaire';
  return { kitchen, client };
}

const STORE_DISPLAY_MAP = {
  'Celonis - NYC': 'New York City',
  'Teterboro - NJ': 'New Jersey',
  'San Diego - CA': 'San Diego',
  'Dallas - TX': 'Dallas',
  'Chicago - IL': 'Chicago'
};

function friendlyStore(kitchen) {
  return STORE_DISPLAY_MAP[kitchen] || kitchen;
}

async function gbrainQuery(query) {
  try {
    const res = await fetch(GBRAIN_URL + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GBRAIN_TOKEN,
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'query', arguments: { query } }
      })
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data:'));
    if (!line) return null;
    const result = JSON.parse(line.replace('data:', '').trim());
    const content = result.result && result.result.content && result.result.content[0] && result.result.content[0].text;
    if (!content) return null;
    // GBrain returns array of chunks - find the one matching email
    try {
      const chunks = JSON.parse(content);
      if (Array.isArray(chunks)) {
        // Find chunk with matching email in customers/ slug
        const match = chunks.find(function(c) { return c.slug && c.slug.startsWith('customers/') && c.chunk_text && c.chunk_text.includes(query.split(' ').find(function(w) { return w.includes('@'); }) || ''); });
        return match ? match.chunk_text : (chunks[0] ? chunks[0].chunk_text : null);
      }
    } catch(e) {}
    return content;
  } catch(e) { return null; }
}

async function getCustomerProfile(email) {
  if (!email) return null;
  // Use get_page directly for guaranteed accuracy
  let raw = null;
  try {
    // Query GBrain first to get the customer name, then use name-based slug
    const queryRaw = await gbrainQuery('customer email ' + email);
    let slug = null;
    if (queryRaw) {
      const nameMatch = queryRaw.match(/^# ([^\n]+)/m);
      if (nameMatch) slug = 'customers/' + nameMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    }
    if (!slug) throw new Error('no slug');
    const pageRes = await fetch(GBRAIN_URL + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GBRAIN_TOKEN, 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug } } })
    });
    const pageText = await pageRes.text();
    const pageLine = pageText.split('\n').find(function(l) { return l.startsWith('data:'); });
    if (pageLine) {
      const pageData = JSON.parse(pageLine.slice(pageLine.indexOf(':')+1).trim());
      const pageContent = pageData?.result?.content?.[0]?.text;
      if (pageContent) {
        const page = JSON.parse(pageContent);
        raw = page.compiled_truth || null;
      }
    }
  } catch(e) { console.error('[getCustomerProfile] get_page error:', e.message); }
  if (!raw) raw = await gbrainQuery('customer email ' + email + ' spend profile price tier preferences price profile category subcategory');
  if (!raw) return null;
  console.log('[getCustomerProfile] raw length:', raw.length, 'has Price Profile:', raw.includes('Price Profile by Category'));
  const profile = { raw };
  const avgMatch = raw.match(/Avg item price[:\s]+\$?([\d.]+)/i);
  if (avgMatch) profile.avg_item_price = parseFloat(avgMatch[1]);
  const tierMatch = raw.match(/Price tier[:\s]+([^\n]+)/i);
  if (tierMatch) profile.price_tier = tierMatch[1].trim();
  const brandsMatch = raw.match(/Top brands[:\s]+([^\n]+)/i);
  if (brandsMatch) profile.top_brands = brandsMatch[1].split(',').map(function(b) { return b.trim(); });
  const productsMatch = raw.match(/Top products[:\s]+([^\n]+)/i);
  if (productsMatch) profile.top_products = productsMatch[1].split(',').map(function(p) { return p.trim().replace(/[\n\r].*/,''); }).filter(function(p) { return p.length > 0 && p.length < 60 && !p.includes('$') && !p.includes(':'); });
  // Parse per-subcategory price averages
  profile.subcat_avg = {};
  const subcatIdx = raw.indexOf('## Price Profile by Category');
  if (subcatIdx >= 0) {
    const subcatText = raw.slice(subcatIdx + 28);
    const subcatEnd = subcatText.indexOf('\n##');
    const subcatBlock = subcatEnd >= 0 ? subcatText.slice(0, subcatEnd) : subcatText.slice(0, 1000);
    subcatBlock.replace(/\\n/g, '\n').split('\n').forEach(function(line) {
      const m = line.match(/^- ([^:]+): avg \$([\d.]+)/);
      if (m) profile.subcat_avg[m[1].trim().toLowerCase()] = parseFloat(m[2]);
    });
    console.log('[subcat] parsed', Object.keys(profile.subcat_avg).length, 'subcategories, block sample:', JSON.stringify(subcatBlock.slice(0,100)));
  }
  return profile;
}

async function inferPriceRange(profile, subcategory) {
  if (!profile && !subcategory) return { min: 0, max: 999999 };

  // 1. Try customer's own subcategory history (most personalized)
  if (subcategory && profile && profile.subcat_avg) {
    const subLower = subcategory.toLowerCase();
    let subcatAvg = profile.subcat_avg[subLower];
    if (!subcatAvg) {
      const keys = Object.keys(profile.subcat_avg);
      const match = keys.find(function(k) { return k.includes(subLower) || subLower.includes(k); });
      if (match) subcatAvg = profile.subcat_avg[match];
    }
    if (subcatAvg) {
      const min = Math.max(0, Math.round(subcatAvg * 0.3));
      const max = Math.round(subcatAvg * 2.5);
      console.log('[inferPriceRange] customer subcat:', subcategory, 'avg:', subcatAvg, '->', min, '-', max);
      return { min, max };
    }
  }

  // 2. Try collective model subcategory price (learned from all orders)
  if (subcategory) {
    try {
      const modelPrice = await packageModel.getSubcategoryPrice(subcategory);
      if (modelPrice) {
        // Use p50 as center, wide range to allow variety
        const center = modelPrice.p50 || modelPrice.avg;
        const min = Math.max(0, Math.round(center * 0.25));
        const max = Math.round(center * 3);
        console.log('[inferPriceRange] collective model:', subcategory, 'p50:', center, '->', min, '-', max);
        return { min, max };
      }
    } catch(e) {}
  }

  // 3. Fall back to customer overall avg
  if (profile && profile.avg_item_price) {
    const avg = profile.avg_item_price;
    const min = Math.max(0, Math.round(avg * 0.2));
    const max = Math.round(avg * 3);
    return { min, max };
  }

  return { min: 0, max: 999999 };
}

function scoreBuyer(profile) {
  if (!profile) return { tier: 'new', discount: 0 };
  const raw = profile.raw || '';
  // Extract 90-day GMV
  const gmvMatch = raw.match(/90-day GMV[:\s]+\$?([\d,]+)/i);
  const gmv = gmvMatch ? parseFloat(gmvMatch[1].replace(',','')) : 0;
  // Extract order count
  const ordersMatch = raw.match(/Orders \(90d\)[:\s]+(\d+)/i);
  const orders = ordersMatch ? parseInt(ordersMatch[1]) : 0;
  if (gmv > 10000 || orders > 20) return { tier: 'vip',     discount: 0.10 };
  if (gmv > 3000  || orders > 8)  return { tier: 'loyal',   discount: 0.05 };
  if (gmv > 500   || orders > 2)  return { tier: 'regular', discount: 0.02 };
  return { tier: 'new', discount: 0 };
}

async function searchProducts(location, client, query, limit, minPrice, maxPrice) {
  try {
    let url = BEVVI_API + '/api/corpproducts/searchCorpProducts?location=' + encodeURIComponent(location) + '&searchBy=' + encodeURIComponent(query) + '&client=' + encodeURIComponent(client) + '&limit=' + (limit || 10);
    if (minPrice !== undefined && minPrice > 0) url += '&min=' + minPrice;
    if (maxPrice !== undefined && maxPrice < 10000) url += '&max=' + maxPrice;
    console.log('[searchProducts]', url);
    const res = await fetch(url);
    if (!res.ok) { console.log('[searchProducts] HTTP error:', res.status); return []; }
    const data = await res.json();
    console.log('[searchProducts] results:', Array.isArray(data) ? data.length : 'not array');
    return Array.isArray(data) ? data : [];
  } catch(e) { console.error('[searchProducts] error:', e.message); return []; }
}

async function searchWithFallbacks(location, client, name, limit, minPrice, maxPrice) {
  let products = await searchProducts(location, client, name, limit || 10, minPrice, maxPrice);
  if (products.length) return products;
  // Normalize common category names
  const nameMap = {'champagne': 'champagne', 'prosecco': 'prosecco', 'sparkling wine': 'champagne',
                   'red wine': 'cabernet', 'white wine': 'chardonnay', 'rose': 'rose wine', 'ros\u00e9': 'rose wine'};
  name = nameMap[name.toLowerCase()] || name;
  const simplified = name.replace(/[\u2018\u2019\u0027]/g, '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  if (simplified !== name) {
    products = await searchProducts(location, client, simplified, limit || 10, minPrice, maxPrice);
    if (products.length) return products;
  }
  const words = name.split(' ');
  if (words.length > 2) {
    products = await searchProducts(location, client, words.slice(0,2).join(' '), limit || 10, minPrice, maxPrice);
    if (products.length) return products;
  }
  if (words.length > 1) {
    products = await searchProducts(location, client, words[0], limit || 10, minPrice, maxPrice);
  }
  return products;
}

function formatProduct(p) {
  const classified = classifyProduct(p.name || '');
  return {
    name: p.name || '',
    price: p.salePrice || p.price || 0,
    size: p.size && p.units ? p.size + p.units : '',
    preferred: classified.preferred,
    url: p.url || (p.slug ? 'https://fooda.getbevvi.com/productdetail/' + p.slug : ''),
    upc: p.upc || p.origanlUpc || '',
    product_id: (p.corpProductFilter && p.corpProductFilter.corpProductId) || p.id || '',
    establishmentId: p.establishmentId || '',
    category: p.category || '',
    brand: p.brandinfo || ''
  };
}

async function executeTool(name, input) {
  console.log('[shopping-agent] intent:', name, JSON.stringify(input).slice(0, 150));

  if (name === 'product_query') {
    const queries = input.queries || [];
    const zip = input.zip || '';
    const email = input.email || '';
    const loc = resolveLocation(zip);
    if (!loc.kitchen) return { success: false, error: 'No store for zip ' + zip };
    const profile = await getCustomerProfile(email);
    const results = [];
    for (var i = 0; i < queries.length; i++) {
      const q = queries[i];
      // Only apply price filter if explicitly requested — never filter for named product searches
      const priceRange = (input.min_price || input.max_price) ?
        { min: input.min_price || 0, max: input.max_price || 999999 } :
        { min: 0, max: 999999 };
      // Support both {name} and {term/label} formats
      const searchName = q.name || q.term || q.label || '';
      const fallbacks = q.fallback_terms || [];
      let raw = await searchWithFallbacks(loc.kitchen, loc.client, searchName, q.limit || 5);
      // Try fallback terms if main search fails
      for (var fi = 0; fi < fallbacks.length && raw.length === 0; fi++) {
        raw = await searchWithFallbacks(loc.kitchen, loc.client, fallbacks[fi], q.limit || 5);
      }
      // Sort: 1) Price tier (closest to target) 2) Preferred/sponsored 3) Swap history
      const sorted = raw
        .filter(function(p) { const price = p.salePrice || p.price || 0; return price >= priceRange.min && price <= priceRange.max && price > 0; })
        .sort(function(a, b) {
          // 1) Price — higher price first (premium preference)
          const aPrice = a.salePrice || a.price || 0;
          const bPrice = b.salePrice || b.price || 0;
          const priceDiff = bPrice - aPrice;
          // 2) Preferred/sponsored brand — breaks price ties
          const aP = classifyProduct(a.name || '').preferred ? 1 : 0;
          const bP = classifyProduct(b.name || '').preferred ? 1 : 0;
          if (aP !== bP && Math.abs(priceDiff) < aPrice * 0.15) return bP - aP; // within 15% price = same tier
          // 3) Price as primary if significant difference
          return priceDiff;
        });
      const filtered = sorted.slice(0, q.limit || 3).map(formatProduct);
      results.push({ query: q.name, found: filtered.length > 0, products: filtered });
    }
    return { success: true, results: results, kitchen: loc.kitchen, client: loc.client, store: friendlyStore(loc.kitchen), buyer_tier: scoreBuyer(profile).tier };
  }

  if (name === 'menu_build') {
    const loc = resolveLocation(input.zip || '');
    if (!loc.kitchen) return { success: false, error: 'No store for zip ' + input.zip };
    const profile = await getCustomerProfile(input.email);
    const buyer = scoreBuyer(profile);
    let pkgType = input.package_type || '5';
    if (input.categories) {
      const cats = input.categories.map(function(c) { return c.toLowerCase(); });
      const hasS = cats.some(function(c) { return c.includes('spirit') || c.includes('liquor'); });
      const hasW = cats.some(function(c) { return c.includes('wine'); });
      const hasB = cats.some(function(c) { return c.includes('beer'); });
      if (hasS && hasW && hasB) pkgType = '5';
      else if (hasS && hasW) pkgType = '6';
      else if (hasS && hasB) pkgType = '7';
      else if (hasW && hasB) pkgType = '4';
      else if (hasS) pkgType = '1';
      else if (hasB) pkgType = '2';
      else if (hasW) pkgType = '3';
    }
    const { buildPackage } = require('/home/ubuntu/rachel/functions.js');
    const result = await buildPackage({
      guests: input.guests, hours: input.hours,
      total_budget: input.budget || 999999,
      package_type: pkgType,
      kitchen_location: loc.kitchen,
      client_name: loc.client
    });
    if (result.success !== 'true') return { success: false, error: result.error };

    // Price scaling: upgrade products to fill budget
    const swaps = [];
    if (input.budget && input.budget > 0) {
      const items = JSON.parse(result.line_items || '[]');
      const productBudget = Math.round((input.budget - 25) / 1.25 * 100) / 100;
      const currentTotal = items.reduce(function(sum, p) { return sum + p.qty * p.price; }, 0);
      const remaining = productBudget - currentTotal;
      if (remaining > 30 && items.length > 0) {
        const budgetPerItem = productBudget / items.length;
        const usedNamesPass1 = new Set(items.map(function(p) { return p.name; }));
        for (var ii = 0; ii < items.length; ii++) {
          const item = items[ii];
          const targetPrice = budgetPerItem / item.qty;
          if (targetPrice > item.price * 1.3) {
            // Use item label (Red Wine/White Wine) for precise subcategory search
            const itemLabel = (item.label || item.category || '').toLowerCase();
            const searchTerm = itemLabel === 'red wine' ? 'Red Wine' :
              itemLabel === 'white wine' ? 'White Wine' :
              itemLabel.includes('champagne') ? 'champagne' :
              itemLabel.includes('beer') || itemLabel.includes('lager') ? 'beer' :
              (item.label || item.name).split(' ').slice(0,2).join(' ');
            const candidates = await searchWithFallbacks(loc.kitchen, loc.client, searchTerm, 20);
            const better = candidates
              .map(function(p) { return { name: p.name, price: p.salePrice||p.price||0, upc: p.upc||'', url: p.url||'', product_id:(p.corpProductFilter&&p.corpProductFilter.corpProductId)||p.id||'', establishmentId: p.establishmentId||'', subcategory: p.subCategory||p.subcategory||item.subcategory||'' }; })
              .filter(function(p) {
                const n=(p.name||'').toLowerCase();
                const sub=(p.subCategory||p.subcategory||'').toLowerCase();
                if (p.price <= item.price || p.price > targetPrice || usedNamesPass1.has(p.name)) return false;
                if (n.includes('port') || sub.includes('port') || n.includes('tawny') || n.includes('sherry') || n.includes('sake') || sub.includes('fortified')) return false;
                if (itemLabel === 'red wine' && sub && !sub.includes('red') && !sub.includes('cabernet') && !sub.includes('merlot') && !sub.includes('pinot noir') && !sub.includes('blend') && !sub.includes('chianti') && !sub.includes('bordeaux') && !sub.includes('barolo')) return false;
                if (itemLabel === 'white wine' && sub && (sub.includes('red') || sub.includes('champagne') || sub.includes('sparkling') || sub.includes('sake') || sub.includes('port'))) return false;
                return true;
              })
              .sort(function(a,b) { return b.price - a.price; });
            if (better.length > 0) {
              const best = better[0];
              console.log('[shopping-agent] menu_build upgrading', item.name, '$'+item.price, '->', best.name, '$'+best.price);
              swaps.push({ from: item.name, to: best.name, label: item.label || item.category });
              usedNamesPass1.delete(item.name);
              Object.assign(item, best);
              usedNamesPass1.add(item.name);
            }
          }
        }
        // Second pass: use remaining budget to upgrade cheapest items further
        let runningTotal2 = items.reduce(function(sum,p) { return sum+p.qty*p.price; }, 0);
        let remaining2 = productBudget - runningTotal2;
        const usedNames = new Set(items.map(function(p) { return p.name; }));
        if (remaining2 > 30) {
          const byPrice = items.slice().sort(function(a,b) { return a.price - b.price; });
          for (var jj = 0; jj < byPrice.length && remaining2 > 30; jj++) {
            const item = byPrice[jj];
            const itemCat2 = (item.category || item.label || '').toLowerCase();
            // Skip beer upgrades — keep beer as beer
            if (itemCat2.includes('beer') || itemCat2.includes('lager') || itemCat2.includes('ale')) continue;
            const maxForItem = item.price + remaining2 / item.qty;
            const itemLabel2 = (item.label || item.category || '').toLowerCase();
            const term2 = itemLabel2 === 'red wine' ? 'Red Wine' :
                          itemLabel2 === 'white wine' ? 'White Wine' :
                          itemLabel2.includes('champagne') ? 'champagne' :
                          itemLabel2.includes('beer') || itemLabel2.includes('lager') ? 'beer' :
                          (item.label||item.name).split(' ').slice(0,2).join(' ');
            const cands2 = await searchProducts(loc.kitchen, loc.client, term2, 50, item.price + 1, maxForItem);
            const best2 = cands2.map(function(p) { return {name:p.name,price:p.salePrice||p.price||0,upc:p.upc||'',url:p.url||'',product_id:(p.corpProductFilter&&p.corpProductFilter.corpProductId)||p.id||'',establishmentId:p.establishmentId||'',subcategory:p.subCategory||p.subcategory||item.subcategory||''}; })
              .filter(function(p) {
                const n=(p.name||'').toLowerCase();
                const sub=(p.subCategory||p.subcategory||'').toLowerCase();
                if (p.price <= item.price || p.price > maxForItem || usedNames.has(p.name)) return false;
                if (n.includes('port') || sub.includes('port') || n.includes('tawny') || n.includes('sherry') || n.includes('sake') || sub.includes('fortified')) return false;
                if (itemLabel2 === 'red wine' && sub && !sub.includes('red') && !sub.includes('cabernet') && !sub.includes('merlot') && !sub.includes('pinot noir') && !sub.includes('blend') && !sub.includes('chianti') && !sub.includes('bordeaux') && !sub.includes('barolo')) return false;
                if (itemLabel2 === 'white wine' && sub && (sub.includes('red') || sub.includes('champagne') || sub.includes('sparkling') || sub.includes('sake') || sub.includes('port'))) return false;
                return true;
              })
              .sort(function(a,b) { return b.price - a.price; });
            if (best2.length > 0) {
              console.log('[shopping-agent] pass2 upgrading', item.name, '$'+item.price, '->', best2[0].name, '$'+best2[0].price);
              swaps.push({ from: item.name, to: best2[0].name, label: item.label || item.category });
              usedNames.delete(item.name);
              Object.assign(item, best2[0]);
              usedNames.add(item.name);
              runningTotal2 = items.reduce(function(sum,p) { return sum+p.qty*p.price; }, 0);
              remaining2 = productBudget - runningTotal2;
            }
          }
        }
        // Recalculate totals
        const newTotal = Math.round(items.reduce(function(sum,p) { return sum+p.qty*p.price; }, 0)*100)/100;
        result.line_items = JSON.stringify(items);
        result.product_total = newTotal.toFixed(2);
        result.estimated_tax = (Math.round(newTotal*0.10*100)/100).toFixed(2);
        result.estimated_service = (Math.round(newTotal*0.10*100)/100).toFixed(2);
        result.estimated_tip = (Math.round(newTotal*0.05*100)/100).toFixed(2);
        result.delivery_fee = '25.00';
        result.estimated_grand_total = (newTotal + newTotal*0.10 + newTotal*0.10 + newTotal*0.05 + 25).toFixed(2);
      }
    }

    // Check budget utilization
    const finalTotal = parseFloat(result.product_total || 0);
    const productBudgetFinal = input.budget ? Math.round((input.budget - 25) / 1.25 * 100) / 100 : 0;
    const utilizationPct = productBudgetFinal > 0 ? Math.round(finalTotal / productBudgetFinal * 100) : 100;
    const budgetNote = utilizationPct < 70 && input.budget > 200
      ? 'Note: Only ' + utilizationPct + '% of budget utilized — the catalog at this location has limited premium options for the requested categories. Consider adding spirits or champagne to fill the remaining $' + Math.round(productBudgetFinal - finalTotal) + ' budget.'
      : '';

    // Save package to GBrain
    try {
      const { saveBasket } = require('/home/ubuntu/rachel/gbrain.js');
      await saveBasket(input.email, result.line_items, '', input.channel || 'slack');
    } catch(e) { console.error('[shopping-agent] savePackage error:', e.message); }
    return {
      success: true, kitchen: loc.kitchen, client: loc.client, store: friendlyStore(loc.kitchen),
      buyer_tier: buyer.tier, buyer_discount: buyer.discount,
      budget_note: budgetNote,
      line_items: result.line_items,
      product_total: result.product_total,
      estimated_tax: result.estimated_tax,
      estimated_service: result.estimated_service,
      estimated_tip: result.estimated_tip,
      delivery_fee: result.delivery_fee,
      estimated_grand_total: result.estimated_grand_total,
      preferred_brands: result.preferred_brands,
      unavailable: result.unavailable,
      swaps: swaps,
      total_drinks: result.total_drinks
    };
  }

  if (name === 'custom_list') {
    const loc = resolveLocation(input.zip || '');
    if (!loc.kitchen) return { success: false, error: 'No store for zip ' + input.zip };
    const { buildPackage } = require('/home/ubuntu/rachel/functions.js');
    const result = await buildPackage({
      guests: input.guests || 10,
      hours: input.hours || 2,
      total_budget: input.budget || 999999,
      package_type: 'CUSTOM',
      kitchen_location: loc.kitchen,
      client_name: loc.client,
      named_products: JSON.stringify(input.named_products || [])
    });
    if (result.success !== 'true') return { success: false, error: result.error };

    // Price scaling: keep quantities, upgrade products to fill budget
    if (input.budget && input.budget > 0) {
      const items = JSON.parse(result.line_items || '[]');
      const productBudget = Math.round((input.budget - 25) / 1.25 * 100) / 100;
      const currentTotal = items.reduce(function(sum, p) { return sum + p.qty * p.price; }, 0);
      const remaining = productBudget - currentTotal;

      if (remaining > 30 && items.length > 0) {
        const budgetPerItem = productBudget / items.length;
        const usedNamesPass1 = new Set(items.map(function(p) { return p.name; }));
        for (var ii = 0; ii < items.length; ii++) {
          const item = items[ii];
          const targetPrice = budgetPerItem / item.qty;
          if (targetPrice > item.price * 1.3) {
            const searchTerm = (item.label || item.name).split(' ').slice(0,2).join(' ');
            const candidates = await searchWithFallbacks(loc.kitchen, loc.client, searchTerm, 20);
            const better = candidates
              .map(function(p) { return { name: p.name, price: p.salePrice||p.price||0, upc: p.upc||'', url: p.url||'', product_id:(p.corpProductFilter&&p.corpProductFilter.corpProductId)||p.id||'', establishmentId: p.establishmentId||'' }; })
              .filter(function(p) { return p.price > item.price && p.price <= targetPrice * 1.2; })
              .sort(function(a,b) { return b.price - a.price; });
            if (better.length > 0) {
              const best = better[0];
              console.log('[shopping-agent] upgrading', item.name, '$'+item.price, '->', best.name, '$'+best.price);
              Object.assign(item, best);
            }
          }
        }
        const newTotal = items.reduce(function(sum,p) { return sum+p.qty*p.price; }, 0);
        result.line_items = JSON.stringify(items);
        result.product_total = newTotal.toFixed(2);
        // Totals recalculated below after all scaling
      }
    }

    // Recalculate all totals from final line_items
    let finalItems2 = JSON.parse(result.line_items || '[]');
    
    // Trim quantities to stay within budget (grand total = product * 1.25 + 25)
    if (input.budget && input.budget > 0) {
      const maxProduct = Math.floor((input.budget - 25) / 1.25 * 100) / 100;
      let runningTotal = finalItems2.reduce(function(sum,p) { return sum+p.qty*p.price; }, 0);
      // Trim most expensive items first until within budget
      while (runningTotal > maxProduct && finalItems2.some(function(p) { return p.qty > 1; })) {
        const maxItem = finalItems2.reduce(function(a,b) { return (b.qty > 1 && b.price > a.price) ? b : a; }, {price:0});
        if (maxItem.qty > 1) {
          maxItem.qty--;
          runningTotal = finalItems2.reduce(function(sum,p) { return sum+p.qty*p.price; }, 0);
        } else break;
      }
      result.line_items = JSON.stringify(finalItems2);
    }
    
    const finalTotal2 = Math.round(finalItems2.reduce(function(sum,p) { return sum+p.qty*p.price; }, 0)*100)/100;
    const finalTax = Math.round(finalTotal2*0.10*100)/100;
    const finalSvc = Math.round(finalTotal2*0.10*100)/100;
    const finalTip = Math.round(finalTotal2*0.05*100)/100;
    const finalGrand = Math.round((finalTotal2+finalTax+finalSvc+finalTip+25)*100)/100;

    // Save package to GBrain
    try {
      const { saveBasket } = require('/home/ubuntu/rachel/gbrain.js');
      await saveBasket(input.email, result.line_items, '', input.channel || 'slack');
    } catch(e) { console.error('[shopping-agent] savePackage error:', e.message); }
    return {
      success: true, kitchen: loc.kitchen, client: loc.client, store: friendlyStore(loc.kitchen),
      line_items: result.line_items,
      product_total: finalTotal2.toFixed(2),
      estimated_tax: finalTax.toFixed(2),
      estimated_service: finalSvc.toFixed(2),
      estimated_tip: finalTip.toFixed(2),
      delivery_fee: '25.00',
      estimated_grand_total: finalGrand.toFixed(2),
      unavailable: result.unavailable
    };
  }

  if (name === 'recommendation') {
    const loc = resolveLocation(input.zip || '');
    if (!loc.kitchen) return { success: false, error: 'No store for zip ' + input.zip };
    const profile = await getCustomerProfile(input.email);
    const priceRange = input.budget_per_bottle ?
      { min: input.budget_per_bottle * 0.7, max: input.budget_per_bottle * 1.3 } :
      inferPriceRange(profile, input.category || input.occasion);
    // Build search terms — prefer customer's top products, fall back to category
    const searchTerms = [];
    if (profile && profile.top_products && profile.top_products.length > 0) {
      const cat = (input.category || '').toLowerCase();
      profile.top_products.forEach(function(p) {
        const pl = p.toLowerCase();
        const isWine = pl.includes('chardonnay') || pl.includes('cabernet') || pl.includes('pinot') || pl.includes('rose') || pl.includes('merlot') || pl.includes('sauvignon') || pl.includes('malbec');
        const isSpirits = pl.includes('vodka') || pl.includes('gin') || pl.includes('rum') || pl.includes('whiskey') || pl.includes('bourbon') || pl.includes('tequila') || pl.includes('scotch');
        const isBeer = pl.includes('beer') || pl.includes('lager') || pl.includes('ipa') || pl.includes('ale');
        if (!cat || (cat === 'wine' && isWine) || (cat === 'spirits' && isSpirits) || (cat === 'beer' && isBeer) || (!isWine && !isSpirits && !isBeer)) {
          searchTerms.push(p);
        }
      });
    }
    if (searchTerms.length === 0) {
      if (input.occasion && input.occasion.toLowerCase().includes('steak')) searchTerms.push('Cabernet Sauvignon', 'Malbec', 'Merlot');
      else searchTerms.push(input.category || 'wine');
    }

    let allRaw = [];
    const seen = {};
    for (var si = 0; si < searchTerms.length; si++) {
      const results = await searchProducts(loc.kitchen, loc.client, searchTerms[si], 10);
      results.forEach(function(p) { if (!seen[p.name]) { seen[p.name] = true; allRaw.push(p); } });
    }
    let filtered = allRaw
      .filter(function(p) { const price = p.salePrice || p.price || 0; return price >= priceRange.min && price <= priceRange.max && price > 0; })
      .slice(0, 8).map(formatProduct);

    // If too few results from preferred brands, supplement with category search
    if (filtered.length < 4) {
      const fallbackTerm = input.category || 'wine';
      const fallbackRaw = await searchProducts(loc.kitchen, loc.client, fallbackTerm, 20, priceRange.min, priceRange.max);
      const existingNames = new Set(filtered.map(function(p) { return p.name; }));
      const fallback = fallbackRaw
        .filter(function(p) { 
          const price = p.salePrice || p.price || 0; 
          return price >= priceRange.min && price <= priceRange.max && price > 0 && !existingNames.has(p.name);
        })
        .slice(0, 8 - filtered.length)
        .map(formatProduct);
      filtered = filtered.concat(fallback);
    }
    const buyer = scoreBuyer(profile);
    return {
      success: true, products: filtered,
      kitchen: loc.kitchen, client: loc.client, store: friendlyStore(loc.kitchen),
      price_range: priceRange,
      customer_tier: buyer.tier,
      buyer_discount: buyer.discount,
      based_on: profile ? 'purchase_history' : 'default',
      top_products: profile && profile.top_products ? profile.top_products : [],
      message: 'Recommendations based on your purchase history (avg spend $' + (profile && profile.avg_item_price ? profile.avg_item_price : '?') + '/bottle). Price range: $' + priceRange.min + '-$' + priceRange.max + '. IMPORTANT: Present these ' + filtered.length + ' products directly to customer. Do NOT call product_query or recommendation again.'
    };
  }

  if (name === 'generate_proposal') {
    const { getPackage } = require('/home/ubuntu/rachel/gbrain.js');
    const { generateProposal } = require('/home/ubuntu/rachel/generate-proposal.js');
    const lineItems = await getPackage(input.email, input.channel || 'slack');
    if (!lineItems) return { success: false, error: 'No active package found. Build a package first.' };
    const timestamp = Date.now();
    const filename = 'bevvi-proposal-' + timestamp + '.pdf';
    const outputPath = '/home/ubuntu/logs/' + filename;
    await generateProposal({
      client_name: input.client_name,
      event_date: input.event_date || '',
      line_items: lineItems,
      notes: input.notes || ''
    }, outputPath);
    return {
      success: true,
      filename,
      download_url: 'http://3.138.180.46/proposals/' + filename,
      message: 'Proposal generated for ' + input.client_name
    };
  }

  if (name === 'place_order') {
    const zip = input.zip || (input.customer && input.customer.zipcode) || '';
    const loc = resolveLocation(zip);
    const products = JSON.parse(input.line_items || '[]');
    const c = input.customer || {};

    // Try orchestrator first — broadcast RFQ to find best store
    try {
      const rfqBasket = products.map(function(item) {
        return { name: item.name, category: item.category || item.label || '', quantity: item.qty || 1, max_price: (item.price || 0) * 1.3, upc: item.upc || '' };
      });
      const rfqRes = await fetch('http://127.0.0.1:8200/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'broadcast_rfq', arguments: { delivery_zip: zip || '10010', basket: rfqBasket } } })
      });
      const rfqText = await rfqRes.text();
      const rfqLine = rfqText.split('\n').find(function(l){ return l.startsWith('data:'); });
      if (rfqLine) {
        const rfqMsg = JSON.parse(rfqLine.replace('data:', '').trim());
        const rfqResult = JSON.parse(rfqMsg.result.content[0].text);
        if (rfqResult.success && rfqResult.winner && rfqResult.winner.coverage_pct >= 80) {
          const winner = rfqResult.winner;
          console.log('[shopping-agent] place_order via orchestrator → winner:', winner.store, '$' + winner.estimated_grand_total);
          // Place order via winning store agent
          const orderRes = await fetch('http://127.0.0.1:8200/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'place_winning_order', arguments: {
              store_url: winner.store_url,
              products: (function() {
                console.log('[shopping-agent] bid_items:', JSON.stringify(winner.bid_items.slice(0,2)));
                return winner.bid_items.filter(function(i){ return i.available; }).map(function(i){ return { name: i.matched || i.name, upc: i.upc, qty: i.quantity }; });
              })(),
              customer: { firstName: c.firstName||c.first_name||'', lastName: c.lastName||c.last_name||'', email: c.email||'', address: c.address||'', city: c.city||'', state: c.state||'', zipcode: c.zipcode||zip||'', phone: c.phone||c.phoneNumber||'' },
              tip_amount: input.tip_amount || 0,
              delivery_datetime: input.delivery_datetime || '',
              delivery_instructions: input.delivery_instructions || ''
            }}})
          });
          const orderText = await orderRes.text();
          const orderLine = orderText.split('\n').find(function(l){ return l.startsWith('data:'); });
          if (orderLine) {
            const orderMsg = JSON.parse(orderLine.replace('data:', '').trim());
            const orderResult = JSON.parse(orderMsg.result.content[0].text);
            return Object.assign({}, orderResult, { winning_store: winner.store, all_bids: rfqResult.all_bids });
          }
        } else {
          console.log('[shopping-agent] orchestrator: no winner (coverage < 80%), falling back to direct createOrder');
        }
      }
    } catch(e) {
      console.error('[shopping-agent] orchestrator place_order error:', e.message, '— falling back to direct createOrder');
    }

    // Fallback: direct createOrder via Bevvi API
    const { createOrder } = require('/home/ubuntu/rachel/functions.js');
    const establishmentId = products[0] && products[0].establishmentId ? products[0].establishmentId : '';
    const result = await createOrder({
      products: products,
      customerData: {
        firstName: c.firstName || c.first_name || '',
        lastName:  c.lastName  || c.last_name  || '',
        email:     c.email     || '',
        address:   c.address   || '',
        city:      c.city      || '',
        state:     c.state     || '',
        zipcode:   c.zipcode   || zip || '',
        phone:     c.phone     || c.phoneNumber || ''
      },
      tipAmount:            input.tip_amount || 0,
      deliveryDateTime:     input.delivery_datetime || '',
      deliveryInstructions: input.delivery_instructions || '',
      client:               loc.client,
      establishmentId:      establishmentId
    });
    return result;
  }

  return { error: 'Unknown intent: ' + name };
}

const TOOLS = [
  { name: 'product_query', description: 'Search for specific products. Use for do-you-have or show-me queries.', inputSchema: { type: 'object', properties: { queries: { type: 'array' }, zip: { type: 'string' }, email: { type: 'string' }, min_price: { type: 'number' }, max_price: { type: 'number' } }, required: ['queries', 'zip'] } },
  { name: 'menu_build', description: 'Build event beverage package with guest count and budget.', inputSchema: { type: 'object', properties: { guests: { type: 'number' }, hours: { type: 'number' }, budget: { type: 'number' }, categories: { type: 'array' }, zip: { type: 'string' }, email: { type: 'string' }, package_type: { type: 'string' } }, required: ['guests', 'hours', 'zip'] } },
  { name: 'custom_list', description: 'Build package from named product list with quantities.', inputSchema: { type: 'object', properties: { named_products: { type: 'array' }, zip: { type: 'string' }, email: { type: 'string' }, budget: { type: 'number' } }, required: ['named_products', 'zip'] } },
  { name: 'recommendation', description: 'Get personalized recommendations based on occasion and customer history.', inputSchema: { type: 'object', properties: { occasion: { type: 'string' }, category: { type: 'string' }, zip: { type: 'string' }, email: { type: 'string' }, budget_per_bottle: { type: 'number' } }, required: ['zip'] } },
  { name: 'generate_proposal', description: 'Generate a PDF proposal from the active basket. Returns download URL.', inputSchema: { type: 'object', properties: { email: { type: 'string' }, client_name: { type: 'string' }, event_date: { type: 'string' }, notes: { type: 'string' } }, required: ['email', 'client_name'] } },
  { name: 'place_order', description: 'Place order after customer confirms. Pass line_items from previous result.', inputSchema: { type: 'object', properties: { line_items: { type: 'string' }, customer: { type: 'object' }, tip_amount: { type: 'number' }, delivery_datetime: { type: 'string' }, delivery_instructions: { type: 'string' }, zip: { type: 'string' } }, required: ['line_items', 'customer'] } }
];

function sendSSE(res, data) { res.write('data: ' + JSON.stringify(data) + '\n\n'); }

const server = http.createServer(async function(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '2.0.0' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      try {
        const msg = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        if (msg.method === 'initialize') {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'bevvi-shopping-agent', version: '2.0.0' }, capabilities: { tools: {} } } });
        } else if (msg.method === 'tools/list') {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
        } else if (msg.method === 'tools/call') {
          const result = await executeTool(msg.params.name, msg.params.arguments || {});
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
        } else {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        }
        res.end();
      } catch(e) {
        console.error('[shopping-agent] error:', e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', function() {
  console.log('[shopping-agent] Bevvi Shopping Agent v2 on http://127.0.0.1:' + PORT);
});
