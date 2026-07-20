#!/usr/bin/env node
const { execSync } = require('child_process');

const GBRAIN_CLI = '/home/ubuntu/.bun/bin/bun run /home/ubuntu/gbrain/src/cli.ts';
const BEVVI_API  = 'https://api.getbevvi.com/api/bevviutils/getAllStoreTransactionsReportCsv';

const END_DATE   = new Date().toISOString().split('T')[0];
const START_DATE = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

function log(msg) { console.log(`[seed] ${msg}`); }
function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function formatCurrency(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Column indices from header:
// 0:ordernum 1:monthYear 2:date 3:customerName 4:revenue 5:giftNoteCharge
// 6:promoDiscAmt 7:tax 8:tip 9:shippingFee 10:deliveryFee 11:serviceCharge
// 12:serviceChargeTax 13:totalAmount 14:status 15:estName ...

function parseRow(line) {
  // Simple split on comma — data is clean, no quoted commas in store names
  // But nested JSON objects appear after field 15, so just take first 16 fields
  const parts = line.split(',');
  if (parts.length < 16) return null;
  const estName = parts[15].trim();
  if (!estName || estName.startsWith('{') || estName.startsWith('pi_')) return null;
  return {
    date:         parts[2].trim(),
    customerName: parts[3].trim(),
    totalAmount:  parseFloat(parts[13]) || 0,
    status:       parts[14].trim(),
    estName:      estName,
  };
}

async function fetchOrders() {
  log(`Fetching orders ${START_DATE} to ${END_DATE}`);
  const res = await fetch(`${BEVVI_API}?startDate=${START_DATE}&endDate=${END_DATE}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const json = await res.json();
  const csv = json.results;
  log(`CSV length: ${csv.length} chars`);

  // Split on \r\n (literal in JSON string, already parsed by JSON.parse)
  const lines = csv.split('\r\n').filter(l => l.trim());
  log(`Lines: ${lines.length} (first: ${lines[0].slice(0,60)})`);

  // Skip header row
  const rows = [];
  for (const line of lines.slice(1)) {
    const row = parseRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

function aggregateByRetailer(orders) {
  const retailers = {};
  for (const o of orders) {
    const store = o.estName;
    if (!retailers[store]) {
      retailers[store] = { name: store, total_gmv: 0, order_count: 0, customers: new Set(), months: {} };
    }
    const r = retailers[store];
    r.total_gmv += o.totalAmount;
    r.order_count += 1;
    if (o.customerName) r.customers.add(o.customerName.replace(/"/g, '').trim());
    const parts = o.date.split('/');
    if (parts.length === 3) {
      const month = `${parts[2].replace(/[^0-9]/g,'')}-${parts[0].replace(/[^0-9]/g,'').padStart(2,'0')}`;
      r.months[month] = (r.months[month] || 0) + o.totalAmount;
    }
  }
  return retailers;
}

function buildRetailerPage(r) {
  const monthLines = Object.entries(r.months)
    .sort(([a], [b]) => b.localeCompare(a)).slice(0, 6)
    .map(([m, v]) => `  - ${m}: ${formatCurrency(v)}`).join('\n');
  const avgOrder = r.order_count > 0 ? r.total_gmv / r.order_count : 0;
  const customerList = [...r.customers].filter(Boolean).slice(0, 10).join(', ') || 'N/A';

  return `---
type: retailer
name: ${r.name}
status: active
seeded: ${new Date().toISOString().split('T')[0]}
---

# ${r.name}

## Compiled Truth
- 90-day GMV: ${formatCurrency(r.total_gmv)}
- Orders (90d): ${r.order_count}
- Avg order value: ${formatCurrency(avgOrder)}
- Unique customers: ${r.customers.size}
- Top customers: ${customerList}

## Monthly GMV (last 6 months)
${monthLines || '  - No monthly data available'}

## Timeline
- ${new Date().toISOString().split('T')[0]}: Seeded from Bevvi transaction API (90-day window)
`;
}

function ingestPage(slug, content) {
  try {
    execSync(`${GBRAIN_CLI} put "retailers/${slug}"`, { input: content, encoding: 'utf8', cwd: '/home/ubuntu/gbrain' });
    log(`  wrote: retailers/${slug}`);
    return true;
  } catch (err) {
    log(`  WARN: ${slug} -- ${err.message.slice(0, 120)}`);
    return false;
  }
}

async function main() {
  log('Starting Bevvi retailer seed...');
  const orders = await fetchOrders();
  log(`Parsed ${orders.length} orders`);
  if (orders.length === 0) { log('No orders parsed.'); process.exit(0); }

  log(`Sample: store="${orders[0].estName}" customer="${orders[0].customerName}" total=${orders[0].totalAmount}`);

  const retailers = aggregateByRetailer(orders);
  const retailerList = Object.values(retailers).sort((a, b) => b.total_gmv - a.total_gmv);
  log(`Found ${retailerList.length} retailers`);

  let success = 0, failed = 0;
  for (const r of retailerList) {
    const ok = ingestPage(slugify(r.name), buildRetailerPage(r));
    if (ok) success++; else failed++;
  }

  log('');
  log('=== SEED COMPLETE ===');
  log(`Success: ${success} | Failed: ${failed}`);
  log('');
  log('Retailers by GMV:');
  retailerList.forEach((r, i) => log(`  ${i+1}. ${r.name} -- ${formatCurrency(r.total_gmv)} (${r.order_count} orders)`));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
