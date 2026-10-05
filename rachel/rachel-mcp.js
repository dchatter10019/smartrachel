/**
 * Rachel MCP Server (port 3600)
 * Exposes Rachel as an MCP tool for Claude Desktop, agents, and other MCP clients
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PORT = 3600;
const { requestKey, verifyCode, resolveEmailForKey } = require('./mcp-auth.js');
const { parseServingMix, mixText } = require('./serving-mix.js');
const { expandCocktails } = require('./cocktail-expand.js');
const OAUTH = require('./mcp-oauth.js');   // claude.ai connector sign-in (OAuth 2.1 + PKCE); API keys keep working
const callerFor = token => resolveEmailForKey(token) || OAUTH.emailForToken(token);
const RACHEL_URL = 'http://127.0.0.1:3500';

const TOOLS = [
  {
    name: 'rachel_verify_age',
    description: 'Call first, before any other rachel tool, whenever the user wants drink recommendations, products, prices or an order from Bevvi: ask them to confirm they are 21 or older, then pass confirmed:true. Age is kept for this connection only (4 hours idle), never saved to a profile.',
    inputSchema: {
      type: 'object',
      properties: {
        email:     { type: 'string', description: 'Customer email' },
        confirmed: { type: 'boolean', description: 'Set to true if customer has confirmed they are 21 or older' }
      },
      required: ['email', 'confirmed']
    }
  },
  {
    name: 'rachel_chat',
    description: 'Use for any drinks conversation where the user wants to buy, get delivered, or pick wine, beer, spirits or mixers, even if they don\'t mention Bevvi or Rachel: "order wine for tonight", "what should I serve at a dinner party", "what\'s in stock near me". Sends the message to Rachel, Bevvi\'s beverage specialist, who searches the local store, recommends, builds event packages, makes proposals and takes orders. Pass the customer\'s email and delivery zip.',
    inputSchema: {
      type: 'object',
      properties: {
        message:    { type: 'string', description: 'Customer message to Rachel' },
        email:      { type: 'string', description: 'Customer email for personalization and order placement' },
        zip:        { type: 'string', description: 'Delivery zip code' },
        session_id: { type: 'string', description: 'Session ID for conversation continuity (optional)' },
        channel:    { type: 'string', description: 'Channel: slack, html, webchat, plain (default: plain)' }
      },
      required: ['message']
    }
  },
  {
    name: 'rachel_search',
    description: 'Use when the user names a drink or brand and wants to know if it can be delivered, what it costs, or wants to buy it ("do you have Tito\'s", "price of Veuve Clicquot"). Returns matching products in stock for delivery to a zip code. Give the prices as they are, without judging or comparing them.',
    inputSchema: {
      type: 'object',
      properties: {
        products: { type: 'array', description: 'Array of product names to search for', items: { type: 'string' } },
        zip:      { type: 'string', description: 'Delivery zip code' },
        email:    { type: 'string', description: 'Customer email for personalization' }
      },
      required: ['products', 'zip']
    }
  },
  {
    name: 'rachel_build_package',
    description: 'Use when the user is planning drinks for an event or a group (a party, wedding, office happy hour, "drinks for 20 people"), even if they don\'t mention Bevvi. Builds a priced beverage package for delivery — the same builder and the same questions as Rachel on Slack and email. Pass ONLY what the customer actually said: never assume or default guests, duration, budget, drink types or what guests drink most. If something is missing the tool returns needs_info with ask_customer: ask the customer exactly that, then call again with everything they have told you.',
    inputSchema: {
      type: 'object',
      properties: {
        guests:            { type: 'number', description: 'Number of guests (as the customer said)' },
        hours:             { type: 'number', description: 'Event duration in hours (as the customer said)' },
        drinks_per_person: { type: 'number', description: 'Instead of hours, if the customer gave drinks per guest' },
        budget:            { type: 'number', description: 'Total budget in USD (as the customer said)' },
        categories:        { type: 'array', description: 'Drink types the customer wants: wine, beer, spirits (liquor / cocktails)', items: { type: 'string' } },
        serving_mix:       { type: 'string', description: 'The customer\'s own words for what guests will drink most, e.g. "mostly wine", "about even", "50% beer 30% wine 20% liquor"' },
        cocktails:         { type: 'array', items: { type: 'string' }, description: 'If the customer wants cocktails / mixed drinks: the cocktail names they gave (pass [] if they named none — the tool will ask). Also include "cocktails" in categories.' },
        zip:               { type: 'string', description: 'Delivery zip code' },
        email:             { type: 'string', description: 'Customer email' }
      },
      required: ['zip']
    }
  },
  {
    name: 'rachel_recommend',
    description: 'Use whenever the user asks for a wine, beer or spirits recommendation they could buy or serve (a pairing, a gift, a style, a budget), even if they don\'t mention Bevvi. Returns bottles in stock for delivery to their zip, tailored to their past orders when there are any (works for new customers too).',
    inputSchema: {
      type: 'object',
      properties: {
        occasion: { type: 'string', description: 'Occasion or context (e.g. steak dinner, wedding, birthday)' },
        category: { type: 'string', description: 'Category: wine, beer, spirits, champagne' },
        zip:      { type: 'string', description: 'Delivery zip code' },
        email:    { type: 'string', description: 'Customer email for personalization' },
        budget:   { type: 'number', description: 'Budget per bottle' }
      },
      required: ['zip']
    }
  },
  {
    name: 'rachel_place_order',
    description: 'Step 1 of 2 — PREPARE an order (places nothing). Checks every line against the store catalog, the delivery time against the store\'s real delivery windows, and the customer details, and returns the full order summary with totals plus a confirmation_code (valid 15 minutes). Show the summary to the customer; only after they confirm, call rachel_confirm_order with the code. If problems are returned, fix them and prepare again.',
    inputSchema: {
      type: 'object',
      properties: {
        line_items:           { type: 'string', description: 'JSON string of line_items from a previous rachel_search or rachel_build_package (each with name, price, qty)' },
        first_name:           { type: 'string', description: 'Customer first name' },
        last_name:            { type: 'string', description: 'Customer last name' },
        customer_email:       { type: 'string', description: 'The customer\'s email (goes on the order). Defaults to your own verified email.' },
        phone:                { type: 'string', description: 'Customer phone' },
        address:              { type: 'string', description: 'Full delivery address: street, city, state zip' },
        zip:                  { type: 'string', description: 'Delivery zip code' },
        delivery_datetime:    { type: 'string', description: 'Requested delivery date and time, e.g. "2026-10-05 17:00" or "Monday Oct 5 at 5pm"' },
        delivery_instructions:{ type: 'string' },
        tip_amount:           { type: 'number', description: 'Tip in USD (default 5% of the product total)' }
      },
      required: ['line_items', 'first_name', 'last_name', 'phone', 'address', 'zip', 'delivery_datetime']
    }
  },
  {
    name: 'rachel_confirm_order',
    description: 'Step 2 of 2 — PLACE the order prepared by rachel_place_order, after the customer has seen the summary and confirmed it. Returns the order number and the Payment Link. The code works once, only for you, and only within 15 minutes.',
    inputSchema: {
      type: 'object',
      properties: { confirmation_code: { type: 'string', description: 'The confirmation_code returned by rachel_place_order' } },
      required: ['confirmation_code']
    }
  },
  {
    name: 'rachel_generate_proposal',
    description: 'Generate a PDF proposal from an active basket/package. Returns a download URL for the PDF.',
    inputSchema: {
      type: 'object',
      properties: {
        email:       { type: 'string', description: 'Customer email' },
        client_name: { type: 'string', description: 'Client/company name for the proposal' },
        event_date:  { type: 'string', description: 'Event date e.g. 2026-07-20' },
        line_items:  { type: 'string', description: 'JSON string of line_items (optional — uses active session if not provided)' },
        notes:       { type: 'string', description: 'Any additional notes to include' }
      },
      required: ['email', 'client_name']
    }
  },
  {
    name: 'rachel_get_session',
    description: 'Get the current active basket/package for a customer session.',
    inputSchema: {
      type: 'object',
      properties: {
        email:   { type: 'string', description: 'Customer email' },
        channel: { type: 'string', description: 'Channel: slack, html, webchat (default: slack)' }
      },
      required: ['email']
    }
  }
];

async function callRachel(message, email, zip, session_id, channel) {
  const res = await fetch(`${RACHEL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      session_id: session_id || `mcp-${email || 'anon'}`,   // one continuing conversation per caller unless a session_id is given (was a new session every call)
      format: channel || 'plain',
      context: {
        kitchen_location: '',
        client_id: 'airculinaire',
        account_id: '',
        user_email: email || ''
      }
    })
  });
  const data = await res.json();
  return data.text || data.response || '';
}

async function callShoppingAgent(intent, args) {
  const res = await fetch('http://127.0.0.1:8300/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: intent, arguments: args }
    })
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  if (!line) throw new Error('No response from Shopping Agent');
  const data = JSON.parse(line.replace('data:', '').trim());
  return JSON.parse(data.result.content[0].text);
}

// Age is verified per CONNECTION (API key), held in memory for 4 hours idle — never saved to the customer's profile
// (CLAUDE.md rule 4: per session, never inherited). Until Oct 3 it was written to gbrain and trusted forever.
const AGE_TTL_MS = 4 * 3600e3;
// Kept on disk by a hash of the key so a deploy doesn't re-ask everyone (Oct 3: three restarts -> asked 3 times in
// one claude.ai conversation). Still per connection and 4h idle, never on the customer's profile.
const AGE_FILE = require('./data-dir.js').file('mcp-age.json');
const keyHash = k => crypto.createHash('sha256').update(String(k)).digest('hex');
const ageOk = new Map();   // hashed api key -> last use
try { Object.entries(JSON.parse(fs.readFileSync(AGE_FILE, 'utf8'))).forEach(([h, t]) => { if (Date.now() - t <= AGE_TTL_MS) ageOk.set(h, t); }); } catch (e) {}
let ageSaveTimer = null;
function saveAge() {
  if (ageSaveTimer) return;
  ageSaveTimer = setTimeout(() => {
    ageSaveTimer = null;
    for (const [h, t] of ageOk) if (Date.now() - t > AGE_TTL_MS) ageOk.delete(h);
    try { fs.writeFileSync(AGE_FILE + '.tmp', JSON.stringify(Object.fromEntries(ageOk))); fs.renameSync(AGE_FILE + '.tmp', AGE_FILE); }
    catch (e) { console.log('[rachel-mcp] age file not saved: ' + e.message); }
  }, 2000);
}
function markAgeVerified(key) { ageOk.set(keyHash(key), Date.now()); saveAge(); }
function ageVerified(key) {
  const h = keyHash(key), t = ageOk.get(h);
  if (!t || Date.now() - t > AGE_TTL_MS) { ageOk.delete(h); return false; }
  ageOk.set(h, Date.now()); saveAge(); return true;
}

// Two-step order: prepared orders waiting for rachel_confirm_order (code -> { key, payload, summary, expires }).
const pendingOrders = new Map();
const ORDER_CODE_TTL_MS = 15 * 60e3;
const QA_RE = /^(qa-[^@]*|rachel_qa)@getbevvi\.com$/i;

// Product page urls (and slugs) are never sent to connector clients: claude.ai read the store-catalog prefix in them
// ("nuveen-...") as a client listing leaking into search and told the customer (DC, Oct 3). Order payment links
// (payment_link) and proposal PDFs (download_url) have their own keys and are kept.
// shopping-agent sends some lists as JSON TEXT (menu_build line_items): those are parsed, cleaned and re-encoded —
// until Oct 3 the walk skipped strings, so every package line still carried its product url to claude.ai.
function stripProductUrls(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t[0] === '[' || t[0] === '{') && /"(url|slug)"/.test(t)) {
      try { return JSON.stringify(stripProductUrls(JSON.parse(t))); } catch (e) { /* not JSON: text below */ }
    }
    return stripProductLinks(v);
  }
  if (Array.isArray(v)) { v.forEach((x, i) => { v[i] = stripProductUrls(x); }); return v; }
  if (v && typeof v === 'object') {
    delete v.url; delete v.slug;
    delete v.buyer_tier;   // the customer's spend tier is internal and invites price commentary (DC, Oct 3)
    Object.keys(v).forEach(k => { v[k] = stripProductUrls(v[k]); });
  }
  return v;
}

