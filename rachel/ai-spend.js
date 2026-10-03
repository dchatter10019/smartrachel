// AI spend ledger (DC, Oct 3: "no visibility into total AI spend"). Every Anthropic call Rachel's code makes records its
// usage + dollar cost here — one JSON line per call in logs/ai-spend.jsonl — so ops/ai-spend.py can report yesterday and
// month to date, split customers vs tests (nightly QA Slack summary). Never throws: a failed write only logs.
// Callers: rachel.js (main), classify-intent.js, server.js (image reading), store-agent reviewer.js + catalog-guard.js,
// qa/run.py (judge, Python, same format). The fixer keeps its own ledger (logs/fixer/spend.jsonl); the report merges it.
const fs = require('fs');

const FILE = process.env.AI_SPEND_FILE || '/home/ubuntu/logs/ai-spend.jsonl';
// $ per million tokens: [input, 5-min cache write, cache read, output]. Anthropic list prices (claude-api skill, Oct 3).
const PRICES = {
  'claude-sonnet-4-6': [3, 3.75, 0.30, 15],
  'claude-sonnet-5-5': [2, 2.50, 0.20, 10],
  'claude-haiku-4-5': [1, 1.25, 0.10, 5],
  'claude-opus-5-5': [4, 5.00, 0.20, 20],
  'claude-opus-5': [5, 6.25, 0.50, 25],
};
const WEB_SEARCH_USD = 0.01;   // $10 per 1,000 searches

function priceOf(model) {
  const m = String(model || '');
  const k = Object.keys(PRICES).sort((a, b) => b.length - a.length).find(p => m === p || m.startsWith(p + '-'));   // "claude-haiku-4-5-20251001"
  return k ? PRICES[k] : null;
}

function cost(model, u) {
  const p = priceOf(model); if (!p || !u) return null;
  const ws = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return ((u.input_tokens || 0) * p[0] + (u.cache_creation_input_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.output_tokens || 0) * p[3]) / 1e6 + ws * WEB_SEARCH_USD;
}

// A test, not a customer: staging (QA_MODE), a QA session (log-tag's «qa-…» context), or the caller says so (QA emails).
function isTest(qa) {
  if (qa || process.env.QA_MODE === '1') return true;
  try { const t = require('./log-tag.js').currentTag(); if (t) return true; } catch (e) {}
  return false;
}

function record(kind, model, usage, opts = {}) {
  try {
    const usd = cost(model, usage);
    if (usd == null) console.log('[ai-spend] no price for model ' + JSON.stringify(model) + ' (' + kind + ') — recorded with usd null');
    const u = usage || {};
    const row = { ts: new Date().toISOString(), kind, model, test: isTest(opts.qa), env: process.env.QA_MODE === '1' ? 'staging' : 'prod',
      in: u.input_tokens || 0, cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0,
      ws: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0, usd: usd == null ? null : Math.round(usd * 1e6) / 1e6 };
    fs.appendFile(FILE, JSON.stringify(row) + '\n', e => { if (e) console.log('[ai-spend] write failed: ' + e.message); });
    return usd;
  } catch (e) { console.log('[ai-spend] record failed: ' + e.message); return null; }
}

module.exports = { record, cost, priceOf, PRICES, FILE };
