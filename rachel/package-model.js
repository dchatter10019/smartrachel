/**
 * Package Intelligence Model
 * Loads learned splits from GBrain or falls back to file cache
 */
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const GBRAIN_URL = 'http://127.0.0.1:7700/mcp';
const GBRAIN_TOKEN = 'gbrain_71d7392edf8a722d8816739407f1455d13fff00a0c7b12e3afa208b4d081ebf4';
const CACHE_FILE = '/home/ubuntu/logs/package-intelligence.json';

// In-memory cache
let modelCache = null;
let modelLoadedAt = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function loadModel() {
  // Return cached model if fresh
  if (modelCache && modelLoadedAt && (Date.now() - modelLoadedAt) < CACHE_TTL) {
    return modelCache;
  }

  // Try GBrain first
  try {
    const res = await fetch(GBRAIN_URL + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GBRAIN_TOKEN },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call',
        params: { name:'get_page', arguments:{ slug:'bevvi/package-intelligence-model' }}})
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data:'));
    if (line) {
      const data = JSON.parse(line.slice(line.indexOf(':')+1).trim());
      const pageText = data?.result?.content?.[0]?.text;
      if (pageText) {
        const page = JSON.parse(pageText);
        const truth = page.compiled_truth || '';
        // Parse the model from compiled truth
        const model = parseModelFromText(truth);
        if (model) {
          modelCache = model;
          modelLoadedAt = Date.now();
          console.log('[package-model] Loaded from GBrain, sample_size:', model.sample_size);
          return model;
        }
      }
    }
  } catch(e) { console.error('[package-model] GBrain load failed:', e.message); }

  // Fall back to file cache
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    modelCache = data;
    modelLoadedAt = Date.now();
    console.log('[package-model] Loaded from file cache');
    return data;
  } catch(e) {}

  return null;
}

function parseModelFromText(text) {
  // Parse category splits
  const splits = {};
  const splitSection = text.match(/## Category Splits.*?\n([\s\S]*?)(?=\n##|$)/);
  if (splitSection) {
    splitSection[1].split('\n').forEach(line => {
      const m = line.match(/- ([^:]+): (\d+)%/);
      if (m) splits[m[1].trim().toLowerCase()] = parseInt(m[2]);
    });
  }

  // Parse subcategory avg prices
  const subcatPrices = {};
  const priceSection = text.match(/## Avg Price by Subcategory\n([\s\S]*?)(?=\n##|$)/);
  if (priceSection) {
    priceSection[1].split('\n').forEach(line => {
      const m = line.match(/- ([^:]+): avg \$([0-9.]+).*?p50 \$([0-9.]+)/);
      if (m) subcatPrices[m[1].trim().toLowerCase()] = { avg: parseFloat(m[2]), p50: parseFloat(m[3]) };
    });
  }

  if (Object.keys(splits).length === 0) return null;
  return { category_splits_pct: splits, subcategory_avg_price: subcatPrices, sample_size: 8772 };
}

/**
 * Get learned category splits for package building
 * Returns normalized splits for requested categories
 */
async function getCategorySplits(requestedCategories) {
  const model = await loadModel();

  // Default splits (fallback)
  const defaults = { wine: 55, liquor: 35, beer: 10 };

  if (!model || !model.category_splits_pct) return defaults;

  const splits = model.category_splits_pct;
  const result = {};
  let total = 0;

  // Get learned split for each requested category
  requestedCategories.forEach(cat => {
    const c = cat.toLowerCase();
    // Map category names
    const mapped = c === 'spirits' ? 'liquor' : c === 'champagne' ? 'wine' : c;
    result[c] = splits[mapped] || splits[c] || defaults[c] || 5;
    total += result[c];
  });

  // Normalize to 100%
  if (total > 0) {
    Object.keys(result).forEach(cat => {
      result[cat] = Math.round(result[cat] / total * 100);
    });
  }

  return result;
}

/**
 * Get learned avg price for a subcategory
 */
async function getSubcategoryPrice(subcategory) {
  const model = await loadModel();
  if (!model || !model.subcategory_avg_price) return null;
  const sub = subcategory.toLowerCase();
  return model.subcategory_avg_price[sub] || null;
}

module.exports = { loadModel, getCategorySplits, getSubcategoryPrice };