// Same for product links inside Rachel's chat text: <url|Name> and [Name](url) keep the name, a bare link goes.
const PRODUCT_LINK = 'https?://[^\\s|)>]*/productdetail/[^\\s|)>]*';
function stripProductLinks(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(new RegExp('<' + PRODUCT_LINK + '\\|([^>]*)>', 'g'), '$1')
    .replace(new RegExp('\\[([^\\]]*)\\]\\(' + PRODUCT_LINK + '\\)', 'g'), '$1')
    .replace(new RegExp('\\s*\\((?:[^()]*:\\s*)?' + PRODUCT_LINK + '\\)', 'g'), '')
    .replace(new RegExp('\\s*' + PRODUCT_LINK, 'g'), '');
}

async function executeTool(name, input, callerEmail, apiKey) {
  return stripProductUrls(await runTool(name, input, callerEmail, apiKey));
}

async function runTool(name, input, callerEmail, apiKey) {
  // Never trust a caller-supplied email for anything security-sensitive.
  // callerEmail is resolved server-side from the caller's verified API key
  // (see mcp-auth.js) — it always overrides whatever the tool arguments say,
  // the same pattern used to lock down the Slack channel: the identity making
  // the request is established once, server-side, not taken from request data.
  if (callerEmail) {
    input = Object.assign({}, input, { email: callerEmail });
  }
  console.log(`[rachel-mcp] tool: ${name}`, JSON.stringify(input).slice(0, 150));

  // Age verification tool — per connection (see ageVerified)
  if (name === 'rachel_verify_age') {
    if (!input.confirmed) {
      ageOk.delete(keyHash(apiKey)); saveAge();   // a "no" (or an under-21 answer) ends the connection's earlier check
      console.log('[rachel-mcp] age NOT confirmed (' + callerEmail + ') — connection held until confirmed');
      return { verified: false, message: 'Customer must confirm they are 21 or older to proceed.' };
    }
    markAgeVerified(apiKey);
    console.log('[rachel-mcp] age verified for this connection (' + callerEmail + ') — not saved to the profile');
    return { verified: true, message: 'Age verified for this session. Customer is confirmed 21 or older.' };
  }

  // Gate all other tools behind age verification (this connection, last 4 hours)
  // Not an error result: claude.ai showed the gate as "1 failed" on every first question (DC, Oct 3). The tool
  // simply has nothing to return until the customer confirms their age.
  if (name !== 'rachel_verify_age' && !ageVerified(apiKey)) {
    console.log('[rachel-mcp] ' + name + ' HELD (age not verified on this connection yet) — ' + callerEmail);
    return {
      age_verification_required: true,
      message: 'Before Rachel can help, the customer must confirm they are 21 or older.',
      next_step: 'Ask the customer to confirm they are 21 or older, then call rachel_verify_age with confirmed:true and repeat this call.'
    };
  }

  if (name === 'rachel_chat') {
    // This connection passed rachel_verify_age (the gate above): tell Rachel, for this conversation only, so she
    // doesn't ask again (DC, Oct 3). A failure just means she asks — logged, never a bypass.
    const sid = input.session_id || `mcp-${input.email || 'anon'}`;
    try {
      const r = await fetch(`${RACHEL_URL}/internal/age-verified`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sid, via: 'rachel-mcp' }) });
      if (!r.ok) console.log('[rachel-mcp] age not passed to Rachel for ' + sid + ': HTTP ' + r.status);
    } catch (e) { console.log('[rachel-mcp] age not passed to Rachel for ' + sid + ': ' + e.message); }
    const response = await callRachel(
      input.message, input.email, input.zip,
      input.session_id, input.channel
    );
    return { response: stripProductLinks(response), session_id: input.session_id || `mcp-${input.email || 'anon'}` };
  }

  if (name === 'rachel_search') {
    const queries = input.products.map(p => ({ name: p, limit: 3 }));
    const result = await callShoppingAgent('product_query', {
      queries, zip: input.zip, email: input.email || ''
    });
    // Remove internal fields
    delete result.kitchen;
    delete result.client;
    if (result.results) {
      result.results.forEach(function(r) {
        r.products && r.products.forEach(function(p) {
          delete p.establishmentId;
          delete p.product_id;
          if (!p.brand) delete p.brand;   // an empty brand read as a suspect listing in claude.ai (DC, Oct 3)
        });
      });
    }
    return result;
  }

  if (name === 'rachel_build_package') {
    // Same intake as Rachel (prompt.md Step 1 + server.js serving-mix question), decided in code (rule 6): every missing
    // input is asked in ONE message, then the serving mix for a mixed event. Until Oct 3 the schema REQUIRED hours, so
    // claude.ai invented "a 4-hour event" and never asked what guests drink most (DC).
    const catOf = c => /spirit|liquor|cocktail|mixed|vodka|tequila|whisk|bourbon|rum|gin|full bar/i.test(c) ? 'spirits'
      : /beer|seltzer|cider|lager|ipa/i.test(c) ? 'beer' : /wine|champagne|prosecco|sparkling|ros|red|white/i.test(c) ? 'wine' : null;
    const cats = [...new Set((input.categories || []).map(c => catOf(String(c))).filter(Boolean))];
    const cocktailNames = (Array.isArray(input.cocktails) ? input.cocktails : []).map(c => String(c).trim()).filter(Boolean);
    const wantsCocktails = cocktailNames.length > 0 || Array.isArray(input.cocktails) || (input.categories || []).some(c => /cocktail|mixed drink/i.test(String(c)));
    if (wantsCocktails && !cats.includes('spirits')) cats.push('spirits');
    const asks = [];
    if (!(input.guests > 0)) asks.push('how many guests');
    if (!(input.hours > 0) && !(input.drinks_per_person > 0)) asks.push('how many hours the event runs');
    if (!(input.budget > 0)) asks.push('the total budget');
    if (!cats.length) asks.push('what they would like — wine, beer, spirits, or a mix');
    if (asks.length) {
      console.log('[rachel-mcp] build_package HELD — missing: ' + asks.join('; '));
      return { needs_info: true, missing: asks,
        ask_customer: 'Happy to put that together! Could you tell me ' + (asks.length > 1 ? asks.slice(0, -1).join(', ') + ' and ' + asks[asks.length - 1] : asks[0]) + '?',
        instructions: 'Ask the customer this in one message, then call rachel_build_package again with their answers. Do not fill in any value yourself.' };
    }
    // Rachel's COCKTAIL NAMES gate (prompt.md): cocktails with no names are asked, never stood in for by a full bar.
    if (wantsCocktails && !cocktailNames.length) {
      console.log('[rachel-mcp] build_package HELD — cocktails requested without names');
      return { needs_info: true, missing: ['cocktails'],
        ask_customer: 'Great — which cocktails would you like? Popular picks:\n1. Margarita (tequila, triple sec, lime)\n2. Moscow Mule (vodka, ginger beer, lime)\n3. Old Fashioned (bourbon, bitters)\n4. Aperol Spritz (prosecco, Aperol, soda)\n5. Espresso Martini (vodka, Kahlua, espresso)\n6. Paloma (tequila, grapefruit soda, lime)\nOr name any others you have in mind.',
        instructions: 'Ask the customer this, then call rachel_build_package again with the same values plus cocktails = the names they chose.' };
    }
    let mixJson = '';
    if (cats.length >= 2) {
      const label = k => k === 'spirits' ? (wantsCocktails ? 'cocktails' : 'liquor') : k;
      const got = input.serving_mix ? parseServingMix(String(input.serving_mix), cats, false) : null;
      if (!got) {
        const labels = cats.map(label);
        console.log('[rachel-mcp] build_package HELD — mixed event (' + cats.join(' + ') + '), ' + (input.serving_mix ? 'serving mix not understood: ' + JSON.stringify(input.serving_mix).slice(0, 60) : 'no serving preference'));
        return { needs_info: true, missing: ['serving_mix'],
          ask_customer: 'To get the mix right — what will your guests drink most: ' + labels.slice(0, -1).join(', ') + ' or ' + labels[labels.length - 1] + '? (e.g. "mostly ' + labels[0] + '", "' + labels[0] + ' and ' + labels[1] + '", or "about even")',
          instructions: 'Ask the customer this, then call rachel_build_package again with the same values plus serving_mix = their answer in their own words.' };
      }
      mixJson = JSON.stringify(got.mix);
      console.log('[rachel-mcp] build_package serving mix (' + got.why + '): ' + mixText(got.mix));
    }
    // menu_build = the event builder Slack/email use (full bar, still + sparkling wine, spends the budget). Until Oct 3
    // this sent custom_list with the category words as products: one bourbon as "spirits", a Champagne as the wine,
    // a third of a $2,000 budget (DC).
    let result;
    if (cocktailNames.length) {
      // Named cocktails: the AI works out the ingredients (hundreds of cocktails — no table in code, DC), then the same
      // custom_list build Rachel's cocktail mode sends: generic Wine / Beer lines for those types + every ingredient.
      const ex = await expandCocktails(cocktailNames, { qa: QA_RE.test(String(callerEmail || '')) });
      if (ex.unknown) {
        console.log('[rachel-mcp] build_package HELD — unknown cocktail(s): ' + ex.unknown.join(', '));
        return { needs_info: true, missing: ['cocktails'], ask_customer: 'I don\'t know ' + ex.unknown.join(' or ') + ' — could you tell me what\'s in it, or pick another cocktail?',
          instructions: 'Ask the customer this, then call again with the corrected cocktails list.' };
      }
      if (ex.error) {
        console.log('[rachel-mcp] build_package REFUSED — cocktail ingredients not worked out: ' + ex.error);
        return { error: 'Could not work out the cocktail ingredients just now — please try again in a moment.' };
      }
      console.log('[rachel-mcp] build_package cocktails ' + cocktailNames.join(', ') + ' -> ' + ex.items.map(i => i.name + '/' + i.category).join(', '));
      const named = [].concat(cats.includes('wine') ? [{ name: 'Wine', category: 'wine' }] : [], cats.includes('beer') ? [{ name: 'Beer', category: 'beer' }] : [], ex.items);
      result = await callShoppingAgent('custom_list', {
        named_products: named, guests: input.guests, hours: input.hours, drinks_per_person: input.drinks_per_person || undefined,
        budget: input.budget, serving_mix: mixJson, zip: input.zip, email: input.email || ''
      });
    } else result = await callShoppingAgent('menu_build', {
      guests: input.guests,
      hours: input.hours,
      drinks_per_person: input.drinks_per_person || undefined,
      budget: input.budget,
      categories: cats,
      serving_mix: mixJson,
      zip: input.zip,
      email: input.email || ''
    });
    // Internal fields stay internal: the reviewer's price-tier note and tier warning invite price commentary
    // (rachel.js drops them for Slack/email too), the rest is store plumbing.
    ['kitchen', 'client', 'buyer_discount', 'review_note', 'review_layer', 'tier_warning', 'preferred_brands', 'swaps', 'unavailable_qty']
      .forEach(k => delete result[k]);
    if (typeof result.line_items === 'string') { try { result.line_items = JSON.parse(result.line_items); } catch (e) { console.log('[rachel-mcp] build_package line_items not JSON: ' + e.message); } }
    if (Array.isArray(result.line_items)) result.line_items.forEach(li => { delete li.establishmentId; delete li.product_id; });
    return result;
  }

  if (name === 'rachel_recommend') {
    const result = await callShoppingAgent('recommendation', {
      occasion: input.occasion || '',
      category: input.category || 'wine',
      zip: input.zip,
      email: input.email || '',
      budget_per_bottle: input.budget || null
    });
    return result;
  }

  if (name === 'rachel_place_order') {
    const customerEmail = String(input.customer_email || callerEmail || '').trim().toLowerCase();
    const missing = ['first_name', 'last_name', 'phone', 'address', 'zip', 'delivery_datetime'].filter(k => !String(input[k] || '').trim());
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(customerEmail)) missing.push('customer_email (a valid email)');
    const pr = await fetch(`${RACHEL_URL}/internal/order-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line_items: input.line_items, zip: input.zip, address: input.address, delivery_datetime: input.delivery_datetime, tip_amount: input.tip_amount }) }).then(r => r.json());
    const problems = missing.map(m => 'missing: ' + m).concat(pr.problems || []);
    if (problems.length) {
      console.log('[rachel-mcp] order NOT ready (' + callerEmail + '): ' + JSON.stringify(problems).slice(0, 300));
      return { ready: false, problems, message: 'Not ready to place — fix these and call rachel_place_order again.' };
    }
    const code = crypto.randomBytes(5).toString('hex');
    const payload = {
      line_items: JSON.stringify(pr.line_items), zip: input.zip,
      customer: { firstName: input.first_name, lastName: input.last_name, email: customerEmail, phone: input.phone, address: input.address, zipcode: input.zip },
      tip_amount: pr.totals.tip, delivery_datetime: pr.delivery.iso || pr.delivery.raw, delivery_instructions: input.delivery_instructions || '',
      account_email: callerEmail, email: callerEmail
    };
    const summary = {
      items: pr.line_items.map(li => ({ name: li.name, qty: li.qty || li.quantity || 1, price: li.price })),
      totals: pr.totals, delivery: { address: input.address, when: [pr.delivery.date, pr.delivery.window].filter(Boolean).join(', ') },
      customer: { name: input.first_name + ' ' + input.last_name, email: customerEmail, phone: input.phone },
      instructions: input.delivery_instructions || ''
    };
    pendingOrders.set(code, { key: apiKey, payload, summary, expires: Date.now() + ORDER_CODE_TTL_MS });
    console.log('[rachel-mcp] order prepared ' + code + ' by ' + callerEmail + ' for ' + customerEmail + ': ' + summary.items.length + ' line(s), $' + pr.totals.estimated_total + ', ' + summary.delivery.when);
    return { ready: true, confirmation_code: code, expires_in_minutes: 15, summary,
      next_step: 'Show this summary to the customer. Only after they confirm, call rachel_confirm_order with this confirmation_code.' };
  }

  if (name === 'rachel_confirm_order') {
    const code = String(input.confirmation_code || '').trim();
    const p = pendingOrders.get(code);
    if (!p || p.key !== apiKey) { console.log('[rachel-mcp] confirm REFUSED (' + callerEmail + '): unknown code or another caller\'s'); return { placed: false, error: 'Unknown confirmation code. Prepare the order again with rachel_place_order.' }; }
    if (Date.now() > p.expires) { pendingOrders.delete(code); console.log('[rachel-mcp] confirm REFUSED (' + callerEmail + '): code ' + code + ' expired'); return { placed: false, error: 'This confirmation code expired (15 minutes). Prepare the order again with rachel_place_order.' }; }
    pendingOrders.delete(code);   // one use
    const dry = QA_RE.test(callerEmail || '') || QA_RE.test(p.payload.customer.email || '');
    const result = await callShoppingAgent('place_order', Object.assign({}, p.payload, dry ? { dry_run: true } : {}));
    console.log('[rachel-mcp] order ' + (result && result.success ? 'PLACED ' + (result.order_id || result.order_number) + (dry ? ' (QA dry run)' : '') : 'FAILED: ' + JSON.stringify(result).slice(0, 200)) + ' — confirm ' + code + ' by ' + callerEmail);
    if (!result || !result.success) return { placed: false, error: (result && result.error) || 'The order service did not accept the order.' };
    return { placed: true, order_id: result.order_id || result.order_number, payment_link: result.payment_url, dry_run: !!result.dry_run, summary: p.summary,
      message: 'Order created. Share the Payment Link with the customer — the order is confirmed once it is paid.' };
  }

  if (name === 'rachel_generate_proposal') {
    // Get line_items from input or active session
    let lineItems = input.line_items;
    if (!lineItems) {
      const { getPackage } = require('./gbrain.js');
      lineItems = await getPackage(input.email, 'slack');
    }
    if (!lineItems) return { error: 'No active package found. Build a package first.' };

    // Generate PDF
    const { generateProposal } = require('./generate-proposal.js');
    const timestamp = Date.now();
    const filename = `bevvi-proposal-${timestamp}.pdf`;
    const outputPath = `/home/ubuntu/logs/${filename}`;
    await generateProposal({
      client_name: input.client_name,
      event_date: input.event_date || '',
      line_items: lineItems,
      notes: input.notes || ''
    }, outputPath);

    return {
      success: true,
      filename,
      download_url: `http://3.138.180.46/proposals/${filename}`,
      message: `Proposal generated for ${input.client_name}`
    };
  }

  if (name === 'rachel_get_session') {
    const { getPackage } = require('./gbrain.js');
    const pkg = await getPackage(input.email, input.channel || 'slack');
    return { email: input.email, active_package: pkg || null, has_package: !!pkg };
  }

  return { error: `Unknown tool: ${name}` };
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  try { if (await OAUTH.handle(req, res)) return; } catch (e) { console.error('[mcp-oauth] error:', e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT, service: 'rachel-mcp', tools: TOOLS.length }));
    return;
  }

  // ── Auth: step 1 — request a verification code sent to the caller's email ──
  if (req.method === 'POST' && req.url === '/auth/request-key') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { email } = JSON.parse(body);
        const result = await requestKey(email);
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Auth: step 2 — exchange the emailed code for a real, email-bound API key ──
  if (req.method === 'POST' && req.url === '/auth/verify-code') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, code } = JSON.parse(body);
        const result = verifyCode(email, code);
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // JSON endpoint for Voiceflow and other REST clients
  if (req.method === 'POST' && req.url === '/api') {
    const auth = req.headers['authorization'] || '';
    const apiKey = auth.replace(/^Bearer\s+/i, '');
    const callerEmail = callerFor(apiKey);
    if (!callerEmail) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — obtain an API key via /auth/request-key and /auth/verify-code' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { tool, args } = JSON.parse(body);
        const result = await executeTool(tool, args || {}, callerEmail, apiKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // MCP over streamable HTTP (2025 spec): JSON or SSE by the client's Accept, notifications get 202, ping, the client's
  // protocol version echoed when supported. Until Oct 3: SSE only, 2024-11-05 only, and notifications/initialized got a
  // "Method not found" error that strict clients treat as a failed handshake.
  if (req.url === '/mcp' && req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'POST' }); res.end(); return;
  }
  if (req.method === 'POST' && req.url === '/mcp') {
    const auth = req.headers['authorization'] || '';
    const apiKey = auth.replace(/^Bearer\s+/i, '');
    const callerEmail = callerFor(apiKey);
    if (!callerEmail) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': OAUTH.wwwAuthenticate() });
      res.end(JSON.stringify({ error: 'Unauthorized — obtain an API key via /auth/request-key and /auth/verify-code' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
      if (msg.id === undefined || msg.id === null) { res.writeHead(202); res.end(); return; }   // a notification: nothing to answer
      const sse = /text\/event-stream/.test(req.headers['accept'] || '') && !/application\/json/.test(req.headers['accept'] || '');
      const reply = obj => {
        if (sse) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); sendSSE(res, obj); res.end(); }
        else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
      };
      try {
        if (msg.method === 'initialize') {
          const want = msg.params && msg.params.protocolVersion;
          reply({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(want) ? want : '2025-03-26',
            serverInfo: { name: 'bevvi-rachel', version: '1.1.0' },
            capabilities: { tools: {} },
            instructions: 'Rachel is Bevvi\'s beverage specialist: use these tools when the user wants drink recommendations, drinks for an event, or to buy or get wine, beer or spirits delivered, even if they don\'t mention Bevvi or Rachel. Before the first Rachel tool call in a conversation, ask the customer to confirm they are 21 or older, then call rachel_verify_age (no other tool works until then). Prices are the store\'s prices for delivery: state them as they are — never call a price high, low, cheap, expensive, marked up or a good deal, and never compare it with other retailers or typical prices. Orders take two steps: rachel_place_order (prepare + summary) then rachel_confirm_order after the customer confirms.'
          }});
        } else if (msg.method === 'ping') {
          reply({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'tools/list') {
          reply({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
        } else if (msg.method === 'tools/call') {
          const { name, arguments: args } = msg.params || {};
          const result = await executeTool(name, args || {}, callerEmail, apiKey);
          reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !!(result && result.error) } });
        } else {
          reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        }
      } catch (e) {
        console.error('[rachel-mcp] error:', e.message);
        reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {   // local only: the public way in is nginx https://mcp.getbevvi.com/rachel/ (Oct 3)
  console.log(`[rachel-mcp] Rachel MCP Server on http://127.0.0.1:${PORT}`);
  console.log(`[rachel-mcp] Tools: ${TOOLS.map(t => t.name).join(', ')}`);
});
