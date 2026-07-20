/**
 * Bevvi Preferred Brand Classification
 * Reads from brand-lists.md — edit that file to add/remove brands
 * Preferred = sponsored partner brands that get ⭐ and shown first
 */

const fs = require('fs');
const path = require('path');
const MD_FILE = path.join(__dirname, 'brand-lists.md');

let _preferred = null;
let _loadedAt = null;
const CACHE_TTL = 60 * 60 * 1000; // reload every hour

function loadPreferred() {
  const now = Date.now();
  if (_preferred && _loadedAt && (now - _loadedAt) < CACHE_TTL) return;
  try {
    const md = fs.readFileSync(MD_FILE, 'utf8');
    const preferred = [];
    let inPreferred = false;
    md.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed === '## PREFERRED') { inPreferred = true; return; }
      if (trimmed.startsWith('## ')) { inPreferred = false; return; }
      if (trimmed.startsWith('#') || trimmed === '') return;
      if (inPreferred) {
        trimmed.split(',').map(b => b.trim().toLowerCase()).filter(b => b.length > 0).forEach(b => preferred.push(b));
      }
    });
    _preferred = preferred;
    _loadedAt = now;
    console.log('[brand-lists] Loaded', preferred.length, 'preferred brands from MD');
  } catch(e) {
    console.error('[brand-lists] Failed to load MD:', e.message);
    _preferred = _preferred || [];
  }
}

function classifyProduct(productName) {
  loadPreferred();
  const lower = (productName || '').toLowerCase();
  for (const phrase of _preferred) {
    if (lower.includes(phrase)) {
      return { preferred: true, matched: phrase };
    }
  }
  return { preferred: false };
}

function flagProduct(product) {
  return { ...product, preferred: classifyProduct(product.name || '').preferred };
}

module.exports = { classifyProduct, flagProduct };
