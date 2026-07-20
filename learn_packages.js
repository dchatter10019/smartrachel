/**
 * Bevvi Package Intelligence — learns from real order data
 * Extracts collective signals and stores in GBrain
 */
const { execSync } = require('child_process');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const GBRAIN_CLI = '/home/ubuntu/.bun/bin/bun run /home/ubuntu/gbrain/src/cli.ts';
const END_DATE = new Date().toISOString().split('T')[0];
const START_DATE = new Date(Date.now() - 180*24*60*60*1000).toISOString().split('T')[0]; // 6 months

function log(msg) { console.log('[learn]', msg); }

async function fetchOrders() {
  const res = await fetch(`https://api.getbevvi.com/api/bevviutils/exportTableauDataCsv?startDate=${START_DATE}&endDate=${END_DATE}`);
  const text = await res.text();
  return JSON.parse(text);
}

function groupByOrder(data) {
  const orders = {};
  data.forEach(d => {
    if (!orders[d.orderNumber]) {
      orders[d.orderNumber] = {
        orderNumber: d.orderNumber,
        company: d.companyName,
        customer: d.customerName,
        email: d.customerEmail,
        date: d.orderDate,
        items: [],
        total: 0
      };
    }
    const price = parseFloat(d.price) || 0;
    const qty = parseInt(d.quantity) || 1;
    orders[d.orderNumber].items.push({
      name: d.productName,
      category: d.category || 'Other',
      subCategory: d.subCategory || '',
      price,
      qty,
      spend: price * qty,
      brandInfo: d.brandInfo || '',
      parentBrand: d.parentBrand || ''
    });
    orders[d.orderNumber].total += price * qty;
  });
  return Object.values(orders).filter(o => o.total > 0);
}

function computeCollectiveSignals(orders) {
  // Only use multi-category orders for package learning
  const packageOrders = orders.filter(o => {
    const cats = new Set(o.items.map(i => i.category.toLowerCase()));
    return cats.size > 1 && o.total > 50;
  });

  log(`Package orders (multi-category): ${packageOrders.length} of ${orders.length}`);

  // Compute real category splits
  const splitAccum = {};
  const splitCount = {};
  
  packageOrders.forEach(o => {
    const catSpend = {};
    o.items.forEach(i => {
      const cat = i.category.toLowerCase();
      catSpend[cat] = (catSpend[cat] || 0) + i.spend;
    });
    const total = Object.values(catSpend).reduce((a,b)=>a+b, 0);
    Object.entries(catSpend).forEach(([cat, spend]) => {
      if (!splitAccum[cat]) { splitAccum[cat] = 0; splitCount[cat] = 0; }
      splitAccum[cat] += spend / total;
      splitCount[cat]++;
    });
  });

  const splits = {};
  Object.keys(splitAccum).forEach(cat => {
    splits[cat] = Math.round(splitAccum[cat] / packageOrders.length * 100);
  });

  // Compute subcategory preferences within each category
  const subcatPrefs = {};
  orders.forEach(o => {
    o.items.forEach(i => {
      const cat = i.category.toLowerCase();
      const sub = i.subCategory.toLowerCase();
      if (!sub) return;
      if (!subcatPrefs[cat]) subcatPrefs[cat] = {};
      subcatPrefs[cat][sub] = (subcatPrefs[cat][sub] || 0) + i.spend;
    });
  });

  // Normalize subcategory preferences to percentages
  const subcatSplits = {};
  Object.entries(subcatPrefs).forEach(([cat, subs]) => {
    const total = Object.values(subs).reduce((a,b)=>a+b, 0);
    subcatSplits[cat] = {};
    Object.entries(subs)
      .sort((a,b)=>b[1]-a[1])
      .slice(0, 8)
      .forEach(([sub, spend]) => {
        subcatSplits[cat][sub] = Math.round(spend/total*100);
      });
  });

  // Avg price per subcategory
  const subcatPrices = {};
  orders.forEach(o => {
    o.items.forEach(i => {
      const sub = i.subCategory.toLowerCase();
      if (!sub) return;
      if (!subcatPrices[sub]) subcatPrices[sub] = [];
      subcatPrices[sub].push(i.price);
    });
  });
  const subcatAvgPrice = {};
  Object.entries(subcatPrices).forEach(([sub, prices]) => {
    if (prices.length < 3) return; // need at least 3 data points
    const avg = prices.reduce((a,b)=>a+b,0)/prices.length;
    const sorted = [...prices].sort((a,b)=>a-b);
    subcatAvgPrice[sub] = {
      avg: Math.round(avg*100)/100,
      min: sorted[0],
      max: sorted[sorted.length-1],
      p50: sorted[Math.floor(sorted.length*0.5)],
      count: prices.length
    };
  });

  // Drinks per $ (how much product per dollar of budget)
  const avgOrderValue = orders.reduce((a,o)=>a+o.total,0)/orders.length;
  const avgItemsPerOrder = orders.reduce((a,o)=>a+o.items.length,0)/orders.length;

  // Top brands by category
  const brandsByCategory = {};
  orders.forEach(o => {
    o.items.forEach(i => {
      const cat = i.category.toLowerCase();
      const brand = i.parentBrand || i.brandInfo;
      if (!brand) return;
      if (!brandsByCategory[cat]) brandsByCategory[cat] = {};
      brandsByCategory[cat][brand] = (brandsByCategory[cat][brand] || 0) + i.spend;
    });
  });
  const topBrandsByCategory = {};
  Object.entries(brandsByCategory).forEach(([cat, brands]) => {
    topBrandsByCategory[cat] = Object.entries(brands)
      .sort((a,b)=>b[1]-a[1])
      .slice(0,10)
      .map(([brand]) => brand);
  });

  return {
    computed_at: new Date().toISOString(),
    sample_size: orders.length,
    package_orders: packageOrders.length,
    avg_order_value: Math.round(avgOrderValue*100)/100,
    avg_items_per_order: Math.round(avgItemsPerOrder*10)/10,
    category_splits_pct: splits,
    subcategory_splits_pct: subcatSplits,
    subcategory_avg_price: subcatAvgPrice,
    top_brands_by_category: topBrandsByCategory
  };
}

