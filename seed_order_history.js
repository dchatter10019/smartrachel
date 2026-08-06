#!/usr/bin/env node
// Incremental order-history sync into GBrain.
// Unlike seed_customers.js (which rebuilds 90-day aggregate profiles every night),
// this script only fetches orders newer than the last successful sync, using a
// checkpoint file, and writes one GBrain page PER ORDER at orders/{email-slug}/{orderNumber}.
// This lets shopping-agent's order_history intent answer "what did I buy before"
// with real itemized past orders, not just aggregate stats.

const { execSync } = require('child_process');
const fs = require('fs');

const GBRAIN_CLI = '/home/ubuntu/.bun/bin/bun run /home/ubuntu/gbrain/src/cli.ts';
const GBRAIN_URL = 'http://127.0.0.1:7700';
const GBRAIN_TOKEN = 'gbrain_71d7392edf8a722d8816739407f1455d13fff00a0c7b12e3afa208b4d081ebf4';
const GBRAIN_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${GBRAIN_TOKEN}`,
  'Accept': 'application/json, text/event-stream'
};
const TABLEAU_API = 'https://api.getbevvi.com/api/bevviutils/exportTableauDataCsv';
const STORE_API   = 'https://api.getbevvi.com/api/bevviutils/getAllStoreTransactionsReportCsv';
const CHECKPOINT_PATH = '/home/ubuntu/logs/order-history-checkpoint.json';

// MCP HTTP put_page — unlike the CLI's `put` command (which requires an existing page
// and fails with "Page not found" on brand-new slugs), the MCP put_page tool reliably
// creates new pages. This is the same mechanism rachel/gbrain.js uses for saveD2CSession.
async function gbrainPutPage(slug, content) {
  const res = await fetch(`${GBRAIN_URL}/mcp`, {
    method: 'POST',
    headers: GBRAIN_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name: 'put_page', arguments: { slug, content } }
    })
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  if (!line) throw new Error('No response from gbrain MCP');
  const msg = JSON.parse(line.replace('data:', '').trim());
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  return msg.result?.content?.[0]?.text || null;
}

async function gbrainPageExists(slug) {
  try {
    const res = await fetch(`${GBRAIN_URL}/mcp`, {
      method: 'POST',
      headers: GBRAIN_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: { name: 'get_page', arguments: { slug } }
      })
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data:'));
    if (!line) return false;
    const msg = JSON.parse(line.replace('data:', '').trim());
    if (msg.error) return false;
    const content = msg.result?.content?.[0]?.text || '';
    // get_page on a missing slug typically returns an error or empty/"not found" text
    // rather than throwing — treat empty or explicit not-found text as non-existent.
    if (!content || /not found/i.test(content)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// First run: look back 90 days (matches seed_customers.js window). After that,
// the checkpoint drives the start date, so nightly runs only fetch a day or two.
const DEFAULT_LOOKBACK_DAYS = 90;
// Overlap the window by 1 day behind the checkpoint to absorb any late-arriving
// or backend-processing-delayed order rows. Writes are idempotent (skip if the
// order's page already exists), so overlap is safe and cheap.
const OVERLAP_DAYS = 1;

function log(msg) { console.log(`[order-history-sync] ${msg}`); }

function slugifyEmail(email) {
  return (email || '').toLowerCase().replace('@', '-at-').replace(/\./g, '-').replace(/[^a-z0-9-]/g, '');
}

function formatCurrency(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function loadCheckpoint() {
  try {
    const raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8');
    const cp = JSON.parse(raw);
    if (cp && cp.last_synced_date) return cp;
  } catch (e) {
    // No checkpoint yet — first run.
  }
  const fallback = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return { last_synced_date: fallback.toISOString().split('T')[0], last_synced_ts: null };
}

function saveCheckpoint(cp) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

function computeStartDate(checkpoint) {
  const last = new Date(checkpoint.last_synced_date + 'T00:00:00Z');
  const start = new Date(last.getTime() - OVERLAP_DAYS * 24 * 60 * 60 * 1000);
  return start.toISOString().split('T')[0];
}

async function fetchLineItems(startDate, endDate) {
  log(`Fetching line items ${startDate} to ${endDate}`);
  const res = await fetch(`${TABLEAU_API}?startDate=${startDate}&endDate=${endDate}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data.data || data.items || []);
  log(`Fetched ${items.length} line items`);
  return items;
}

// Store name isn't present on the Tableau line-item rows — it lives in a separate
// CSV report keyed by orderNumber. Column 0 = orderNumber, column 15 = store name
// (same parsing seed_customers.js uses for its email→store map).
async function fetchOrderStoreMap(startDate, endDate) {
  log(`Fetching order→store map ${startDate} to ${endDate}`);
  const res = await fetch(`${STORE_API}?startDate=${startDate}&endDate=${endDate}`);
  if (!res.ok) {
    log(`WARNING: store API error ${res.status} — order pages will have blank store names`);
    return {};
  }
  const json = await res.json();
  const lines = (json.results || '').split('\r\n').filter(l => l.trim());
  const orderStore = {};
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length < 16) continue;
    const orderNum = parts[0].replace(/"/g, '').trim();
    const store = parts[15].replace(/"/g, '').trim();
    if (!orderNum || !store || store.startsWith('{')) continue;
    orderStore[orderNum] = store;
  }
  log(`Built order→store map for ${Object.keys(orderStore).length} orders`);
  return orderStore;
}

