#!/usr/bin/env node
// Catalog sweep (MANUAL, not scheduled — DC will run it as a separate process once Bevvi's
// full store-id list is available): search every store's catalog for common products, run the catalog
// guard's checks (store-agent/catalog-guard.js) on the results, and post ONE cleanup report
// to the QA Slack channel. The guard alone only reports rows that customers happen to search
// for; this covers the catalog. An issue is reported every night until the listing is fixed.
//
//   node catalog-sweep.js            sweep + post to Slack
//   node catalog-sweep.js --dry      sweep + print the report, no Slack post
//
// Regions: one sample zip per store region, from the orchestrator STORE_REGISTRY and the
// shopping-agent zip table (verified to return products). TEMPORARY — to be replaced by
// Bevvi's own establishment list (DC to provide), so new stores are picked up automatically.
const fs = require('fs');
const { screen, lookupMarket } = require('./catalog-guard.js');

const REGIONS = [
  { name: 'NYC (Manor)', zip: '10019' },
  { name: 'Boston (Revere)', zip: '02110' },
  { name: 'San Francisco', zip: '94104' },
  { name: 'NJ (LiquorMaster / Teterboro)', zip: '07608' },
  { name: 'Dallas (Dallas Fine Wine)', zip: '75201' },
  { name: 'Miami (Aficionados)', zip: '33131' },
  { name: "Scottsdale (Sam's)", zip: '85260' },   // 85251 etc. return nothing from Bevvi
];
const QUERIES = ['vodka', 'tequila', 'mezcal', 'gin', 'rum', 'bourbon', 'whiskey', 'scotch', 'cognac', 'liqueur',
  'champagne', 'prosecco', 'sparkling wine', 'rose', 'sauvignon blanc', 'chardonnay', 'pinot grigio', 'pinot noir',
  'cabernet', 'merlot', 'malbec', 'red blend', 'beer', 'ipa', 'lager', 'seltzer', 'cider', 'non-alcoholic', 'mixers',
  "tito's", 'grey goose', 'ketel one', 'belvedere', 'patron', 'don julio', 'casamigos', 'clase azul', 'jack daniels',
  'makers mark', 'johnnie walker', 'macallan', 'jameson', 'hennessy', 'bacardi', 'aperol', 'veuve clicquot', 'moet',
  'dom perignon', 'whispering angel', 'kim crawford', 'la marca', 'josh cellars', 'meiomi', 'corona', 'stella artois',
  'heineken', 'modelo', 'white claw', 'high noon', 'fever tree'];
const MAX_MARKET_LOOKUPS = 12;   // web lookups per night for duplicates with no cached market price (~cents each)
const DRY = process.argv.includes('--dry');

