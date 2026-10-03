// Named cocktails -> their ingredients, for a package build outside a Rachel conversation (the Rachel connector's
// rachel_build_package). There are hundreds of cocktails, so the AI works them out (DC, Oct 3) — guided by the same
// rules and recipe examples Rachel follows (prompt.md "Cocktail mode" + 8.3, read live so there is one copy).
// Returns { items: [{name, category}] } or { error } — never a guess, never a full bar as a stand-in.
const fs = require('fs');
const path = require('path');

const MODEL = 'claude-sonnet-4-6';
const CATS = ['spirits', 'mixer', 'wine', 'beer'];

function rachelRules() {
  const p = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
  const a = p.indexOf('Cocktail mode:'), b = p.indexOf('Do NOT send a cocktail_ingredients');
  const t = p.indexOf('### 8.3'), u = p.indexOf('### 8.4');
  if (a < 0 || b < a || t < 0 || u < t) throw new Error('prompt.md cocktail sections not found');
  return p.slice(a, b).trim() + '\n\n' + p.slice(t, u).trim();
}

async function expandCocktails(names, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'no ANTHROPIC_API_KEY' };
  let rules;
  try { rules = rachelRules(); } catch (e) { return { error: e.message }; }
  const system = 'You turn named cocktails into the ingredients to buy for an event, following Bevvi\'s rules below. ' +
    'The table is examples, not the full list: for a cocktail not in it, use its standard recipe. ' +
    'No explanation. Reply with ONLY a JSON array of {"name","category"} — category is "spirits" for any spirit or liqueur, "mixer" for ' +
    'juices, sodas, bitters, syrups, garnishes and other non-alcoholic ingredients, "wine" for wine/prosecco/champagne. ' +
    'One entry per ingredient (no duplicates across cocktails), no quantities. If a name is not a cocktail you know, ' +
    'reply {"unknown": ["<name>"]}.\n\n' + rules;
  const body = { model: MODEL, max_tokens: 800, temperature: 0, system, messages: [{ role: 'user', content: 'Cocktails: ' + names.join(', ') }] };
  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    j = await r.json();
    if (!r.ok) return { error: 'API ' + r.status + ': ' + ((j.error && j.error.message) || '').slice(0, 120) };
  } catch (e) { return { error: e.message }; }
  try { require('./ai-spend.js').record('cocktail-expand', MODEL, j.usage, { qa: opts.qa }); } catch (e) { /* ledger best-effort */ }
  const text = ((j.content || []).find(c => c.type === 'text') || {}).text || '';
  let out;
  // The JSON is taken from the reply even when the model adds a sentence around it.
  const ia = text.indexOf('['), io = text.indexOf('{');
  const js = (((io >= 0 && (ia < 0 || io < ia)) ? text.match(/\{[\s\S]*\}/) : text.match(/\[[\s\S]*\]/)) || [''])[0];   // whichever opens first
  try { out = JSON.parse(js); } catch (e) { return { error: 'unparseable: ' + text.slice(0, 120) }; }
  if (out && out.unknown) return { unknown: [].concat(out.unknown).map(String) };
  if (!Array.isArray(out)) return { error: 'not a list: ' + text.slice(0, 120) };
  const seen = new Set();
  const items = out.filter(x => x && x.name && CATS.includes(String(x.category).toLowerCase()))
    .map(x => ({ name: String(x.name).trim(), category: String(x.category).toLowerCase() }))
    .filter(x => { const k = x.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!items.some(x => x.category === 'spirits' || x.category === 'wine')) return { error: 'no spirit in ' + text.slice(0, 120) };
  return { items };
}

module.exports = { expandCocktails, rachelRules };