// Group flat line-item rows into one record per orderNumber.
function groupByOrder(items, orderStoreMap) {
  const orders = {};
  for (const item of items) {
    const orderNum = item.orderNumber;
    const email = (item.customerEmail || '').toLowerCase();
    if (!orderNum || !email) continue;

    if (!orders[orderNum]) {
      orders[orderNum] = {
        order_number: orderNum,
        email,
        customer_name: item.customerName || '',
        order_date: item.orderDate || '',
        store: (orderStoreMap && orderStoreMap[orderNum]) || '',
        items: [],
        grand_total: 0
      };
    }
    const o = orders[orderNum];
    const price = parseFloat(item.price) || 0;
    const qty = parseInt(item.quantity) || 1;
    const lineTotal = price * qty;
    o.items.push({
      name: item.productName || '',
      category: item.category || '',
      brand: item.brandInfo || '',
      qty,
      unit_price: price,
      line_total: lineTotal
    });
    o.grand_total += lineTotal;
    // Keep the earliest-seen non-empty order_date/customer_name in case some rows
    // for the same order are missing fields.
    if (!o.order_date && item.orderDate) o.order_date = item.orderDate;
    if (!o.customer_name && item.customerName) o.customer_name = item.customerName;
  }
  return Object.values(orders);
}



function buildOrderPage(o) {
  const itemLines = o.items
    .map(i => `- ${i.qty}x ${i.name} — ${formatCurrency(i.unit_price)} ea = ${formatCurrency(i.line_total)}${i.category ? ` (${i.category})` : ''}`)
    .join('\n');

  return `---
type: order
order_number: ${o.order_number}
email: ${o.email}
customer_name: ${o.customer_name}
order_date: ${o.order_date}
store: ${o.store}
grand_total: ${o.grand_total.toFixed(2)}
item_count: ${o.items.length}
synced: ${new Date().toISOString().split('T')[0]}
---

# Order ${o.order_number} — ${o.customer_name || o.email}

## Order Details
- Email: ${o.email}
- Date: ${o.order_date}
- Store: ${o.store || 'N/A'}
- Grand total: ${formatCurrency(o.grand_total)}

## Items
${itemLines}
`;
}

async function main() {
  const checkpoint = loadCheckpoint();
  const startDate = computeStartDate(checkpoint);
  const endDate = new Date().toISOString().split('T')[0];

  log(`Checkpoint: last_synced_date=${checkpoint.last_synced_date}. Fetching window ${startDate} → ${endDate} (${OVERLAP_DAYS}d overlap applied).`);

  const items = await fetchLineItems(startDate, endDate);
  const orderStoreMap = await fetchOrderStoreMap(startDate, endDate);
  const orders = groupByOrder(items, orderStoreMap);
  log(`Grouped into ${orders.length} distinct orders`);

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const o of orders) {
    const emailSlug = slugifyEmail(o.email);
    const orderSlug = `orders/${emailSlug}/${o.order_number}`;

    const exists = await gbrainPageExists(orderSlug);
    if (exists) {
      skipped++;
      continue;
    }

    try {
      const content = buildOrderPage(o);
      await gbrainPutPage(orderSlug, content);
      written++;
    } catch (e) {
      log(`FAILED to write ${orderSlug}: ${e.message}`);
      failed++;
    }
  }

  log(`Done. Written: ${written}, already existed (skipped): ${skipped}, failed: ${failed}`);

  // Guard against advancing the checkpoint past data we never actually saved. If every
  // single write in this run failed (e.g. gbrain-mcp was down), leave the checkpoint
  // where it was so the next run retries the same window instead of silently skipping it.
  const attempted = written + failed;
  if (attempted > 0 && written === 0) {
    log(`WARNING: all ${failed} write attempts failed — NOT advancing checkpoint. Fix the underlying issue and re-run.`);
    return;
  }
  if (failed > 0) {
    log(`WARNING: ${failed} orders failed to write this run. Checkpoint will still advance (most orders succeeded), but those specific orders will be retried next run only if they fall within the overlap window — for a full backfill, consider re-running manually now instead of waiting for the next scheduled sync.`);
  }

  saveCheckpoint({ last_synced_date: endDate, last_synced_ts: new Date().toISOString() });
  log(`Checkpoint advanced to ${endDate}`);
}

main().catch(e => {
  console.error('[order-history-sync] FATAL:', e.message);
  process.exit(1);
});