function saveToGBrain(signals) {
  const content = `# Bevvi Package Intelligence Model

## Computed At
${signals.computed_at}

## Sample Size
- Total orders: ${signals.sample_size}
- Package orders (multi-category): ${signals.package_orders}
- Avg order value: $${signals.avg_order_value}
- Avg items per order: ${signals.avg_items_per_order}

## Category Splits (% of spend in mixed orders)
${Object.entries(signals.category_splits_pct).map(([cat,pct])=>`- ${cat}: ${pct}%`).join('\n')}

## Subcategory Splits by Category
${Object.entries(signals.subcategory_splits_pct).map(([cat,subs])=>`### ${cat}\n${Object.entries(subs).map(([sub,pct])=>`- ${sub}: ${pct}%`).join('\n')}`).join('\n\n')}

## Avg Price by Subcategory
${Object.entries(signals.subcategory_avg_price).map(([sub,p])=>`- ${sub}: avg $${p.avg}, p50 $${p.p50}, range $${p.min}-$${p.max} (n=${p.count})`).join('\n')}

## Top Brands by Category
${Object.entries(signals.top_brands_by_category).map(([cat,brands])=>`- ${cat}: ${brands.slice(0,5).join(', ')}`).join('\n')}
`;

  const slug = 'bevvi/package-intelligence-model';
  const frontmatter = JSON.stringify({ type: 'ml_model', computed_at: signals.computed_at, sample_size: signals.sample_size });
  
  try {
    execSync(`${GBRAIN_CLI} put "${slug}"`, {
      input: `---\n${frontmatter}\n---\n${content}`,
      encoding: 'utf8',
      cwd: '/home/ubuntu/gbrain'
    });
    log('Saved to GBrain: ' + slug);
  } catch(e) {
    log('GBrain save failed: ' + e.message);
    // Save to file as backup
    require('fs').writeFileSync('/home/ubuntu/logs/package-intelligence.json', JSON.stringify(signals, null, 2));
    log('Saved to file: /home/ubuntu/logs/package-intelligence.json');
  }
}

async function main() {
  log('Fetching orders ' + START_DATE + ' to ' + END_DATE);
  const data = await fetchOrders();
  log('Got ' + data.length + ' line items');
  
  const orders = groupByOrder(data);
  log('Grouped into ' + orders.length + ' orders');
  
  const signals = computeCollectiveSignals(orders);
  log('Category splits: ' + JSON.stringify(signals.category_splits_pct));
  log('Top subcats: ' + Object.keys(signals.subcategory_avg_price).slice(0,5).join(', '));
  
  saveToGBrain(signals);
  
  // Also save locally for use by buildPackage
  require('fs').writeFileSync('/home/ubuntu/logs/package-intelligence.json', JSON.stringify(signals, null, 2));
  log('Done — model saved');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
