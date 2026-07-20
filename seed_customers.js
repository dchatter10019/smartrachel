#!/usr/bin/env node
const { execSync } = require('child_process');

const GBRAIN_CLI = '/home/ubuntu/.bun/bin/bun run /home/ubuntu/gbrain/src/cli.ts';
const TABLEAU_API = 'https://api.getbevvi.com/api/bevviutils/exportTableauDataCsv';
const STORE_API   = 'https://api.getbevvi.com/api/bevviutils/getAllStoreTransactionsReportCsv';

const END_DATE   = new Date().toISOString().split('T')[0];
const START_DATE = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

function log(msg) { console.log(`[seed] ${msg}`); }
function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function formatCurrency(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function classifyCustomer(name) {
  if (!name) return { type: 'direct', parent: null };
  const n = name.toLowerCase();
  if (n.includes('air culinaire')) return { type: 'aviation', parent: 'Air Culinaire' };
  if (n.includes('vistajet'))      return { type: 'aviation', parent: 'VistaJet' };
  if (n.includes('sendoso'))       return { type: 'gifting',  parent: 'Sendoso' };
  if (n.includes('ongoody') || n.includes('goody')) return { type: 'gifting', parent: 'OnGoody' };
  if (n.includes('reachdesk'))     return { type: 'gifting',  parent: 'Reachdesk' };
  return { type: 'direct', parent: null };
}

async function fetchLineItems() {
  log(`Fetching line items ${START_DATE} to ${END_DATE}`);
  const res = await fetch(`${TABLEAU_API}?startDate=${START_DATE}&endDate=${END_DATE}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  log(`Fetched ${data.length} line items`);
  return data;
}

async function buildEmailStoreMap() {
  log(`Building email→store map`);
  const res1 = await fetch(`${TABLEAU_API}?startDate=${START_DATE}&endDate=${END_DATE}`);
  const items = await res1.json();
  const orderEmailMap = {};
  for (const item of items) {
    if (item.customerEmail && item.orderNumber) {
      orderEmailMap[item.orderNumber] = item.customerEmail;
    }
  }
  const res2 = await fetch(`${STORE_API}?startDate=${START_DATE}&endDate=${END_DATE}`);
  const json = await res2.json();
  const lines = json.results.split('\r\n').filter(l => l.trim());
  const emailStores = {};
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length < 16) continue;
    const orderNum = parts[0].replace(/"/g,'').trim();
    const store    = parts[15].replace(/"/g,'').trim();
    if (!orderNum || !store || store.startsWith('{')) continue;
    const email = orderEmailMap[orderNum];
    if (!email) continue;
    if (!emailStores[email]) emailStores[email] = new Set();
    emailStores[email].add(store);
  }
  log(`Built email→store map for ${Object.keys(emailStores).length} emails`);
  return emailStores;
}

function topN(map, n) {
  return Object.entries(map)
    .sort(([,a],[,b]) => b - a)
    .slice(0, n)
    .map(([k]) => k);
}

function aggregateByCustomer(items, emailStoreMap) {
  const customers = {};

  for (const item of items) {
    const name = item.customerName || '';
    if (!name) continue;

    if (!customers[name]) {
      const { type, parent } = classifyCustomer(name);
      customers[name] = {
        name,
        type,
        parent,
        email: item.customerEmail || '',
        total_gmv: 0,
        order_count: 0,
        orders: new Set(),
        order_dates: [],
        months: {},
        // Product intelligence
        products: {},      // productName → count
        categories: {},    // category → spend
        brands: {},        // brandInfo → count
        prices: [],        // all line item prices
        subcat_prices: {},  // subCategory → [prices]
        items_per_order: {},  // orderNumber → item count
      };
    }

    const c = customers[name];
    const price     = parseFloat(item.price) || 0;
    const qty       = parseInt(item.quantity) || 1;
    const lineTotal = price * qty;

    c.total_gmv += lineTotal;
    c.orders.add(item.orderNumber);
    if (item.customerEmail && !c.email) c.email = item.customerEmail;

    // Order dates
    if (item.orderDate) c.order_dates.push(item.orderDate);

    // Monthly
    const parts = (item.orderDate || '').split('/');
    if (parts.length === 3) {
      const month = `${parts[2].replace(/[^0-9]/g,'')}-${parts[0].replace(/[^0-9]/g,'').padStart(2,'0')}`;
      c.months[month] = (c.months[month] || 0) + lineTotal;
    }

    // Products
    if (item.productName) {
      c.products[item.productName] = (c.products[item.productName] || 0) + qty;
    }

    // Categories
    if (item.category) {
      c.categories[item.category] = (c.categories[item.category] || 0) + lineTotal;
    }

    // Brands
    if (item.brandInfo) {
      c.brands[item.brandInfo] = (c.brands[item.brandInfo] || 0) + qty;
    }

    // Prices for avg item price
    if (price > 0) c.prices.push(price);

    // Per-subcategory prices
    if (price > 0 && item.subCategory) {
      const sub = item.subCategory.trim();
      if (!c.subcat_prices[sub]) c.subcat_prices[sub] = [];
      c.subcat_prices[sub].push(price);
    }

    // Items per order
    if (item.orderNumber) {
      c.items_per_order[item.orderNumber] = (c.items_per_order[item.orderNumber] || 0) + qty;
    }
  }

  // Post-process
  for (const c of Object.values(customers)) {
    c.order_count = c.orders.size;

    // Retailers from store map
    const stores = c.email ? (emailStoreMap[c.email] || new Set()) : new Set();
    c.retailers = [...stores];

    // Avg order value
    c.avg_order_value = c.order_count > 0 ? c.total_gmv / c.order_count : 0;

    // Avg item price
    c.avg_item_price = c.prices.length > 0
      ? c.prices.reduce((a, b) => a + b, 0) / c.prices.length
      : 0;

    // Avg items per order
    const itemCounts = Object.values(c.items_per_order);
    c.avg_items_per_order = itemCounts.length > 0
      ? Math.round(itemCounts.reduce((a, b) => a + b, 0) / itemCounts.length)
      : 0;

    // Last order date
    const sorted = [...c.order_dates].sort();
    c.last_order_date = sorted[sorted.length - 1] || '';
    c.first_order_date = sorted[0] || '';

    // Order frequency (orders per month)
    const monthCount = Object.keys(c.months).length;
    c.orders_per_month = monthCount > 0 ? Math.round(c.order_count / monthCount) : 0;

    // Top products, categories, brands
    c.top_products  = topN(c.products, 5);
    c.top_categories = topN(c.categories, 3);
    c.top_brands    = topN(c.brands, 5);

    // Price tier
    if (c.avg_item_price >= 100)     c.price_tier = 'premium ($100+)';
    else if (c.avg_item_price >= 50) c.price_tier = 'mid-range ($50-100)';
    else if (c.avg_item_price >= 20) c.price_tier = 'value ($20-50)';
    else                             c.price_tier = 'budget (under $20)';

    // Dominant category
    c.dominant_category = c.top_categories[0] || 'N/A';
  }

  return customers;
}

function buildCustomerPage(c) {
  const monthLines = Object.entries(c.months)
    .sort(([a], [b]) => b.localeCompare(a)).slice(0, 6)
    .map(([m, v]) => `  - ${m}: ${formatCurrency(v)}`).join('\n');

  const retailerList  = c.retailers.length > 0 ? c.retailers.join(', ') : 'N/A';
  const productList   = c.top_products.length > 0 ? c.top_products.join(', ') : 'N/A';
  const brandList     = c.top_brands.length > 0 ? c.top_brands.join(', ') : 'N/A';
  const categoryList  = c.top_categories.length > 0 ? c.top_categories.join(', ') : 'N/A';

  return `---
type: customer
name: ${c.name}
email: ${c.email}
customer_type: ${c.type}
parent_account: ${c.parent || 'N/A'}
status: active
seeded: ${new Date().toISOString().split('T')[0]}
---

# ${c.name}

## Compiled Truth
- Email: ${c.email}
- Type: ${c.type}
- Parent account: ${c.parent || 'N/A'}
- Retailers: ${retailerList}

## Spend Profile
- 90-day GMV: ${formatCurrency(c.total_gmv)}
- Orders (90d): ${c.order_count}
- Avg order value: ${formatCurrency(c.avg_order_value)}
- Avg item price: ${formatCurrency(c.avg_item_price)}
- Avg items per order: ${c.avg_items_per_order}
- Price tier: ${c.price_tier}

## Price Profile by Category
${Object.entries(c.subcat_prices || {})
  .map(([sub, prices]) => {
    const avg = prices.reduce((a,b)=>a+b,0)/prices.length;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return '- ' + sub + ': avg $' + avg.toFixed(2) + ', range $' + min.toFixed(2) + '-$' + max.toFixed(2) + ' (' + prices.length + ' items)';
  })
  .filter(l => l)
  .sort()
  .join('\n')}
- Orders per month: ${c.orders_per_month}
- First order: ${c.first_order_date}
- Last order: ${c.last_order_date}

## Preferences
- Dominant category: ${c.dominant_category}
- Top categories: ${categoryList}
- Top brands: ${brandList}
- Top products: ${productList}

## Monthly Spend (last 6 months)
${monthLines || '  - No monthly data available'}

## Timeline
- ${new Date().toISOString().split('T')[0]}: Seeded from Bevvi API (90-day window)
`;
}

function ingestPage(slug, content) {
  try {
    execSync(`${GBRAIN_CLI} put "customers/${slug}"`, { input: content, encoding: 'utf8', cwd: '/home/ubuntu/gbrain' });
    log(`  wrote: customers/${slug}`);
    return true;
  } catch (err) {
    log(`  WARN: ${slug} -- ${err.message.slice(0, 100)}`);
    return false;
  }
}

async function main() {
  log('Starting enriched Bevvi customer seed...');

  const [items, emailStoreMap] = await Promise.all([
    fetchLineItems(),
    buildEmailStoreMap()
  ]);

  const customers = aggregateByCustomer(items, emailStoreMap);
  const customerList = Object.values(customers).sort((a, b) => b.total_gmv - a.total_gmv);
  log(`Found ${customerList.length} customers`);

  let success = 0, failed = 0;
  for (const c of customerList) {
    const ok = ingestPage(slugify(c.name), buildCustomerPage(c));
    if (ok) success++; else failed++;
  }

  log('');
  log('=== SEED COMPLETE ===');
  log(`Success: ${success} | Failed: ${failed}`);
  log('Top 5 customers:');
  customerList.slice(0, 5).forEach((c, i) =>
    log(`  ${i+1}. ${c.name} | ${c.price_tier} | top: ${c.top_brands.slice(0,2).join(', ')} | ${formatCurrency(c.total_gmv)}`)
  );
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