const env = {};
try { for (const l of fs.readFileSync('/etc/rachel.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); } } catch (e) {}
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN || '';
const SLACK_CHANNEL = process.env.QA_SLACK_CHANNEL || env.QA_SLACK_CHANNEL || '';

async function search(zip, q) {
  const url = 'https://api-client.getbevvi.com/api/corpproducts/searchCorpProducts?zipcode=' + zip + '&searchBy=' + encodeURIComponent(q) + '&client=bevvibot&limit=50';
  for (let a = 0; a < 2; a++) {
    try { const r = await fetch(url); const d = await r.json(); return Array.isArray(d) ? d : []; } catch (e) { if (a) console.error('[sweep] search failed', zip, q, e.message); }
  }
  return [];
}
const price = p => Number(p.salePrice || p.price || 0);
const kind = reason => /^DUPLICATE|^duplicate/.test(reason) ? 'Duplicate listings' : /size/.test(reason) ? 'Size doesn\'t match' : /name/.test(reason) ? 'Bad names' : 'Price out of line';

async function main() {
  const t0 = Date.now();
  // Pass 1: fetch every region x query once.
  const results = [];   // { region, zip, q, rows }
  for (const r of REGIONS) {
    for (let i = 0; i < QUERIES.length; i += 6) {
      const batch = QUERIES.slice(i, i + 6);
      const got = await Promise.all(batch.map(q => search(r.zip, q)));
      batch.forEach((q, k) => results.push({ region: r, zip: r.zip, q, rows: got[k] }));
    }
  }
  // Market prices for duplicates not yet priced (capped), so the report can say which row is right.
  const probes = new Map();
  for (const x of results) for (const g of screen(x.rows, x.zip).pending) {
    const key = x.zip + '|' + g.probe.name;
    if (!probes.has(key)) probes.set(key, { p: g.probe, zip: x.zip });
  }
  let looked = 0;
  for (const { p, zip } of probes.values()) { if (looked >= MAX_MARKET_LOOKUPS) break; await lookupMarket(p, zip); looked++; }
  // Pass 2: screen again (in memory) with the market prices, collect issues per region.
  const byRegion = new Map();
  for (const x of results) {
    const { hidden } = screen(x.rows, x.zip);
    const m = byRegion.get(x.region.name) || new Map(); byRegion.set(x.region.name, m);
    for (const h of hidden) {
      const id = h.product.id || h.product.upc || h.product.name;
      if (!m.has(id)) m.set(id, { product: h.product, reason: h.reason });
    }
  }
  const total = [...byRegion.values()].reduce((a, m) => a + m.size, 0);
  const rowsSeen = results.reduce((a, x) => a + x.rows.length, 0);
  console.log('[sweep] ' + REGIONS.length + ' regions x ' + QUERIES.length + ' searches, ' + rowsSeen + ' rows, ' + total + ' issues, ' + looked + ' market lookups, ' + Math.round((Date.now() - t0) / 1000) + 's');

  // Report: one message per region (keeps each under Slack's length limit), with a header.
  const stamp = new Date().toISOString().slice(0, 10);
  const header = ':broom: *Catalog cleanup report — ' + stamp + '*\n' + total + ' listing' + (total === 1 ? '' : 's') + ' need checking across ' + REGIONS.length + ' store regions (' + rowsSeen + ' rows from ' + QUERIES.length + ' searches each). Rachel hides these from customers until they\'re fixed.\n' +
    REGIONS.map(r => '• ' + r.name + ': ' + ((byRegion.get(r.name) || new Map()).size)).join('\n') +
    '\n_Stores come from Rachel\'s own lists for now (' + REGIONS.length + ' regions); Bevvi\'s store list will replace them._';
  const messages = [header];
  for (const r of REGIONS) {
    const m = byRegion.get(r.name); if (!m || !m.size) continue;
    const groups = {};
    for (const it of m.values()) (groups[kind(it.reason)] = groups[kind(it.reason)] || []).push(it);
    let txt = '*' + r.name + ' — zip ' + r.zip + ' — ' + m.size + ' issue' + (m.size === 1 ? '' : 's') + '*';
    for (const [g, items] of Object.entries(groups)) {
      txt += '\n\n_' + g + '_';
      for (const it of items) txt += '\n• *' + it.product.name + '* $' + price(it.product).toFixed(2) + ' — ' + it.reason + '\n   id `' + (it.product.id || '?') + '` · UPC `' + (it.product.upc || '?') + '` · store `' + (it.product.establishmentId || '?') + '`';
    }
    // Slack caps a message around 40k chars; split long regions.
    while (txt.length > 3800) { const cut = txt.lastIndexOf('\n• ', 3800); messages.push(txt.slice(0, cut)); txt = '*' + r.name + ' (cont.)*' + txt.slice(cut); }
    messages.push(txt);
  }
  try {
    fs.mkdirSync('/home/ubuntu/logs/catalog-sweep', { recursive: true });
    fs.writeFileSync('/home/ubuntu/logs/catalog-sweep/' + stamp + '.json', JSON.stringify({ stamp, total, rowsSeen, regions: REGIONS, issues: Object.fromEntries([...byRegion].map(([k, m]) => [k, [...m.values()].map(it => ({ name: it.product.name, price: price(it.product), reason: it.reason, id: it.product.id, upc: it.product.upc, store: it.product.establishmentId }))])) }, null, 1));
  } catch (e) { console.error('[sweep] could not save report:', e.message); }
  if (DRY || !SLACK_TOKEN || !SLACK_CHANNEL) { console.log(messages.join('\n\n────────\n\n')); if (!DRY) console.log('[sweep] Slack not configured — report printed only'); return; }
  for (const text of messages) {
    const r = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: SLACK_CHANNEL, text }) }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) console.error('[sweep] Slack post failed:', r.error);
  }
  console.log('[sweep] posted ' + messages.length + ' message(s) to Slack');
}
main().catch(e => { console.error('[sweep] failed:', e); process.exit(1); });
